import { Capacitor } from "@capacitor/core";
import { CapacitorSQLite, SQLiteConnection } from "@capacitor-community/sqlite";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import schema from "./schema.sql?raw";

const DATABASE_NAME = "onyx";
const DATABASE_VERSION = 4;
const REQUIRED_TABLES = [
  "accounts", "currencies", "exchange_rates", "fiscal_years", "parties", "employees",
  "warehouses", "products", "journal_entries", "journal_lines",
  "sales_invoices", "sales_invoice_lines", "purchase_invoices", "purchase_invoice_lines",
  "sales_returns", "sales_return_lines", "purchase_returns", "purchase_return_lines",
  "stock_movements", "cash_boxes", "bank_accounts", "cash_transactions", "cash_transfers",
  "expenses", "revenues", "tax_rates", "fixed_assets", "depreciation_runs",
  "debt_installments", "audit_log", "transfer_packages", "backup_history"
];

let nativeDb;
let sqliteConnection;
const electronDb = () => window.onyx && window.onyx.db;

async function openNativeDatabase() {
  nativeDb = await sqliteConnection.createConnection(
    DATABASE_NAME, false, "no-encryption", DATABASE_VERSION, false
  );
  await nativeDb.open();
  await nativeDb.execute("PRAGMA foreign_keys = ON;");
  await nativeDb.execute(schema);
  await nativeDb.execute("PRAGMA foreign_keys = ON;");
  return nativeDb;
}

async function verifyNativeDatabase() {
  const integrity = await nativeDb.query("PRAGMA integrity_check;");
  const integrityValue = integrity.values?.[0]?.integrity_check;
  if (integrityValue !== "ok") {
    throw new Error("فشل فحص سلامة قاعدة البيانات: " + String(integrityValue || "نتيجة غير معروفة"));
  }

  const foreignKeys = await nativeDb.query("PRAGMA foreign_key_check;");
  if ((foreignKeys.values || []).length) {
    throw new Error("تحتوي النسخة على مراجع مرتبطة غير سليمة؛ أُوقفت الاستعادة لحماية البيانات.");
  }

  const tableResult = await nativeDb.query("SELECT name FROM sqlite_master WHERE type='table';");
  const tableNames = new Set((tableResult.values || []).map((row) => row.name));
  const missing = REQUIRED_TABLES.filter((name) => !tableNames.has(name));
  if (missing.length) {
    throw new Error("النسخة لا تحتوي جداول ERP الأساسية: " + missing.join("، "));
  }
}

