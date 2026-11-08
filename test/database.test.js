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
    "accounts", "currencies", "exchange_rates", "fiscal_years", "parties",
    "products", "warehouses", "journal_entries", "journal_lines", "sales_invoices",
    "sales_invoice_lines", "purchase_invoices", "purchase_invoice_lines",
    "stock_movements", "cash_boxes", "bank_accounts", "cash_transactions",
    "expenses", "revenues", "tax_rates", "fixed_assets", "depreciation_runs",
    "debt_installments", "audit_log", "transfer_packages", "backup_history"
  ]) assert.ok(names.includes(name), "missing table " + name);
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 2);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_journal_party_currency'").get());
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