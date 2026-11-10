import test from "node:test";
import assert from "node:assert/strict";
import {
  validateJournal, filterEntriesByDate, trialBalance, generalLedger, incomeStatement,
  balanceSheet, cashFlow, movingAverageCost, buildSalesJournal, buildPurchaseJournal
} from "../src/core/accounting.js";

const accounts = [
  { code: "1100", name: "الصندوق", type: "asset", is_active: 1, is_postable: 1, cashFlowCategory: "operating" },
  { code: "1200", name: "العملاء", type: "asset", is_active: 1, is_postable: 1 },
  { code: "1300", name: "المخزون", type: "asset", is_active: 1, is_postable: 1 },
  { code: "2100", name: "الموردون", type: "liability", is_active: 1, is_postable: 1 },
  { code: "2200", name: "الضريبة", type: "liability", is_active: 1, is_postable: 1 },
  { code: "3100", name: "رأس المال", type: "equity", is_active: 1, is_postable: 1 },
  { code: "4100", name: "المبيعات", type: "revenue", is_active: 1, is_postable: 1 },
  { code: "5100", name: "تكلفة المبيعات", type: "expense", is_active: 1, is_postable: 1 },
  { code: "5200", name: "المصروفات", type: "expense", is_active: 1, is_postable: 1 }
];
const journal = (reference, date, lines) => ({ reference, date, status: "posted", memo: reference, lines });