function exportedJson(exportResult) {
  const payload = exportResult?.export ?? exportResult;
  if (!payload) throw new Error("لم تُرجع قاعدة البيانات محتوى النسخة الاحتياطية.");
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

async function closeNativeDatabase() {
  try {
    await sqliteConnection.closeConnection(DATABASE_NAME);
  } finally {
    nativeDb = null;
  }
}

export async function initDatabase() {
  if (electronDb()) return true;
  if (!Capacitor.isNativePlatform()) {
    throw new Error("قاعدة SQLite تعمل داخل تطبيق Windows أو Android، وليس في المتصفح.");
  }
  sqliteConnection = new SQLiteConnection(CapacitorSQLite);
  const consistency = await sqliteConnection.checkConnectionsConsistency();
  const existing = await sqliteConnection.isConnection(DATABASE_NAME, false);
  if (consistency.result && existing.result) {
    nativeDb = await sqliteConnection.retrieveConnection(DATABASE_NAME, false);
    await nativeDb.open();
    await nativeDb.execute("PRAGMA foreign_keys = ON;");
    await nativeDb.execute(schema);
  } else {
    await openNativeDatabase();
  }
  await verifyNativeDatabase();
  return true;
}

export async function query(sql, params = []) {
  if (electronDb()) return electronDb().query(sql, params);
  if (!nativeDb) throw new Error("قاعدة البيانات لم تفتح بعد.");
  const result = await nativeDb.query(sql, params);
  return result.values || [];
}

export async function run(sql, params = []) {
  if (electronDb()) return electronDb().run(sql, params);
  if (!nativeDb) throw new Error("قاعدة البيانات لم تفتح بعد.");
  return nativeDb.run(sql, params);
}

export async function transaction(statements) {
  if (electronDb()) return electronDb().transaction(statements);
  if (!nativeDb) throw new Error("قاعدة البيانات لم تفتح بعد.");
  await nativeDb.beginTransaction();
  try {
    const results = [];
    for (const item of statements) results.push(await nativeDb.run(item.sql, item.params || []));
    await nativeDb.commitTransaction();
    return results;
  } catch (error) {
    await nativeDb.rollbackTransaction();
    throw error;
  }
}

export async function backupDatabase() {
  if (electronDb()) return electronDb().backup();
  if (!nativeDb || !sqliteConnection) throw new Error("قاعدة البيانات لم تفتح بعد.");

  const backup = await nativeDb.exportToJson("full");
  const json = exportedJson(backup);
  const validation = await sqliteConnection.isJsonValid(json);
  if (!validation.result) throw new Error("تعذر التحقق من بنية النسخة الاحتياطية.");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = "ONYX-Smart-Accounting-" + stamp + ".json";
  // Keep a persistent app-documents copy; Cache may be purged by Android.
  const saved = await Filesystem.writeFile({
    path: "ONYX-Backups/" + fileName,
    data: json,
    directory: Directory.Documents,
    encoding: Encoding.UTF8,
    recursive: true
  });
  await Share.share({
    title: "نسخة ONYX Smart Accounting الاحتياطية",
    text: "حُفظت نسخة دائمة داخل مستندات التطبيق. اختر تطبيق الملفات لحفظ نسخة إضافية في التنزيلات أو بطاقة الذاكرة إن كانت متاحة.",
    url: saved.uri,
    dialogTitle: "حفظ أو مشاركة نسخة ONYX الاحتياطية"
  });
  return { canceled: false, filePath: saved.uri, format: "json", directory: "Documents/ONYX-Backups" };
}

export async function restoreDatabase(file) {
  if (electronDb()) return electronDb().restore();
  if (!nativeDb || !sqliteConnection) throw new Error("قاعدة البيانات لم تفتح بعد.");
  if (!file || typeof file.text !== "function") {
    throw new Error("اختر ملف نسخة ONYX الاحتياطية بصيغة JSON أولاً.");
  }

  let incoming;
  try {
    incoming = JSON.parse(await file.text());
  } catch {
    throw new Error("ملف النسخة غير صالح أو ليس ملف JSON.");
  }
  const json = exportedJson(incoming);
  const validation = await sqliteConnection.isJsonValid(json);
  if (!validation.result) throw new Error("ملف النسخة لا يتوافق مع تنسيق قاعدة بيانات ONYX.");

  const previous = exportedJson(await nativeDb.exportToJson("full"));
  await closeNativeDatabase();
  try {
    await sqliteConnection.importFromJson(json);
    await openNativeDatabase();
    await verifyNativeDatabase();
    return { canceled: false, format: "json" };
  } catch (error) {
    try {
      await closeNativeDatabase();
    } catch {
      nativeDb = null;
    }
    try {
      await sqliteConnection.importFromJson(previous);
      await openNativeDatabase();
      await verifyNativeDatabase();
    } catch (rollbackError) {
      throw new Error(
        "فشلت الاستعادة (" + (error.message || String(error)) +
        ") وتعذر أيضاً استرجاع قاعدة البيانات السابقة (" +
        (rollbackError.message || String(rollbackError)) + "). أوقف استخدام التطبيق واحتفظ بملف النسخة الأصلي."
      );
    }
    throw new Error("أُلغيت الاستعادة وأُعيدت قاعدة البيانات السابقة دون تغيير. السبب: " + (error.message || String(error)));
  }
}
