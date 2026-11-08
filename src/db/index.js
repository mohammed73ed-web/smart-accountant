import { Capacitor } from "@capacitor/core";
import { CapacitorSQLite, SQLiteConnection } from "@capacitor-community/sqlite";
import schema from "./schema.sql?raw";

let nativeDb;
const electronDb = () => window.onyx && window.onyx.db;

export async function initDatabase() {
  if (electronDb()) return true;
  if (!Capacitor.isNativePlatform()) {
    throw new Error("قاعدة SQLite تعمل داخل تطبيق Windows أو Android، وليس في المتصفح.");
  }
  const sqlite = new SQLiteConnection(CapacitorSQLite);
  const consistency = await sqlite.checkConnectionsConsistency();
  const existing = await sqlite.isConnection("onyx", false);
  nativeDb = consistency.result && existing.result
    ? await sqlite.retrieveConnection("onyx", false)
    : await sqlite.createConnection("onyx", false, "no-encryption", 1, false);
  await nativeDb.open();
  await nativeDb.execute(schema);
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
  throw new Error("تصدير ملف SQLite على Android يحتاج واجهة مشاركة الملفات؛ لم يتم تفعيلها بعد.");
}
export async function restoreDatabase() {
  if (electronDb()) return electronDb().restore();
  throw new Error("استعادة ملف SQLite على Android تحتاج واجهة اختيار الملفات؛ لم يتم تفعيلها بعد.");
}