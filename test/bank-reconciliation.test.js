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

function postEntry(db, reference, date, lines) {
  const entry = db.prepare(
    "INSERT INTO journal_entries(entry_no,entry_date,memo,source_type,status,posted_at) VALUES(?,?,?,'manual','posted',datetime('now'))"
  ).run(reference, date, reference);
  const journalId = Number(entry.lastInsertRowid);
  const insertLine = db.prepare(
    "INSERT INTO journal_lines(journal_id,line_no,account_id,currency_code,debit,credit,memo) VALUES(?,?,?,?,?,?,?)"
  );
  const ids = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const result = insertLine.run(journalId, i + 1, line.accountId, "YER", line.debit || 0, line.credit || 0, reference);
    ids.push(Number(result.lastInsertRowid));
  }
  return ids;
}

function prepareBank(db) {
  const accountId = db.prepare("SELECT id FROM accounts WHERE code='1100'").get().id;
  const result = db.prepare(
    "INSERT INTO bank_accounts(bank_name,account_name,account_number,currency_code,account_id) VALUES('البنك','الحساب الجاري','BANK-001','YER',?)"
  ).run(accountId);
  return { bankAccountId: Number(result.lastInsertRowid), accountId };
}

test("bank reconciliation matches statement movements and reports outstanding book items", async () => {
  const { db, service } = setup();
  const { bankAccountId, accountId } = prepareBank(db);
  const revenueId = db.prepare("SELECT id FROM accounts WHERE code='4100'").get().id;
  const expenseId = db.prepare("SELECT id FROM accounts WHERE code='5200'").get().id;

  postEntry(db, "OPEN-BANK", "2026-10-31", [
    { accountId, debit: 1000 }, { accountId: db.prepare("SELECT id FROM accounts WHERE code='3100'").get().id, credit: 1000 }
  ]);
  const receiptLines = postEntry(db, "BANK-RECEIPT", "2026-11-02", [
    { accountId, debit: 200 }, { accountId: revenueId, credit: 200 }
  ]);
  const paymentLines = postEntry(db, "BANK-PAYMENT", "2026-11-03", [
    { accountId: expenseId, debit: 50 }, { accountId, credit: 50 }
  ]);
  postEntry(db, "BANK-OUTSTANDING", "2026-11-04", [
    { accountId: expenseId, debit: 30 }, { accountId, credit: 30 }
  ]);

  const reconciliation = await service.createBankReconciliation({
    number: "BR-NOV-2026", bankAccountId, startDate: "2026-11-01", endDate: "2026-11-30",
    openingBalance: 1000, closingBalance: 1150, memo: "كشف نوفمبر"
  });
  const deposit = await service.addBankStatementLine({
    reconciliationId: reconciliation.id, statementDate: "2026-11-02", reference: "DEP-1",
    description: "إيداع عميل", amount: 200
  });
  const withdrawal = await service.addBankStatementLine({
    reconciliationId: reconciliation.id, statementDate: "2026-11-03", reference: "CHQ-1",
    description: "شيك صادر", amount: -50
  });
  await service.matchBankStatementLine({ lineId: deposit.id, journalLineId: receiptLines[0] });
  await service.matchBankStatementLine({ lineId: withdrawal.id, journalLineId: paymentLines[1] });

  const result = await service.completeBankReconciliation(reconciliation.id);
  assert.deepEqual(result, {
    number: "BR-NOV-2026",
    statementClosingBalance: 1150,
    bookClosingBalance: 1120,
    adjustedBookBalance: 1150,
    outstandingCount: 1,
    outstandingNet: -30
  });
  assert.equal(db.prepare("SELECT status FROM bank_reconciliations WHERE id=?").get(reconciliation.id).status, "closed");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity_type='bank_reconciliation'").get().n, 1);
  await assert.rejects(() => service.addBankStatementLine({
    reconciliationId: reconciliation.id, statementDate: "2026-11-05", amount: 10
  }), /مقفلة/);
  db.close();
});

test("bank reconciliation rejects invalid periods, duplicate periods and invalid statement movements", async () => {
  const { db, service } = setup();
  const { bankAccountId } = prepareBank(db);
  await assert.rejects(() => service.createBankReconciliation({
    bankAccountId, startDate: "2026-02-31", endDate: "2026-03-01", openingBalance: 0, closingBalance: 0
  }), /فترة التسوية/);
  await assert.rejects(() => service.createBankReconciliation({
    bankAccountId, startDate: "2026-11-30", endDate: "2026-11-01", openingBalance: 0, closingBalance: 0
  }), /فترة التسوية/);
  const first = await service.createBankReconciliation({
    number: "BR-1", bankAccountId, startDate: "2026-11-01", endDate: "2026-11-30",
    openingBalance: 0, closingBalance: 0
  });
  await assert.rejects(() => service.createBankReconciliation({
    number: "BR-2", bankAccountId, startDate: "2026-11-15", endDate: "2026-12-15",
    openingBalance: 0, closingBalance: 0
  }), /متداخلة/);
  await assert.rejects(() => service.addBankStatementLine({
    reconciliationId: first.id, statementDate: "2026-12-01", amount: 10
  }), /خارج فترة/);
  await assert.rejects(() => service.addBankStatementLine({
    reconciliationId: first.id, statementDate: "2026-11-02", amount: 0
  }), /غير صفري/);
  db.close();
});

