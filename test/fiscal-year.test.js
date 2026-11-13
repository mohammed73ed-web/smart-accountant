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

function accountId(db, code) {
  return db.prepare("SELECT id FROM accounts WHERE code=?").get(code).id;
}

function postEntry(db, reference, date, lines) {
  db.prepare(
    "INSERT INTO journal_entries(entry_no,entry_date,memo,status,posted_at) VALUES(?,?,?,'posted',datetime('now'))"
  ).run(reference, date, reference);
  const journalId = db.prepare("SELECT id FROM journal_entries WHERE entry_no=?").get(reference).id;
  const insert = db.prepare(
    "INSERT INTO journal_lines(journal_id,line_no,account_id,currency_code,debit,credit,memo) VALUES(?,?,?,?,?,?,?)"
  );
  lines.forEach((line, index) => insert.run(
    journalId, index + 1, accountId(db, line.account), line.currency || "YER",
    line.debit || 0, line.credit || 0, reference
  ));
  return journalId;
}

test("fiscal year creation validates dates and prevents overlapping periods", async () => {
  const { db, service } = setup();
  await assert.rejects(
    () => service.createFiscalYear({ name: "Invalid", startDate: "2025-02-30", endDate: "2027-01-31" }),
    /نطاق السنة المالية غير صالح/
  );
  await service.createFiscalYear({ name: "FY-2025", startDate: "2025-01-01", endDate: "2025-12-31" });
  await assert.rejects(
    () => service.createFiscalYear({ name: "FY-2025-overlap", startDate: "2025-12-01", endDate: "2026-11-30" }),
    /تتداخل السنة المالية/
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fiscal_years").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity_type='fiscal_year' AND action='create'").get().n, 1);
  db.close();
});

