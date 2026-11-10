export const PORTABLE_TRANSFER_FORMAT = "ONYX-SMART-ACCOUNTING-TRANSFER";
export const PORTABLE_TRANSFER_VERSION = 1;
export const PORTABLE_SCHEMA_VERSION = 5;

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
  "sales_return_lines",
  "purchase_return_lines",
  "sales_invoice_lines",
  "purchase_invoice_lines",
  "journal_lines",
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
  return {
    format: PORTABLE_TRANSFER_FORMAT,
    version: PORTABLE_TRANSFER_VERSION,
    schemaVersion: PORTABLE_SCHEMA_VERSION,
    generatedAt,
    tables: Object.fromEntries(TRANSFER_TABLES.map((table) => [table, tables[table]]))
  };
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
      statements.push({
        sql: "INSERT INTO " + table + " (" + quoted + ") VALUES (" + placeholders + ")",
        params: columns.map((column) => row[column] ?? null)
      });
    }
  }
  return statements;
}