test("bank reconciliation requires exact posted bank-ledger matches and all statement lines matched", async () => {
  const { db, service } = setup();
  const { bankAccountId, accountId } = prepareBank(db);
  const revenueId = db.prepare("SELECT id FROM accounts WHERE code='4100'").get().id;
  const wrongAccountId = db.prepare("SELECT id FROM accounts WHERE code='1200'").get().id;
  postEntry(db, "OPEN-MATCH", "2026-10-31", [
    { accountId, debit: 500 }, { accountId: db.prepare("SELECT id FROM accounts WHERE code='3100'").get().id, credit: 500 }
  ]);
  const bankLineIds = postEntry(db, "BANK-MATCH", "2026-11-02", [
    { accountId, debit: 75 }, { accountId: revenueId, credit: 75 }
  ]);
  const wrongAccountLineIds = postEntry(db, "WRONG-ACCOUNT", "2026-11-02", [
    { accountId: wrongAccountId, debit: 75 }, { accountId: revenueId, credit: 75 }
  ]);
  const unposted = db.prepare("INSERT INTO journal_entries(entry_no,entry_date,status) VALUES('DRAFT-BANK','2026-11-02','draft')").run();
  const draftLine = db.prepare(
    "INSERT INTO journal_lines(journal_id,line_no,account_id,currency_code,debit,credit) VALUES(?,1,?,'YER',75,0)"
  ).run(Number(unposted.lastInsertRowid), accountId);

  const reconciliation = await service.createBankReconciliation({
    bankAccountId, startDate: "2026-11-01", endDate: "2026-11-30",
    openingBalance: 500, closingBalance: 575
  });
  const statementLine = await service.addBankStatementLine({
    reconciliationId: reconciliation.id, statementDate: "2026-11-02", amount: 75
  });
  await assert.rejects(() => service.matchBankStatementLine({
    lineId: statementLine.id, journalLineId: wrongAccountLineIds[0]
  }), /ليس حركة مرحلة/);
  await assert.rejects(() => service.matchBankStatementLine({
    lineId: statementLine.id, journalLineId: draftLine.lastInsertRowid
  }), /ليس حركة مرحلة/);
  const wrongAmountLineIds = postEntry(db, "WRONG-AMOUNT", "2026-11-03", [
    { accountId, debit: 74 }, { accountId: revenueId, credit: 74 }
  ]);
  await assert.rejects(() => service.matchBankStatementLine({
    lineId: statementLine.id, journalLineId: wrongAmountLineIds[0]
  }), /لا يطابق/);
  await assert.rejects(() => service.completeBankReconciliation(reconciliation.id), /مطابقة جميع/);
  await service.matchBankStatementLine({ lineId: statementLine.id, journalLineId: bankLineIds[0] });
  await assert.rejects(() => service.matchBankStatementLine({
    lineId: statementLine.id, journalLineId: bankLineIds[0]
  }), /مسبقاً/);
  const result = await service.completeBankReconciliation(reconciliation.id);
  assert.equal(result.adjustedBookBalance, 575);
  db.close();
});

test("bank reconciliation refuses an opening balance that differs from the bank ledger", async () => {
  const { db, service } = setup();
  const { bankAccountId, accountId } = prepareBank(db);
  postEntry(db, "OPEN-DIFF", "2026-10-31", [
    { accountId, debit: 500 }, { accountId: db.prepare("SELECT id FROM accounts WHERE code='3100'").get().id, credit: 500 }
  ]);
  const revenueId = db.prepare("SELECT id FROM accounts WHERE code='4100'").get().id;
  const movement = postEntry(db, "OPEN-DIFF-MOVEMENT", "2026-11-02", [
    { accountId, debit: 0.01 }, { accountId: revenueId, credit: 0.01 }
  ]);
  const reconciliation = await service.createBankReconciliation({
    bankAccountId, startDate: "2026-11-01", endDate: "2026-11-30",
    openingBalance: 450, closingBalance: 450.01
  });
  const statementLine = await service.addBankStatementLine({
    reconciliationId: reconciliation.id, statementDate: "2026-11-02", amount: 0.01
  });
  await service.matchBankStatementLine({ lineId: statementLine.id, journalLineId: movement[0] });
  await assert.rejects(() => service.completeBankReconciliation(reconciliation.id), /رصيد كشف البنك الافتتاحي/);
  db.close();
});