test("year close posts profit to retained earnings and carries balance-sheet balances forward atomically", async () => {
  const { db, service } = setup();
  await service.createFiscalYear({ name: "FY-2025", startDate: "2025-01-01", endDate: "2025-12-31" });
  const fiscalYearId = db.prepare("SELECT id FROM fiscal_years WHERE name='FY-2025'").get().id;

  postEntry(db, "JV-CAPITAL", "2025-01-01", [
    { account: "1100", debit: 50 }, { account: "3100", credit: 50 }
  ]);
  postEntry(db, "JV-SALES", "2025-02-01", [
    { account: "1100", debit: 150 }, { account: "4100", credit: 150 }
  ]);
  postEntry(db, "JV-EXPENSE", "2025-03-01", [
    { account: "5200", debit: 40 }, { account: "1100", credit: 40 }
  ]);

  const result = await service.closeFiscalYear(fiscalYearId, { nextYearName: "FY-2025" });
  assert.equal(result.nextStartDate, "2026-01-01");
  assert.equal(db.prepare("SELECT status FROM fiscal_years WHERE id=?").get(fiscalYearId).status, "closed");
  assert.equal(db.prepare("SELECT start_date FROM fiscal_years WHERE id=?").get(result.nextFiscalYearId).start_date, "2026-01-01");

  const closing = db.prepare(
    "SELECT a.code,l.debit,l.credit FROM journal_lines l JOIN accounts a ON a.id=l.account_id " +
    "WHERE l.journal_id=(SELECT id FROM journal_entries WHERE entry_no=?) ORDER BY a.code"
  ).all(result.closingJournalReference);
  assert.deepEqual(closing, [
    { code: "3200", debit: 0, credit: 110 },
    { code: "4100", debit: 150, credit: 0 },
    { code: "5200", debit: 0, credit: 40 }
  ]);

  const opening = db.prepare(
    "SELECT a.code,l.debit,l.credit FROM journal_lines l JOIN accounts a ON a.id=l.account_id " +
    "WHERE l.journal_id=(SELECT id FROM journal_entries WHERE entry_no=?) ORDER BY a.code"
  ).all(result.openingJournalReference);
  assert.deepEqual(opening, [
    { code: "1100", debit: 160, credit: 0 },
    { code: "3100", debit: 0, credit: 50 },
    { code: "3200", debit: 0, credit: 110 }
  ]);
  const totals = db.prepare(
    "SELECT SUM(debit) AS debit,SUM(credit) AS credit FROM journal_lines WHERE journal_id IN " +
    "(SELECT id FROM journal_entries WHERE entry_no IN (?,?))"
  ).get(result.closingJournalReference, result.openingJournalReference);
  assert.equal(totals.debit, totals.credit);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='close' AND entity_id=?").get(String(fiscalYearId)).n, 1);
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  assert.deepEqual(db.pragma("foreign_key_check"), []);

  assert.throws(
    () => db.prepare("INSERT INTO journal_entries(entry_no,entry_date,status) VALUES('JV-CLOSED-INSERT','2025-06-01','posted')").run(),
    /لا يمكن ترحيل قيد داخل سنة مالية مغلقة/
  );
  db.prepare("INSERT INTO journal_entries(entry_no,entry_date,status) VALUES('JV-CLOSED-DRAFT','2025-06-02','draft')").run();
  assert.throws(
    () => db.prepare("UPDATE journal_entries SET status='posted' WHERE entry_no='JV-CLOSED-DRAFT'").run(),
    /لا يمكن ترحيل قيد داخل سنة مالية مغلقة/
  );
  assert.doesNotThrow(
    () => db.prepare("INSERT INTO journal_entries(entry_no,entry_date,status) VALUES('JV-NEXT-YEAR','2026-01-01','posted')").run()
  );
  const closingJournalId = db.prepare("SELECT id FROM journal_entries WHERE entry_no=?").get(result.closingJournalReference).id;
  const closingLineId = db.prepare("SELECT id FROM journal_lines WHERE journal_id=? LIMIT 1").get(closingJournalId).id;
  assert.throws(
    () => db.prepare("UPDATE journal_entries SET memo='تعديل غير مسموح' WHERE id=?").run(closingJournalId),
    /لا يمكن تعديل قيد مرحل داخل سنة مالية مغلقة/
  );
  assert.throws(
    () => db.prepare("DELETE FROM journal_entries WHERE id=?").run(closingJournalId),
    /لا يمكن حذف قيد مرحل داخل سنة مالية مغلقة/
  );
  assert.throws(
    () => db.prepare("UPDATE journal_lines SET memo='تعديل غير مسموح' WHERE id=?").run(closingLineId),
    /لا يمكن تعديل سطر قيد مرحل داخل سنة مالية مغلقة/
  );
  assert.throws(
    () => db.prepare("DELETE FROM journal_lines WHERE id=?").run(closingLineId),
    /لا يمكن حذف سطر قيد مرحل داخل سنة مالية مغلقة/
  );
  assert.throws(
    () => db.prepare("INSERT INTO journal_lines(journal_id,line_no,account_id,currency_code,debit,credit) VALUES(?,99,?,'YER',1,0)").run(closingJournalId, accountId(db, "1100")),
    /لا يمكن إضافة سطر إلى قيد مرحل داخل سنة مالية مغلقة/
  );
  await assert.rejects(() => service.closeFiscalYear(fiscalYearId), /مغلقة مسبقاً/);
  db.close();
});

test("year close refuses to run after a journal has already been posted in the next year", async () => {
  const { db, service } = setup();
  await service.createFiscalYear({ name: "FY-2025", startDate: "2025-01-01", endDate: "2025-12-31" });
  const id = db.prepare("SELECT id FROM fiscal_years WHERE name='FY-2025'").get().id;
  postEntry(db, "JV-FUTURE", "2026-01-01", [
    { account: "1100", debit: 25 }, { account: "3100", credit: 25 }
  ]);
  await assert.rejects(() => service.closeFiscalYear(id), /لا يمكن الإقفال بعد ترحيل قيود/);
  assert.equal(db.prepare("SELECT status FROM fiscal_years WHERE id=?").get(id).status, "open");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE source_type LIKE 'fiscal_year_%'").get().n, 0);
  db.close();
});

test("year close refuses to carry forward unclosed historical profit-and-loss balances", async () => {
  const { db, service } = setup();
  await service.createFiscalYear({ name: "FY-2024", startDate: "2024-01-01", endDate: "2024-12-31" });
  await service.createFiscalYear({ name: "FY-2025", startDate: "2025-01-01", endDate: "2025-12-31" });
  postEntry(db, "JV-OLD-SALES", "2024-06-01", [
    { account: "1100", debit: 75 }, { account: "4100", credit: 75 }
  ]);
  db.prepare("UPDATE fiscal_years SET status='closed' WHERE name='FY-2024'").run();
  const id = db.prepare("SELECT id FROM fiscal_years WHERE name='FY-2025'").get().id;
  await assert.rejects(() => service.closeFiscalYear(id), /أرصدة إيرادات أو مصروفات من فترات سابقة/);
  assert.equal(db.prepare("SELECT status FROM fiscal_years WHERE id=?").get(id).status, "open");
  db.close();
});

