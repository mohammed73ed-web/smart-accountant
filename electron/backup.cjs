const fs = require("node:fs");
const path = require("node:path");

async function createVerifiedBackup({ database, destination, Database, verifyDatabase }) {
  if (!database || !database.open) throw new Error("قاعدة البيانات غير مفتوحة.");
  if (typeof destination !== "string" || !destination.trim()) throw new Error("مسار النسخة الاحتياطية غير صالح.");
  if (typeof Database !== "function" || typeof verifyDatabase !== "function") {
    throw new Error("إعدادات التحقق من النسخة الاحتياطية غير مكتملة.");
  }

  const target = path.resolve(destination);
  const source = database.name && database.name !== ":memory:" ? path.resolve(database.name) : null;
  if (source && source.toLowerCase() === target.toLowerCase()) {
    throw new Error("لا يمكن حفظ النسخة فوق ملف قاعدة البيانات النشط.");
  }
  if (fs.existsSync(target)) throw new Error("الملف المحدد موجود بالفعل؛ اختر اسماً آخر لحماية النسخة السابقة.");

  const temporary = target + ".tmp-" + process.pid + "-" + Date.now();
  let candidate;
  try {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await database.backup(temporary);
    candidate = new Database(temporary, { readonly: true, fileMustExist: true });
    verifyDatabase(candidate);
    candidate.close();
    candidate = null;
    await fs.promises.rename(temporary, target);
    return { filePath: target, bytes: fs.statSync(target).size };
  } catch (error) {
    if (candidate && candidate.open) candidate.close();
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    throw new Error("تعذر إنشاء نسخة احتياطية سليمة: " + (error.message || String(error)));
  }
}

module.exports = { createVerifiedBackup };
