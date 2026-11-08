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

async function prepareSale(db, service) {
  const supplier = await service.createParty({ code: "SUP-1", name: "المورد", type: "supplier" });
  const customer = await service.createParty({ code: "CUS-1", name: "العميل", type: "customer" });
  const warehouse = await service.createWarehouse({ code: "WH-1", name: "المستودع" });
  const product = await service.createProduct({ sku: "P-1", name: "منتج", purchaseCost: 5, salePrice: 10, taxRate: 15 });
  await service.createPurchaseInvoice({
    number: "PUR-1", date: "2026-11-01", partyId: Number(supplier.lastInsertRowid),
    warehouseId: Number(warehouse.lastInsertRowid), currency: "YER",
    lines: [{ productId: Number(product.lastInsertRowid), quantity: 10, unitCost: 5, taxRate: 15 }]
  });
  await service.createSalesInvoice({
    number: "SAL-1", date: "2026-11-02", partyId: Number(customer.lastInsertRowid),
    warehouseId: Number(warehouse.lastInsertRowid), currency: "YER",
    lines: [{ productId: Number(product.lastInsertRowid), quantity: 4, unitPrice: 10, taxRate: 15 }]
  });
  return { supplierId: Number(supplier.lastInsertRowid), customerId: Number(customer.lastInsertRowid), warehouseId: Number(warehouse.lastInsertRowid), productId: Number(product.lastInsertRowid) };
}

test("sales return reverses revenue, tax and cost and restores stock", async () => {
  const { db, service } = setup();
  const refs = await prepareSale(db, service);
  const result = await service.createSalesReturn({
    number: "SR-1", originalInvoice: "SAL-1", date: "2026-11-08",
    lines: [{ productId: refs.productId, quantity: 1 }]
  });
  assert.equal(result.total, 11.5);
  assert.equal(result.costReversed, 5);
  const stock = await service.stockBalance(refs.productId, refs.warehouseId);
  assert.equal(stock.quantity, 7);
  const totals = db.prepare("SELECT SUM(debit) AS debit,SUM(credit) AS credit FROM journal_lines").get();
  assert.equal(totals.debit, totals.credit);
  assert.equal(db.prepare("SELECT status FROM sales_returns WHERE return_no='SR-1'").get().status, "posted");
  db.close();
});

test("sales return cannot exceed the unreturned original invoice quantity", async () => {
  const { db, service } = setup();
  const refs = await prepareSale(db, service);
  await service.createSalesReturn({ number: "SR-1", originalInvoice: "SAL-1", date: "2026-11-08", lines: [{ productId: refs.productId, quantity: 3 }] });
  await assert.rejects(() => service.createSalesReturn({ number: "SR-2", originalInvoice: "SAL-1", date: "2026-11-08", lines: [{ productId: refs.productId, quantity: 2 }] }), /الكمية المتبقية/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sales_returns").get().n, 1);
  db.close();
});

test("purchase return reduces stock and reverses supplier liability", async () => {
  const { db, service } = setup();
  const supplier = await service.createParty({ code: "SUP-1", name: "المورد", type: "supplier" });
  const warehouse = await service.createWarehouse({ code: "WH-1", name: "المستودع" });
  const product = await service.createProduct({ sku: "P-1", name: "منتج", purchaseCost: 5, salePrice: 10, taxRate: 15 });
  await service.createPurchaseInvoice({
    number: "PUR-1", date: "2026-11-01", partyId: Number(supplier.lastInsertRowid),
    warehouseId: Number(warehouse.lastInsertRowid), currency: "YER",
    lines: [{ productId: Number(product.lastInsertRowid), quantity: 10, unitCost: 5, taxRate: 15 }]
  });
  const result = await service.createPurchaseReturn({
    number: "PR-1", originalInvoice: "PUR-1", date: "2026-11-08",
    lines: [{ productId: Number(product.lastInsertRowid), quantity: 2 }]
  });
  assert.equal(result.total, 11.5);
  const stock = await service.stockBalance(Number(product.lastInsertRowid), Number(warehouse.lastInsertRowid));
  assert.equal(stock.quantity, 8);
  const totals = db.prepare("SELECT SUM(debit) AS debit,SUM(credit) AS credit FROM journal_lines").get();
  assert.equal(totals.debit, totals.credit);
  assert.equal(db.prepare("SELECT status FROM purchase_returns WHERE return_no='PR-1'").get().status, "posted");
  db.close();
});

test("purchase return rejects quantities no longer available in the warehouse", async () => {
  const { db, service } = setup();
  const refs = await prepareSale(db, service);
  await assert.rejects(() => service.createPurchaseReturn({
    number: "PR-1", originalInvoice: "PUR-1", date: "2026-11-08",
    lines: [{ productId: refs.productId, quantity: 7 }]
  }), /كمية كافية/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM purchase_returns").get().n, 0);
  db.close();
});