test("accepts a balanced double-entry journal", () => {
  assert.equal(validateJournal(journal("J1", "2026-11-08", [
    { accountCode: "1100", debit: 100, credit: 0, currency: "YER" },
    { accountCode: "3100", debit: 0, credit: 100, currency: "YER" }
  ]), accounts).valid, true);
});
test("rejects an unbalanced journal", () => {
  assert.throws(() => validateJournal(journal("J1", "2026-11-08", [
    { accountCode: "1100", debit: 100, credit: 0, currency: "YER" },
    { accountCode: "3100", debit: 0, credit: 99, currency: "YER" }
  ]), accounts), /غير متوازن/);
});
test("rejects fewer than two lines", () => {
  assert.throws(() => validateJournal(journal("J1", "2026-11-08", [
    { accountCode: "1100", debit: 100, credit: 0, currency: "YER" }
  ]), accounts), /سطرين/);
});
test("rejects an unknown account", () => {
  assert.throws(() => validateJournal(journal("J1", "2026-11-08", [
    { accountCode: "9999", debit: 100, credit: 0, currency: "YER" },
    { accountCode: "3100", debit: 0, credit: 100, currency: "YER" }
  ]), accounts), /غير موجود/);
});
test("rejects posting to a parent account", () => {
  const chart = [...accounts, { code: "1000", is_active: 1, is_postable: 0 }];
  assert.throws(() => validateJournal(journal("J1", "2026-11-08", [
    { accountCode: "1000", debit: 100, credit: 0, currency: "YER" },
    { accountCode: "3100", debit: 0, credit: 100, currency: "YER" }
  ]), chart), /تجميعي/);
});
test("rejects negative and double-sided line amounts", () => {
  assert.throws(() => validateJournal(journal("J1", "2026-11-08", [
    { accountCode: "1100", debit: -1, credit: 0, currency: "YER" },
    { accountCode: "3100", debit: 0, credit: -1, currency: "YER" }
  ]), accounts), /غير صالحة/);
  assert.throws(() => validateJournal(journal("J1", "2026-11-08", [
    { accountCode: "1100", debit: 10, credit: 10, currency: "YER" },
    { accountCode: "3100", debit: 0, credit: 20, currency: "YER" }
  ]), accounts), /الوقت نفسه/);
});
test("rejects impossible dates", () => {
  assert.throws(() => validateJournal(journal("J1", "2026-02-31", [
    { accountCode: "1100", debit: 10, credit: 0, currency: "YER" },
    { accountCode: "3100", debit: 0, credit: 10, currency: "YER" }
  ]), accounts), /تاريخ القيد/);
});
test("balances trial balance and ignores drafts", () => {
  const entries = [
    journal("J1", "2026-11-01", [
      { accountCode: "1100", debit: 100, credit: 0, currency: "YER" },
      { accountCode: "3100", debit: 0, credit: 100, currency: "YER" }
    ]),
    { ...journal("D1", "2026-11-02", [
      { accountCode: "1100", debit: 50, credit: 0, currency: "YER" },
      { accountCode: "3100", debit: 0, credit: 50, currency: "YER" }
    ]), status: "draft" }
  ];
  const rows = trialBalance(entries, accounts, "YER");
  assert.equal(rows.find((r) => r.code === "1100").debit, 100);
  assert.equal(rows.find((r) => r.code === "3100").credit, 100);
});
test("calculates the general ledger running balance in date order", () => {
  const entries = [
    journal("J2", "2026-11-02", [{ accountCode: "1100", debit: 0, credit: 20, currency: "YER" }, { accountCode: "5200", debit: 20, credit: 0, currency: "YER" }]),
    journal("J1", "2026-11-01", [{ accountCode: "1100", debit: 100, credit: 0, currency: "YER" }, { accountCode: "3100", debit: 0, credit: 100, currency: "YER" }])
  ];
  const rows = generalLedger(entries, "1100", "YER");
  assert.deepEqual(rows.map((r) => r.balance), [100, 80]);
});
test("calculates income statement and balanced balance sheet", () => {
  const entries = [
    journal("J1", "2026-11-01", [{ accountCode: "1100", debit: 1000, credit: 0, currency: "YER" }, { accountCode: "3100", debit: 0, credit: 1000, currency: "YER" }]),
    journal("J2", "2026-11-02", [{ accountCode: "1200", debit: 500, credit: 0, currency: "YER" }, { accountCode: "4100", debit: 0, credit: 500, currency: "YER" }]),
    journal("J3", "2026-11-03", [{ accountCode: "5200", debit: 100, credit: 0, currency: "YER" }, { accountCode: "1100", debit: 0, credit: 100, currency: "YER" }])
  ];
  assert.deepEqual(incomeStatement(entries, accounts, "YER"), { currency: "YER", revenue: 500, expenses: 100, netIncome: 400 });
  const sheet = balanceSheet(entries, accounts, "YER");
  assert.equal(sheet.assets, 1400);
  assert.equal(sheet.liabilitiesAndEquity, 1400);
  assert.equal(sheet.balanced, true);
});
test("calculates cash flow by account category", () => {
  const entries = [journal("J1", "2026-11-01", [
    { accountCode: "1100", debit: 75, credit: 0, currency: "YER" },
    { accountCode: "4100", debit: 0, credit: 75, currency: "YER" }
  ])];
  const result = cashFlow(entries, accounts, ["1100"], "YER");
  assert.equal(result.netChange, 75);
});
test("allocates split cash movements across operating, investing and financing accounts", () => {
  const classifiedAccounts = [
    { code: "1100", type: "asset", cashFlowCategory: "operating" },
    { code: "5200", type: "expense", cashFlowCategory: "operating" },
    { code: "1400", type: "asset", cashFlowCategory: "investing" },
    { code: "3100", type: "equity", cashFlowCategory: "financing" },
    { code: "1200", type: "asset" }
  ];
  const entries = [
    journal("MIXED", "2026-11-08", [
      { accountCode: "1100", debit: 0, credit: 150, currency: "YER" },
      { accountCode: "5200", debit: 100, credit: 0, currency: "YER" },
      { accountCode: "1400", debit: 50, credit: 0, currency: "YER" }
    ]),
    journal("CAPITAL", "2026-11-09", [
      { accountCode: "1100", debit: 200, credit: 0, currency: "YER" },
      { accountCode: "3100", debit: 0, credit: 200, currency: "YER" }
    ]),
    journal("CUSTOMER", "2026-11-09", [
      { accountCode: "1100", debit: 0, credit: 30, currency: "YER" },
      { accountCode: "1200", debit: 30, credit: 0, currency: "YER" }
    ])
  ];
  const result = cashFlow(entries, classifiedAccounts, ["1100"], "YER");
  assert.equal(result.operating, -130);
  assert.equal(result.investing, -50);
  assert.equal(result.financing, 200);
  assert.equal(result.netChange, 20);
  assert.equal(result.operating + result.investing + result.financing, result.netChange);
});
test("cash flow ignores draft journals and transactions in other currencies", () => {
  const entries = [
    journal("YER-CASH", "2026-11-08", [
      { accountCode: "1100", debit: 100, credit: 0, currency: "YER" },
      { accountCode: "4100", debit: 0, credit: 100, currency: "YER" }
    ]),
    journal("USD-CASH", "2026-11-08", [
      { accountCode: "1100", debit: 900, credit: 0, currency: "USD" },
      { accountCode: "4100", debit: 0, credit: 900, currency: "USD" }
    ]),
    { ...journal("DRAFT-CASH", "2026-11-08", [
      { accountCode: "1100", debit: 500, credit: 0, currency: "YER" },
      { accountCode: "4100", debit: 0, credit: 500, currency: "YER" }
    ]), status: "draft" }
  ];
  assert.deepEqual(cashFlow(entries, accounts, ["1100"], "YER"), {
    operating: 100, investing: 0, financing: 0, netChange: 100, currency: "YER"
  });
});
test("calculates moving average inventory cost and rejects negative stock", () => {
  const result = movingAverageCost(10, 100, [
    { quantityIn: 10, quantityOut: 0, unitCost: 20 },
    { quantityIn: 0, quantityOut: 5, unitCost: 0 }
  ]);
  assert.deepEqual(result, { quantity: 15, value: 225, averageCost: 15 });
  assert.throws(() => movingAverageCost(1, 10, [{ quantityIn: 0, quantityOut: 2 }]), /أكبر من المخزون/);
});
test("builds balanced sales and purchase journal lines", () => {
  const sale = buildSalesJournal({ date: "2026-11-08", reference: "S1", subtotal: 100, tax: 15, costOfGoods: 40, currency: "YER" }, {
    receivable: "1200", revenue: "4100", taxPayable: "2200", cogs: "5100", inventory: "1300"
  });
  assert.equal(sale.lines.reduce((n, l) => n + l.debit, 0), 155);
  assert.equal(sale.lines.reduce((n, l) => n + l.credit, 0), 155);
  const purchase = buildPurchaseJournal({ date: "2026-11-08", reference: "P1", subtotal: 100, tax: 15, currency: "YER" }, {
    inventory: "1300", inputTax: "1200", payable: "2100"
  });
  assert.equal(purchase.lines.reduce((n, l) => n + l.debit, 0), 115);
  assert.equal(purchase.lines.reduce((n, l) => n + l.credit, 0), 115);
});

