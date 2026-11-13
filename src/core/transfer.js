import { validateJournal } from "./accounting.js";
export const PORTABLE_TRANSFER_FORMAT = "ONYX-SMART-ACCOUNTING-TRANSFER";
export const PORTABLE_TRANSFER_VERSION = 1;
export const PORTABLE_SCHEMA_VERSION = 7;

// Device-specific backup history and transfer-package logs are deliberately
// excluded. Business data, accounting history and the audit trail are included.
export const TRANSFER_TABLES = Object.freeze([
  "company_settings",
  "currencies",
  "exchange_rates",
  "fiscal_years",
  "accounts",
  "parties",
  "warehouses",
  "products",
  "employees",
  "tax_rates",
  "journal_entries",
  "sales_invoices",
  "purchase_invoices",
  "sales_returns",
  "purchase_returns",
  "cash_boxes",
  "bank_accounts",
  "fixed_assets",
  "bank_reconciliations",
  "journal_lines",
  "sales_invoice_lines",
  "purchase_invoice_lines",
  "sales_return_lines",
  "purchase_return_lines",
  "stock_movements",
  "cash_transfers",
  "cash_transactions",
  "expenses",
  "revenues",
  "depreciation_runs",
  "debt_installments",
  "bank_reconciliation_lines",
  "bank_reconciliation_outstanding",
  "audit_log"
]);

// Delete dependants before their parents so SQLite foreign keys stay enabled.
const DELETE_ORDER = Object.freeze([
  "audit_log",
  "debt_installments",
  "depreciation_runs",
  "expenses",
  "revenues",
  "cash_transactions",
  "cash_transfers",
  "stock_movements",
  "bank_reconciliation_outstanding",
  "bank_reconciliation_lines",
  "sales_return_lines",
  "purchase_return_lines",
  "sales_invoice_lines",
  "purchase_invoice_lines",
  "journal_lines",
  "bank_reconciliations",
  "sales_returns",
  "purchase_returns",
  "sales_invoices",
  "purchase_invoices",
  "journal_entries",
  "fixed_assets",
  "bank_accounts",
  "cash_boxes",
  "employees",
  "products",
  "warehouses",
  "parties",
  "tax_rates",
  "fiscal_years",
  "exchange_rates",
  "accounts",
  "currencies",
  "company_settings"
]);

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function assertTables(tables) {
  if (!isRecord(tables)) throw new Error("ملف النقل لا يحتوي على جداول بيانات صالحة.");
  const keys = Object.keys(tables);
  const missing = TRANSFER_TABLES.filter((name) => !Object.hasOwn(tables, name));
  const unknown = keys.filter((name) => !TRANSFER_TABLES.includes(name));
  if (missing.length || unknown.length) {
    throw new Error("بنية ملف النقل غير مكتملة أو تحتوي جداول غير معروفة. الناقص: " +
      missing.join("، ") + "؛ غير المعروف: " + unknown.join("، "));
  }
  for (const table of TRANSFER_TABLES) {
    if (!Array.isArray(tables[table])) throw new Error("بيانات الجدول " + table + " ليست قائمة.");
    if (!tables[table].every(isRecord)) throw new Error("يحتوي الجدول " + table + " على سجل غير صالح.");
  }
}

export function createPortableTransferPackage(tables, generatedAt = new Date().toISOString()) {
  assertTables(tables);
  if (typeof generatedAt !== "string" || !Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("تاريخ إنشاء ملف النقل غير صالح.");
  }
  const payload = {
    format: PORTABLE_TRANSFER_FORMAT,
    version: PORTABLE_TRANSFER_VERSION,
    schemaVersion: PORTABLE_SCHEMA_VERSION,
    generatedAt,
    tables: Object.fromEntries(TRANSFER_TABLES.map((table) => [table, tables[table]]))
  };
  return { ...payload, checksum: transferChecksum(payload) };
}

