import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const schema = readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8");

function memoryDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(schema);
  return db;
}

test("SQLite schema creates the ERP tables and passes integrity checks", () => {
  const db = memoryDb();
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((x) => x.name);
  for (const name of [
    "accounts", "currencies", "exchange_rates", "fiscal_years", "parties", "employees",
    "products", "warehouses", "journal_entries", "journal_lines", "sales_invoices",
    "sales_invoice_lines", "purchase_invoices", "purchase_invoice_lines",
    "stock_movements", "cash_boxes", "bank_accounts", "cash_transactions", "cash_transfers",
    "bank_reconciliations", "bank_reconciliation_lines", "bank_reconciliation_outstanding",
    "bank_reconciliations", "bank_reconciliation_lines", "bank_reconciliation_outstanding",
    "expenses", "revenues", "tax_rates", "fixed_assets", "depreciation_runs",
    "debt_installments", "audit_log", "transfer_packages", "backup_history",
    "users", "roles", "permissions", "user_roles", "role_permissions"
  ]) assert.ok(names.includes(name), "missing table " + name);
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 10);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_block_posted_journal_in_closed_year_insert'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_block_posted_journal_in_closed_year_update'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_freeze_closed_journal_update'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_freeze_closed_journal_line_update'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_prevent_overlapping_fiscal_year_insert'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_prevent_overlapping_fiscal_year_update'").get());
  assert.equal(db.prepare("SELECT cash_flow_category FROM accounts WHERE code='1200'").get().cash_flow_category, "operating");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM roles").get().n, 5);
  assert.ok(db.prepare("SELECT id FROM permissions WHERE permission_key='users.manage'").get());
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM role_permissions WHERE role_id=(SELECT id FROM roles WHERE role_key='administrator')").get().n > 0);
  assert.equal(db.prepare("SELECT cash_flow_category FROM accounts WHERE code='1400'").get().cash_flow_category, "investing");
  assert.equal(db.prepare("SELECT cash_flow_category FROM accounts WHERE code='3100'").get().cash_flow_category, "financing");
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_journal_party_currency'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_employees_search'").get());
  db.close();
});

test("SQLite rejects negative journal values and invalid foreign keys", () => {
  const db = memoryDb();
  db.prepare("INSERT INTO journal_entries(entry_no,entry_date,status) VALUES(?,?,?)").run("J-1", "2026-11-08", "posted");
  const journalId = db.prepare("SELECT id FROM journal_entries WHERE entry_no='J-1'").get().id;
  assert.throws(() => db.prepare(
    "INSERT INTO journal_lines(journal_id,line_no,account_id,currency_code,debit,credit) VALUES(?,?,?,?,?,?)"
  ).run(journalId, 1, 2, "YER", -10, 0));
  assert.throws(() => db.prepare(
    "INSERT INTO journal_lines(journal_id,line_no,account_id,currency_code,debit,credit) VALUES(?,?,?,?,?,?)"
  ).run(journalId, 1, 99999, "YER", 10, 0));
  db.close();
});

test("SQLite transaction rolls back every write after a constraint failure", () => {
  const db = memoryDb();
  const insert = db.transaction(() => {
    db.prepare("INSERT INTO parties(party_code,name_ar,party_type) VALUES(?,?,?)").run("C-1", "عميل", "customer");
    db.prepare("INSERT INTO parties(party_code,name_ar,party_type) VALUES(?,?,?)").run("C-1", "مكرر", "customer");
  });
  assert.throws(() => insert());
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM parties").get().n, 0);
  db.close();
});
test("SQLite prevents overlapping fiscal years even when written outside the service", () => {
  const db = memoryDb();
  db.prepare("INSERT INTO fiscal_years(name,start_date,end_date,status) VALUES('FY-A','2025-01-01','2025-12-31','open')").run();
  db.prepare("INSERT INTO fiscal_years(name,start_date,end_date,status) VALUES('FY-B','2026-01-01','2026-12-31','open')").run();
  assert.throws(
    () => db.prepare("INSERT INTO fiscal_years(name,start_date,end_date,status) VALUES('FY-OVERLAP','2025-12-01','2026-11-30','open')").run(),
    /نطاق السنة المالية غير صالح أو يتداخل/
  );
  assert.throws(
    () => db.prepare("UPDATE fiscal_years SET start_date='2025-06-01' WHERE name='FY-B'").run(),
    /نطاق السنة المالية غير صالح أو يتداخل/
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fiscal_years").get().n, 2);
  db.close();
});
