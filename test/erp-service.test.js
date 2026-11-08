import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ErpService } from "../src/core/erp-service.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const schema = readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8");

function setup() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(schema);
  const adapter = {
    query: async (sql, params = []) => db.prepare(sql).all(...params),
    run: async (sql, params = []) => db.prepare(sql).run(...params),
    transaction: async (statements) => db.transaction((items) =>
      items.map((item) => db.prepare(item.sql).run(...(item.params || [])))
    )(statements)
  };
  return { db, service: new ErpService(adapter) };
}

test("purchase invoice posts balanced journal and receives stock", async () => {
  const { db, service } = setup();
  const supplier = await service.createParty({ code: "SUP-1", name: "المورد الأول", type: "supplier" });
  const warehouse = await service.createWarehouse({ code: "WH-1", name: "المستودع الرئيسي" });
  const product = await service.createProduct({ sku: "P-1", name: "منتج", purchaseCost: 5, salePrice: 10, taxRate: 15 });
  const result = await service.createPurchaseInvoice({
    number: "PUR-1", date: "2026-11-08", partyId: Number(supplier.lastInsertRowid),
    warehouseId: Number(warehouse.lastInsertRowid), currency: "YER",
    lines: [{ productId: Number(product.lastInsertRowid), quantity: 10, unitCost: 5, taxRate: 15 }]
  });
  assert.equal(result.total, 57.5);
  const stock = await service.stockBalance(Number(product.lastInsertRowid), Number(warehouse.lastInsertRowid));
  assert.deepEqual(stock, { quantity: 10, value: 50, averageCost: 5 });
  const totals = db.prepare("SELECT SUM(debit) AS debit,SUM(credit) AS credit FROM journal_lines").get();
  assert.equal(totals.debit, 57.5);
  assert.equal(totals.credit, 57.5);
  assert.equal(db.prepare("SELECT status FROM purchase_invoices WHERE invoice_no='PUR-1'").get().status, "posted");
  db.close();
});

test("sales invoice posts revenue, tax, cost and reduces stock atomically", async () => {
  const { db, service } = setup();
  const supplier = await service.createParty({ code: "SUP-1", name: "المورد", type: "supplier" });
  const customer = await service.createParty({ code: "CUS-1", name: "العميل", type: "customer" });
  const warehouse = await service.createWarehouse({ code: "WH-1", name: "المستودع" });
  const product = await service.createProduct({ sku: "P-1", name: "منتج", purchaseCost: 5, salePrice: 10, taxRate: 15 });
  await service.createPurchaseInvoice({
    number: "PUR-1", date: "2026-11-01", partyId: Number(supplier.lastInsertRowid),
    warehouseId: Number(warehouse.lastInsertRowid), currency: "YER",
    lines: [{ productId: Number(product.lastInsertRowid), quantity: 10, unitCost: 5, taxRate: 0 }]
  });
  const sale = await service.createSalesInvoice({
    number: "SAL-1", date: "2026-11-08", partyId: Number(customer.lastInsertRowid),
    warehouseId: Number(warehouse.lastInsertRowid), currency: "YER",
    lines: [{ productId: Number(product.lastInsertRowid), quantity: 2, unitPrice: 10, taxRate: 15 }]
  });
  assert.equal(sale.total, 23);
  assert.equal(sale.costOfGoods, 10);
  const stock = await service.stockBalance(Number(product.lastInsertRowid), Number(warehouse.lastInsertRowid));
  assert.deepEqual(stock, { quantity: 8, value: 40, averageCost: 5 });
  const totals = db.prepare("SELECT SUM(debit) AS debit,SUM(credit) AS credit FROM journal_lines").get();
  assert.equal(totals.debit, totals.credit);
  assert.equal(db.prepare("SELECT status FROM sales_invoices WHERE invoice_no='SAL-1'").get().status, "posted");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE status='posted'").get().n, 2);
  db.close();
});

test("sale exceeding available stock is rejected without creating invoice or journal", async () => {
  const { db, service } = setup();
  const customer = await service.createParty({ code: "CUS-1", name: "عميل", type: "customer" });
  const warehouse = await service.createWarehouse({ code: "WH-1", name: "مستودع" });
  const product = await service.createProduct({ sku: "P-1", name: "منتج", salePrice: 10 });
  await assert.rejects(() => service.createSalesInvoice({
    number: "SAL-FAIL", date: "2026-11-08", partyId: Number(customer.lastInsertRowid),
    warehouseId: Number(warehouse.lastInsertRowid), currency: "YER",
    lines: [{ productId: Number(product.lastInsertRowid), quantity: 1, unitPrice: 10 }]
  }), /المخزون غير كافٍ/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sales_invoices").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM journal_entries").get().n, 0);
  db.close();
});

test("expense and revenue vouchers create matching journal entries", async () => {
  const { db, service } = setup();
  await service.postExpense({ number: "EX-1", date: "2026-11-08", amount: 25, currency: "YER", memo: "إيجار" });
  await service.postRevenue({ number: "RV-1", date: "2026-11-08", amount: 40, currency: "YER", memo: "دخل آخر" });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM expenses").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM revenues").get().n, 1);
  const totals = db.prepare("SELECT SUM(debit) AS debit,SUM(credit) AS credit FROM journal_lines").get();
  assert.equal(totals.debit, 65);
  assert.equal(totals.credit, 65);
  db.close();
});

test("straight-line depreciation posts once per asset and period", async () => {
  const { db, service } = setup();
  db.prepare("INSERT INTO fixed_assets(asset_code,name_ar,acquisition_date,cost,residual_value,useful_life_months,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id) VALUES('FA-1','حاسوب','2026-01-01',1200,0,12,(SELECT id FROM accounts WHERE code='1400'),(SELECT id FROM accounts WHERE code='1490'),(SELECT id FROM accounts WHERE code='5300'))").run();
  const assetId = db.prepare("SELECT id FROM fixed_assets WHERE asset_code='FA-1'").get().id;
  const result = await service.runDepreciation(assetId, "2026-11");
  assert.equal(result.amount, 100);
  await assert.rejects(() => service.runDepreciation(assetId, "2026-11"), /مسبقاً/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM depreciation_runs").get().n, 1);
  const totals = db.prepare("SELECT SUM(debit) AS debit,SUM(credit) AS credit FROM journal_lines").get();
  assert.equal(totals.debit, 100);
  assert.equal(totals.credit, 100);
  db.close();
});