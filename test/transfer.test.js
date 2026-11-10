import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  TRANSFER_TABLES, buildPortableImportStatements, createPortableTransferPackage,
  parsePortableTransferPackage, validatePortableAccountingData
} from "../src/core/transfer.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const schema = readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8");

function emptyTables() {
  return Object.fromEntries(TRANSFER_TABLES.map((table) => [table, []]));
}

function columnsFor(db) {
  return Object.fromEntries(TRANSFER_TABLES.map((table) => [
    table,
    db.prepare("PRAGMA table_info(" + table + ")").all().map((row) => row.name)
  ]));
}

test("portable transfer package requires every known table and records its schema version", () => {
  const pkg = createPortableTransferPackage(emptyTables(), "2026-11-10T06:00:00.000Z");
  assert.equal(pkg.format, "ONYX-SMART-ACCOUNTING-TRANSFER");
  assert.equal(pkg.schemaVersion, 5);
  assert.deepEqual(Object.keys(pkg.tables), [...TRANSFER_TABLES]);
  assert.equal(parsePortableTransferPackage(JSON.stringify(pkg)).generatedAt, pkg.generatedAt);
  const missing = emptyTables();
  delete missing.products;
  assert.throws(() => createPortableTransferPackage(missing), /غير مكتملة/);
});

test("portable transfer rejects malformed, foreign and incompatible packages", () => {
  const pkg = createPortableTransferPackage(emptyTables(), "2026-11-10T06:00:00.000Z");
  assert.throws(() => parsePortableTransferPackage("{"), /JSON صالح/);
  assert.throws(() => parsePortableTransferPackage({ ...pkg, format: "other" }), /ليس ملف نقل/);
  assert.throws(() => parsePortableTransferPackage({ ...pkg, version: 99 }), /غير مدعوم/);
  assert.throws(() => parsePortableTransferPackage({ ...pkg, schemaVersion: 4 }), /لا يطابق/);
  assert.throws(() => parsePortableTransferPackage({ ...pkg, tables: { ...pkg.tables, products: {} } }), /ليست قائمة/);
});

test("portable import replaces business data in foreign-key-safe order and preserves relational integrity", () => {
  const source = new Database(":memory:");
  const target = new Database(":memory:");
  source.pragma("foreign_keys = ON");
  target.pragma("foreign_keys = ON");
  source.exec(schema);
  target.exec(schema);

  source.prepare("INSERT INTO parties(party_code,name_ar,party_type,receivable_account_id,payable_account_id) VALUES('CUS-X','عميل النقل','customer',(SELECT id FROM accounts WHERE code='1200'),(SELECT id FROM accounts WHERE code='2100'))").run();
  source.prepare("INSERT INTO warehouses(code,name_ar) VALUES('WH-X','مستودع النقل')").run();
  source.prepare("INSERT INTO products(sku,name_ar,purchase_cost,sale_price,inventory_account_id,revenue_account_id,cogs_account_id) VALUES('SKU-X','صنف النقل',5,10,(SELECT id FROM accounts WHERE code='1300'),(SELECT id FROM accounts WHERE code='4100'),(SELECT id FROM accounts WHERE code='5100'))").run();
  source.prepare("INSERT INTO employees(employee_code,name_ar) VALUES('EMP-X','موظف النقل')").run();
  source.prepare("INSERT INTO journal_entries(entry_no,entry_date,memo,status,posted_at) VALUES('JV-X','2026-11-10','قيد النقل','posted',datetime('now'))").run();
  source.prepare("INSERT INTO journal_lines(journal_id,line_no,account_id,currency_code,debit,credit,memo) VALUES((SELECT id FROM journal_entries WHERE entry_no='JV-X'),1,(SELECT id FROM accounts WHERE code='1100'),'YER',25,0,'قيد النقل'),((SELECT id FROM journal_entries WHERE entry_no='JV-X'),2,(SELECT id FROM accounts WHERE code='3100'),'YER',0,25,'قيد النقل')").run();
  source.prepare("INSERT INTO accounts(code,name_ar,account_type,normal_side,parent_id,is_postable) VALUES('9000','مجموعة تجريبية','asset','debit',(SELECT id FROM accounts WHERE code='1000'),0)").run();
  source.prepare("INSERT INTO accounts(code,name_ar,account_type,normal_side,parent_id,is_postable) VALUES('9001','حساب فرعي تجريبي','asset','debit',(SELECT id FROM accounts WHERE code='9000'),1)").run();

  target.prepare("INSERT INTO parties(party_code,name_ar,party_type) VALUES('OLD','بيانات قديمة','customer')").run();
  const tables = Object.fromEntries(TRANSFER_TABLES.map((table) => [
    table, source.prepare("SELECT * FROM " + table + " ORDER BY rowid").all()
  ]));
  const pkg = createPortableTransferPackage(tables, "2026-11-10T06:00:00.000Z");
  const statements = buildPortableImportStatements(pkg, columnsFor(target));
  const apply = target.transaction((items) => {
    for (const item of items) target.prepare(item.sql).run(...item.params);
  });
  apply(statements);

  assert.equal(target.prepare("SELECT name_ar FROM parties WHERE party_code='CUS-X'").get().name_ar, "عميل النقل");
  assert.equal(target.prepare("SELECT COUNT(*) AS n FROM parties WHERE party_code='OLD'").get().n, 0);
  assert.equal(target.prepare("SELECT COUNT(*) AS n FROM journal_lines").get().n, 2);
  assert.equal(target.prepare("SELECT parent_id FROM accounts WHERE code='9001'").get().parent_id,
    target.prepare("SELECT id FROM accounts WHERE code='9000'").get().id);
  assert.deepEqual(target.pragma("foreign_key_check"), []);
  assert.equal(target.pragma("integrity_check", { simple: true }), "ok");
  source.close();
  target.close();
});