export function parsePortableTransferPackage(input) {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      throw new Error("ملف النقل ليس JSON صالحاً.");
    }
  }
  if (!isRecord(value) || value.format !== PORTABLE_TRANSFER_FORMAT) {
    throw new Error("هذا الملف ليس ملف نقل ONYX معتمداً.");
  }
  if (value.version !== PORTABLE_TRANSFER_VERSION) {
    throw new Error("إصدار ملف النقل غير مدعوم.");
  }
  if (value.schemaVersion !== PORTABLE_SCHEMA_VERSION) {
    throw new Error("إصدار قاعدة البيانات في الملف لا يطابق هذا الإصدار من ONYX.");
  }
  if (typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt))) {
    throw new Error("تاريخ ملف النقل مفقود أو غير صالح.");
  }
  assertTables(value.tables);
  const { checksum, ...payload } = value;
  if (typeof checksum !== "string" || checksum !== transferChecksum(payload)) {
    throw new Error("فشل التحقق من بصمة ملف النقل؛ قد يكون الملف تالفاً أو تم تعديله.");
  }
  return value;
}

export function buildPortableImportStatements(input, tableColumns) {
  const pkg = parsePortableTransferPackage(input);
  if (!isRecord(tableColumns)) throw new Error("تعذر قراءة أعمدة قاعدة البيانات الهدف.");

  const statements = [
    // Remove self-references before replacing the chart of accounts. Deferring
    // foreign keys then permits parent accounts to be restored in any ID order.
    { sql: "PRAGMA defer_foreign_keys = ON", params: [] },
    { sql: "UPDATE accounts SET parent_id=NULL", params: [] },
    ...DELETE_ORDER.map((table) => ({ sql: "DELETE FROM " + table, params: [] }))
  ];

  const closedFiscalYearIds = [];
  for (const table of TRANSFER_TABLES) {
    const columns = tableColumns[table];
    if (!Array.isArray(columns) || !columns.length ||
        !columns.every((column) => typeof column === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(column))) {
      throw new Error("تعذر التحقق من أعمدة الجدول " + table + ".");
    }
    for (const row of pkg.tables[table]) {
      const keys = Object.keys(row);
      if (keys.length !== columns.length || columns.some((column) => !Object.hasOwn(row, column))) {
        throw new Error("أعمدة السجل في الجدول " + table + " لا تطابق مخطط قاعدة البيانات.");
      }
      const quoted = columns.map((column) => '"' + column + '"').join(",");
      const placeholders = columns.map(() => "?").join(",");
      const params = columns.map((column) => row[column] ?? null);
      // Closed periods reject posted journal inserts. Restore their rows as open
      // while importing the journals, then reapply the closed state at the end
      // of the same transaction so the source database's locks are preserved.
      if (table === "fiscal_years" && row.status === "closed") {
        const statusIndex = columns.indexOf("status");
        if (statusIndex < 0) throw new Error("سجل السنة المالية لا يحتوي حالة الإقفال.");
        params[statusIndex] = "open";
        closedFiscalYearIds.push(row.id);
      }
      statements.push({
        sql: "INSERT INTO " + table + " (" + quoted + ") VALUES (" + placeholders + ")",
        params
      });
    }
  }
  // Reapply closed states only after every journal header and line has been restored.
  for (const fiscalYearId of closedFiscalYearIds) {
    statements.push({
      sql: "UPDATE fiscal_years SET status='closed' WHERE id=?",
      params: [fiscalYearId]
    });
  }
  return statements;
}


// A compact non-cryptographic checksum detects accidental file damage. It is
// not an authenticity signature and must not be treated as tamper protection.
function stableStringify(value) {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (isRecord(value)) {
    return "{" + Object.keys(value).sort().map((key) =>
      JSON.stringify(key) + ":" + stableStringify(value[key])
    ).join(",") + "}";
  }
  return JSON.stringify(value);
}