test("year close refuses to close while a posted journal is missing lines or is unbalanced", async () => {
  const { db, service } = setup();
  await service.createFiscalYear({ name: "FY-2025", startDate: "2025-01-01", endDate: "2025-12-31" });
  const id = db.prepare("SELECT id FROM fiscal_years WHERE name='FY-2025'").get().id;
  postEntry(db, "JV-BROKEN", "2025-05-01", [
    { account: "1100", debit: 100 }
  ]);
  await assert.rejects(() => service.closeFiscalYear(id), /JV-BROKEN/);
  assert.equal(db.prepare("SELECT status FROM fiscal_years WHERE id=?").get(id).status, "open");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE source_type LIKE 'fiscal_year_%'").get().n, 0);
  db.close();
});

test("year close refuses to create a next fiscal year that overlaps an existing later period", async () => {
  const { db, service } = setup();
  await service.createFiscalYear({ name: "FY-2025", startDate: "2025-01-01", endDate: "2025-12-31" });
  await service.createFiscalYear({ name: "FY-2025-JUN", startDate: "2026-06-01", endDate: "2027-05-31" });
  const id = db.prepare("SELECT id FROM fiscal_years WHERE name='FY-2025'").get().id;
  await assert.rejects(() => service.closeFiscalYear(id), /تتداخل السنة المالية التالية/);
  assert.equal(db.prepare("SELECT status FROM fiscal_years WHERE id=?").get(id).status, "open");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE source_type LIKE 'fiscal_year_%'").get().n, 0);
  db.close();
});

test("year close requires an active retained earnings account", async () => {
  const { db, service } = setup();
  await service.createFiscalYear({ name: "FY-2025", startDate: "2025-01-01", endDate: "2025-12-31" });
  const id = db.prepare("SELECT id FROM fiscal_years WHERE name='FY-2025'").get().id;
  postEntry(db, "JV-SALES-INACTIVE-RE", "2025-04-01", [
    { account: "1100", debit: 20 }, { account: "4100", credit: 20 }
  ]);
  db.prepare("UPDATE accounts SET is_active=0 WHERE code='3200'").run();
  await assert.rejects(() => service.closeFiscalYear(id), /حساب الأرباح المحتجزة 3200 يجب أن يكون نشطاً/);
  assert.equal(db.prepare("SELECT status FROM fiscal_years WHERE id=?").get(id).status, "open");
  db.close();
});

test("year close refuses opening balances on a non-postable parent account", async () => {
  const { db, service } = setup();
  await service.createFiscalYear({ name: "FY-2025", startDate: "2025-01-01", endDate: "2025-12-31" });
  const id = db.prepare("SELECT id FROM fiscal_years WHERE name='FY-2025'").get().id;
  postEntry(db, "JV-NONPOSTABLE", "2025-04-01", [
    { account: "1100", debit: 20 }, { account: "3100", credit: 20 }
  ]);
  db.prepare("UPDATE accounts SET is_postable=0 WHERE code='1100'").run();
  await assert.rejects(() => service.closeFiscalYear(id), /لا يمكن الترحيل إلى حساب غير نشط أو تجميعي: 1100/);
  assert.equal(db.prepare("SELECT status FROM fiscal_years WHERE id=?").get(id).status, "open");
  db.close();
});

test("year close refuses to close before the fiscal year end date", async () => {
  const { db, service } = setup();
  await service.createFiscalYear({ name: "FY-2099", startDate: "2099-01-01", endDate: "2099-12-31" });
  const id = db.prepare("SELECT id FROM fiscal_years WHERE name='FY-2099'").get().id;
  await assert.rejects(() => service.closeFiscalYear(id), /لا يمكن إقفال السنة المالية قبل تاريخ نهايتها/);
  assert.equal(db.prepare("SELECT status FROM fiscal_years WHERE id=?").get(id).status, "open");
  db.close();
});
