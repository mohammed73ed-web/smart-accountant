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

test("sales and purchase journals preserve party balances and receipts/payments settle them", async () => {
  const { db, service } = setup();
  const supplier = await service.createParty({ code: "SUP-BAL", name: "مورد الذمم", type: "supplier" });
  const customer = await service.createParty({ code: "CUS-BAL", name: "عميل الذمم", type: "customer" });
  const supplierId = Number(supplier.lastInsertRowid);
  const customerId = Number(customer.lastInsertRowid);
  const warehouse = await service.createWarehouse({ code: "WH-BAL", name: "مستودع الذمم" });
  const product = await service.createProduct({ sku: "P-BAL", name: "صنف الذمم", purchaseCost: 5, salePrice: 10, taxRate: 0 });
  await service.createPurchaseInvoice({
    number: "PUR-BAL", date: "2026-11-08", partyId: supplierId,
    warehouseId: Number(warehouse.lastInsertRowid), currency: "YER",
    lines: [{ productId: Number(product.lastInsertRowid), quantity: 10, unitCost: 5, taxRate: 0 }]
  });
  await service.createSalesInvoice({
    number: "SAL-BAL", date: "2026-11-08", partyId: customerId,
    warehouseId: Number(warehouse.lastInsertRowid), currency: "YER",
    lines: [{ productId: Number(product.lastInsertRowid), quantity: 2, unitPrice: 10, taxRate: 0 }]
  });

  const payableParty = db.prepare("SELECT party_id FROM journal_lines WHERE journal_id=(SELECT id FROM journal_entries WHERE entry_no='JV-PI-PUR-BAL') AND account_id=(SELECT id FROM accounts WHERE code='2100')").get();
  const receivableParty = db.prepare("SELECT party_id FROM journal_lines WHERE journal_id=(SELECT id FROM journal_entries WHERE entry_no='JV-SI-SAL-BAL') AND account_id=(SELECT id FROM accounts WHERE code='1200')").get();
  assert.equal(payableParty.party_id, supplierId);
  assert.equal(receivableParty.party_id, customerId);

  db.prepare("INSERT INTO cash_boxes(code,name_ar,currency_code,account_id) VALUES('CASH-BAL','صندوق الذمم','YER',(SELECT id FROM accounts WHERE code='1100'))").run();
  const cashBoxId = db.prepare("SELECT id FROM cash_boxes WHERE code='CASH-BAL'").get().id;
  await service.postPartySettlement({
    number: "RC-BAL", date: "2026-11-08", type: "receipt", partyId: customerId,
    cashBoxId, currency: "YER", amount: 8, memo: "تحصيل جزئي"
  });
  await service.postPartySettlement({
    number: "SP-BAL", date: "2026-11-08", type: "payment", partyId: supplierId,
    cashBoxId, currency: "YER", amount: 12, memo: "سداد جزئي"
  });

  const receiptLine = db.prepare("SELECT party_id,debit,credit FROM journal_lines WHERE journal_id=(SELECT id FROM journal_entries WHERE entry_no='JV-RC-RC-BAL') AND account_id=(SELECT id FROM accounts WHERE code='1200')").get();
  const paymentLine = db.prepare("SELECT party_id,debit,credit FROM journal_lines WHERE journal_id=(SELECT id FROM journal_entries WHERE entry_no='JV-SP-SP-BAL') AND account_id=(SELECT id FROM accounts WHERE code='2100')").get();
  assert.deepEqual(receiptLine, { party_id: customerId, debit: 0, credit: 8 });
  assert.deepEqual(paymentLine, { party_id: supplierId, debit: 12, credit: 0 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cash_transactions").get().n, 2);
  const totals = db.prepare("SELECT SUM(debit) AS debit,SUM(credit) AS credit FROM journal_lines").get();
  assert.equal(totals.debit, totals.credit);
  db.close();
});

test("party settlement rejects a wrong party type and a mismatched cash currency", async () => {
  const { db, service } = setup();
  const supplier = await service.createParty({ code: "SUP-ERR", name: "مورد", type: "supplier" });
  db.prepare("INSERT INTO cash_boxes(code,name_ar,currency_code,account_id) VALUES('CASH-YER','صندوق يمني','YER',(SELECT id FROM accounts WHERE code='1100'))").run();
  const cashBoxId = db.prepare("SELECT id FROM cash_boxes WHERE code='CASH-YER'").get().id;
  await assert.rejects(() => service.postPartySettlement({
    number: "RC-ERR", date: "2026-11-08", type: "receipt", partyId: Number(supplier.lastInsertRowid),
    cashBoxId, currency: "YER", amount: 5
  }), /سند القبض يتطلب عميلاً/);
  const customer = await service.createParty({ code: "CUS-ERR", name: "عميل", type: "customer" });
  await assert.rejects(() => service.postPartySettlement({
    number: "RC-ERR2", date: "2026-11-08", type: "receipt", partyId: Number(customer.lastInsertRowid),
    cashBoxId, currency: "USD", amount: 5
  }), /عملة الصندوق أو البنك/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cash_transactions").get().n, 0);
  db.close();
});


test("multi-line purchase and sales invoices post all items and balanced journals", async () => {
  const { db, service } = setup();
  const supplier = await service.createParty({ code: "SUP-MULTI", name: "مورد متعدد الأصناف", type: "supplier" });
  const customer = await service.createParty({ code: "CUS-MULTI", name: "عميل متعدد الأصناف", type: "customer" });
  const warehouse = await service.createWarehouse({ code: "WH-MULTI", name: "مستودع متعدد الأصناف" });
  const first = await service.createProduct({ sku: "P-MULTI-1", name: "الصنف الأول", purchaseCost: 4, salePrice: 8, taxRate: 5 });
  const second = await service.createProduct({ sku: "P-MULTI-2", name: "الصنف الثاني", purchaseCost: 3, salePrice: 6, taxRate: 10 });
  const supplierId = Number(supplier.lastInsertRowid);
  const customerId = Number(customer.lastInsertRowid);
  const warehouseId = Number(warehouse.lastInsertRowid);
  const firstId = Number(first.lastInsertRowid);
  const secondId = Number(second.lastInsertRowid);

  await service.createPurchaseInvoice({
    number: "PUR-MULTI", date: "2026-11-08", partyId: supplierId, warehouseId, currency: "YER",
    lines: [
      { productId: firstId, quantity: 10, unitCost: 4, taxRate: 0 },
      { productId: secondId, quantity: 5, unitCost: 3, taxRate: 0 }
    ]
  });
  const sale = await service.createSalesInvoice({
    number: "SAL-MULTI", date: "2026-11-08", partyId: customerId, warehouseId, currency: "YER",
    lines: [
      { productId: firstId, quantity: 2, unitPrice: 8, taxRate: 5 },
      { productId: secondId, quantity: 1, unitPrice: 6, taxRate: 10 }
    ]
  });

  assert.equal(sale.subtotal, 22);
  assert.equal(sale.tax, 1.4);
  assert.equal(sale.total, 23.4);
  assert.equal(sale.costOfGoods, 11);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM purchase_invoice_lines").get().n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sales_invoice_lines").get().n, 2);
  assert.equal((await service.stockBalance(firstId, warehouseId)).quantity, 8);
  assert.equal((await service.stockBalance(secondId, warehouseId)).quantity, 4);
  const totals = db.prepare("SELECT SUM(debit) AS debit,SUM(credit) AS credit FROM journal_lines").get();
  assert.equal(totals.debit, totals.credit);
  db.close();
});


test("debt installments are validated and allocated FIFO by matching party and currency", async () => {
  const { db, service } = setup();
  const customer = await service.createParty({ code: "CUS-INST", name: "عميل أقساط", type: "customer" });
  const supplier = await service.createParty({ code: "SUP-INST", name: "مورد أقساط", type: "supplier" });
  const customerId = Number(customer.lastInsertRowid);
  const supplierId = Number(supplier.lastInsertRowid);
  db.prepare("INSERT INTO cash_boxes(code,name_ar,currency_code,account_id) VALUES('CASH-INST','صندوق الأقساط','YER',(SELECT id FROM accounts WHERE code='1100'))").run();
  const cashBoxId = db.prepare("SELECT id FROM cash_boxes WHERE code='CASH-INST'").get().id;

  const first = await service.createDebtInstallment({ partyId: customerId, sourceType: "receivable", dueDate: "2026-11-10", amount: 10, currency: "YER" });
  const second = await service.createDebtInstallment({ partyId: customerId, sourceType: "receivable", dueDate: "2026-11-20", amount: 20, currency: "YER" });
  const supplierInstallment = await service.createDebtInstallment({ partyId: supplierId, sourceType: "payable", dueDate: "2026-11-15", amount: 15, currency: "YER" });
  await assert.rejects(() => service.createDebtInstallment({ partyId: customerId, sourceType: "receivable", dueDate: "2026-02-31", amount: 5, currency: "YER" }), /تاريخ استحقاق القسط غير صالح/);

  await service.postPartySettlement({
    number: "RC-INST", date: "2026-11-08", type: "receipt", partyId: customerId,
    cashBoxId, currency: "YER", amount: 15
  });
  await service.postPartySettlement({
    number: "SP-INST", date: "2026-11-08", type: "payment", partyId: supplierId,
    cashBoxId, currency: "YER", amount: 20
  });

  const paid = db.prepare("SELECT id,paid_amount FROM debt_installments ORDER BY due_date,id").all();
  assert.deepEqual(paid, [
    { id: Number(first.lastInsertRowid), paid_amount: 10 },
    { id: Number(supplierInstallment.lastInsertRowid), paid_amount: 15 },
    { id: Number(second.lastInsertRowid), paid_amount: 5 }
  ]);
  assert.equal(db.prepare("SELECT SUM(amount-paid_amount) AS remaining FROM debt_installments WHERE party_id=?").get(customerId).remaining, 15);
  db.close();
});