function transferChecksum(payload) {
  const text = stableStringify(payload);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function validatePortableAccountingData(input) {
  const pkg = parsePortableTransferPackage(input);
  const accounts = pkg.tables.accounts.map((account) => ({
    code: account.code,
    name: account.name_ar,
    type: account.account_type,
    // Historical postings remain valid even if an account was later disabled.
    is_active: 1,
    is_postable: 1
  }));
  const accountById = new Map(pkg.tables.accounts.map((account) => [Number(account.id), account]));
  const linesByJournal = new Map();
  for (const line of pkg.tables.journal_lines) {
    const account = accountById.get(Number(line.account_id));
    if (!account) throw new Error("يوجد سطر قيد مرتبط بحساب غير موجود في ملف النقل.");
    const lines = linesByJournal.get(Number(line.journal_id)) || [];
    lines.push({
      accountCode: account.code,
      debit: line.debit,
      credit: line.credit,
      currency: line.currency_code,
      memo: line.memo
    });
    linesByJournal.set(Number(line.journal_id), lines);
  }

  const journalById = new Map(pkg.tables.journal_entries.map((entry) => [Number(entry.id), entry]));
  for (const entry of pkg.tables.journal_entries) {
    if (entry.status !== "posted") continue;
    const lines = linesByJournal.get(Number(entry.id)) || [];
    validateJournal({
      date: entry.entry_date,
      reference: entry.entry_no,
      memo: entry.memo,
      status: "posted",
      lines
    }, accounts);
  }

  for (const table of ["sales_invoices", "purchase_invoices", "sales_returns", "purchase_returns"]) {
    for (const document of pkg.tables[table]) {
      if (document.status === "posted") {
        const journal = journalById.get(Number(document.journal_id));
        if (!journal || journal.status !== "posted") {
          throw new Error("مستند مرحل في " + table + " لا يرتبط بقيد يومية مرحل.");
        }
      }
    }
  }
  const bankAccountById = new Map(pkg.tables.bank_accounts.map((bank) => [Number(bank.id), bank]));
  const journalLineById = new Map(pkg.tables.journal_lines.map((line) => [Number(line.id), line]));
  const reconciliationById = new Map(pkg.tables.bank_reconciliations.map((item) => [Number(item.id), item]));
  const validDate = (value) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + "T00:00:00Z");
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  const statementLinesByReconciliation = new Map();
  for (const line of pkg.tables.bank_reconciliation_lines) {
    const reconciliation = reconciliationById.get(Number(line.reconciliation_id));
    if (!reconciliation) throw new Error("حركة كشف البنك مرتبطة بتسوية غير موجودة.");
    if (!validDate(line.statement_date) || line.statement_date < reconciliation.period_start || line.statement_date > reconciliation.period_end) {
      throw new Error("تاريخ حركة كشف البنك خارج فترة التسوية أو غير صالح.");
    }
    if (!Number.isFinite(Number(line.amount)) || Math.abs(Number(line.amount)) < 0.000001) {
      throw new Error("تحتوي حركة كشف البنك على مبلغ غير صالح.");
    }
    const list = statementLinesByReconciliation.get(Number(line.reconciliation_id)) || [];
    list.push(line);
    statementLinesByReconciliation.set(Number(line.reconciliation_id), list);
    if (line.matched_journal_line_id !== null && line.matched_journal_line_id !== undefined) {
      const journalLine = journalLineById.get(Number(line.matched_journal_line_id));
      const bank = bankAccountById.get(Number(reconciliation.bank_account_id));
      const journal = journalLine && journalById.get(Number(journalLine.journal_id));
      if (!journalLine || !bank || !journal || journal.status !== "posted" ||
          Number(journalLine.account_id) !== Number(bank.account_id) ||
          journalLine.currency_code !== bank.currency_code ||
          Math.abs(Number(journalLine.debit) - Number(journalLine.credit) - Number(line.amount)) > 0.000001) {
        throw new Error("مطابقة كشف البنك لا تطابق سطر قيد مرحل للحساب والعملة والمبلغ نفسيهما.");
      }
      if (journal.entry_date < reconciliation.period_start || journal.entry_date > reconciliation.period_end) {
        const carry = pkg.tables.bank_reconciliation_outstanding.find((item) =>
          Number(item.journal_line_id) === Number(journalLine.id) &&
          Number(item.bank_account_id) === Number(reconciliation.bank_account_id) &&
          item.status === "cleared" &&
          Number(item.cleared_reconciliation_id) === Number(reconciliation.id)
        );
        const origin = carry && reconciliationById.get(Number(carry.origin_reconciliation_id));
        if (!origin || origin.period_end >= reconciliation.period_start || origin.period_end >= journal.entry_date) {
          throw new Error("تحتوي التسوية على مطابقة لحركة سابقة لم تكن معلقة من فترة أقدم.");
        }
      }
    } else if (reconciliation.status === "closed") {
      throw new Error("تسوية بنكية مقفلة تحتوي حركة كشف غير مطابقة.");
    }
  }

  for (const reconciliation of pkg.tables.bank_reconciliations) {
    if (!validDate(reconciliation.period_start) || !validDate(reconciliation.period_end) ||
        reconciliation.period_start > reconciliation.period_end) {
      throw new Error("فترة تسوية بنكية غير صالحة في ملف النقل.");
    }
    const bank = bankAccountById.get(Number(reconciliation.bank_account_id));
    if (!bank) throw new Error("تسوية بنكية مرتبطة بحساب بنك غير موجود.");
    if (reconciliation.status === "closed") {
      const lines = statementLinesByReconciliation.get(Number(reconciliation.id)) || [];
      if (!lines.length || lines.some((line) => !line.matched_journal_line_id)) {
        throw new Error("التسوية البنكية المقفلة لا تحتوي على مطابقة كاملة.");
      }
      const statementTotal = lines.reduce((sum, line) => sum + Number(line.amount), 0);
      if (Math.abs(Number(reconciliation.opening_balance) + statementTotal - Number(reconciliation.closing_balance)) > 0.01) {
        throw new Error("أرصدة كشف البنك لا تتطابق مع حركات التسوية المقفلة.");
      }
    }
  }

  for (const item of pkg.tables.bank_reconciliation_outstanding) {
    const bank = bankAccountById.get(Number(item.bank_account_id));
    const journalLine = journalLineById.get(Number(item.journal_line_id));
    const origin = reconciliationById.get(Number(item.origin_reconciliation_id));
    const journal = journalLine && journalById.get(Number(journalLine.journal_id));
    if (!bank || !journalLine || !origin || !journal || journal.status !== "posted" ||
        Number(origin.bank_account_id) !== Number(bank.id) ||
        Number(journalLine.account_id) !== Number(bank.account_id) ||
        journalLine.currency_code !== bank.currency_code ||
        journal.entry_date < origin.period_start || journal.entry_date > origin.period_end) {
      throw new Error("عنصر معلّق في تسوية البنك مرتبط ببيانات غير متطابقة.");
    }
    if (item.status === "cleared") {
      const cleared = reconciliationById.get(Number(item.cleared_reconciliation_id));
      const matched = pkg.tables.bank_reconciliation_lines.some((line) =>
        Number(line.reconciliation_id) === Number(item.cleared_reconciliation_id) &&
        Number(line.matched_journal_line_id) === Number(item.journal_line_id)
      );
      if (!cleared || Number(cleared.bank_account_id) !== Number(bank.id) ||
          cleared.period_start <= origin.period_end || !matched) {
        throw new Error("عنصر معلّق تم إقفاله دون مطابقة صحيحة في تسوية لاحقة.");
      }
    } else if (item.status !== "pending" || item.cleared_reconciliation_id !== null && item.cleared_reconciliation_id !== undefined) {
      throw new Error("حالة عنصر التسوية البنكية المعلّق غير صالحة.");
    }
  }
  return true;
}