test("filters posted accounting entries by an inclusive, validated date range", () => {
  const entries = [
    journal("BEFORE", "2026-01-31", []),
    journal("START", "2026-02-01", []),
    journal("MIDDLE", "2026-02-14", []),
    journal("END", "2026-02-28", []),
    journal("AFTER", "2026-03-01", []),
    { ...journal("DRAFT", "2026-02-10", []), status: "draft" }
  ];
  assert.deepEqual(
    filterEntriesByDate(entries, { fromDate: "2026-02-01", toDate: "2026-02-28" }).map((entry) => entry.reference),
    ["START", "MIDDLE", "END"]
  );
  assert.deepEqual(
    filterEntriesByDate(entries, { toDate: "2026-01-31" }).map((entry) => entry.reference),
    ["BEFORE"]
  );
  assert.deepEqual(
    filterEntriesByDate(entries, { fromDate: "2026-03-01" }).map((entry) => entry.reference),
    ["AFTER"]
  );
  assert.throws(() => filterEntriesByDate(entries, { fromDate: "2026-02-30" }), /بداية التقرير غير صالح/);
  assert.throws(() => filterEntriesByDate(entries, { toDate: "2026-13-01" }), /نهاية التقرير غير صالح/);
  assert.throws(() => filterEntriesByDate(entries, { fromDate: "2026-03-01", toDate: "2026-02-28" }), /يجب ألا يتجاوز/);
  assert.throws(() => filterEntriesByDate([...entries, journal("BAD", "2026-02-30", [])], {}), /قيد مرحل بتاريخ غير صالح/);
});