test("portable import rejects column mismatches before producing SQL", () => {
  const tables = emptyTables();
  tables.currencies = [{ code: "YER", name_ar: "ريال", minor_unit: 2, is_active: 1, unexpected: "x" }];
  const pkg = createPortableTransferPackage(tables, "2026-11-10T06:00:00.000Z");
  const columns = Object.fromEntries(TRANSFER_TABLES.map((table) => [table, ["id"]]));
  columns.currencies = ["code", "name_ar", "minor_unit", "is_active"];
  assert.throws(() => buildPortableImportStatements(pkg, columns), /لا تطابق/);
});


test("portable transfer checksum detects accidental changes to exported business data", () => {
  const pkg = createPortableTransferPackage(emptyTables(), "2026-11-10T06:00:00.000Z");
  const changed = JSON.parse(JSON.stringify(pkg));
  changed.tables.parties.push({ id: 1, party_code: "X", name_ar: "تغيير", party_type: "customer" });
  assert.throws(() => parsePortableTransferPackage(changed), /بصمة ملف النقل/);
});

test("portable transfer validates every posted journal and posted document link", () => {
  const tables = emptyTables();
  tables.accounts = [
    { id: 1, code: "1100", name_ar: "الصندوق", account_type: "asset", is_active: 1, is_postable: 1 },
    { id: 2, code: "3100", name_ar: "رأس المال", account_type: "equity", is_active: 1, is_postable: 1 }
  ];
  tables.currencies = [{ code: "YER", name_ar: "ريال يمني", minor_unit: 2, is_active: 1 }];
  tables.journal_entries = [{ id: 1, entry_no: "JV-1", entry_date: "2026-11-10", memo: "قيد", status: "posted" }];
  tables.journal_lines = [
    { id: 1, journal_id: 1, line_no: 1, account_id: 1, party_id: null, currency_code: "YER", debit: 100, credit: 0, memo: "قيد" },
    { id: 2, journal_id: 1, line_no: 2, account_id: 2, party_id: null, currency_code: "YER", debit: 0, credit: 100, memo: "قيد" }
  ];
  const valid = createPortableTransferPackage(tables, "2026-11-10T06:00:00.000Z");
  assert.equal(validatePortableAccountingData(valid), true);
  const unbalancedTables = structuredClone(tables);
  unbalancedTables.journal_lines[1].credit = 99;
  const unbalanced = createPortableTransferPackage(unbalancedTables, "2026-11-10T06:00:00.000Z");
  assert.throws(() => validatePortableAccountingData(unbalanced), /غير متوازن/);
});


test("portable transfer SQL failure rolls back the target database instead of leaving partial deletion", () => {
  const target = new Database(":memory:");
  target.pragma("foreign_keys = ON");
  target.exec(schema);
  target.prepare("INSERT INTO parties(party_code,name_ar,party_type) VALUES('OLD','بيانات محفوظة','customer')").run();
  const beforeAccounts = target.prepare("SELECT COUNT(*) AS n FROM accounts").get().n;
  const tables = emptyTables();
  tables.parties = [
    { id: 1, party_code: "DUP", name_ar: "سجل أول", party_type: "customer", phone: "", address: "", tax_number: "", receivable_account_id: null, payable_account_id: null, is_active: 1 },
    { id: 2, party_code: "DUP", name_ar: "سجل مكرر", party_type: "customer", phone: "", address: "", tax_number: "", receivable_account_id: null, payable_account_id: null, is_active: 1 }
  ];
  const pkg = createPortableTransferPackage(tables, "2026-11-10T06:00:00.000Z");
  const statements = buildPortableImportStatements(pkg, columnsFor(target));
  const apply = target.transaction((items) => {
    for (const item of items) target.prepare(item.sql).run(...item.params);
  });
  assert.throws(() => apply(statements), /UNIQUE constraint failed/);
  assert.equal(target.prepare("SELECT name_ar FROM parties WHERE party_code='OLD'").get().name_ar, "بيانات محفوظة");
  assert.equal(target.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, beforeAccounts);
  assert.deepEqual(target.pragma("foreign_key_check"), []);
  assert.equal(target.pragma("integrity_check", { simple: true }), "ok");
  target.close();
});
