const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");

let db;
const REQUIRED_TABLES = [
  "accounts", "currencies", "exchange_rates", "fiscal_years", "parties", "employees",
  "warehouses", "products", "journal_entries", "journal_lines",
  "sales_invoices", "sales_invoice_lines", "purchase_invoices", "purchase_invoice_lines",
  "sales_returns", "sales_return_lines", "purchase_returns", "purchase_return_lines",
  "stock_movements", "cash_boxes", "bank_accounts", "cash_transactions", "cash_transfers",
  "expenses", "revenues", "tax_rates", "fixed_assets", "depreciation_runs",
  "debt_installments", "audit_log", "transfer_packages", "backup_history"
];
function verifyDatabase(connection) {
  const integrity = connection.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") throw new Error("فشل فحص سلامة قاعدة البيانات: " + integrity);
  const foreignKeys = connection.pragma("foreign_key_check");
  if (foreignKeys.length) throw new Error("تحتوي قاعدة البيانات على مراجع خارجية غير سليمة.");
  const tables = new Set(connection.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  const missing = REQUIRED_TABLES.filter((name) => !tables.has(name));
  if (missing.length) throw new Error("قاعدة البيانات تفتقد جداول ERP: " + missing.join("، "));
}
function openDatabase() {
  const file = path.join(app.getPath("userData"), "onyx-smart-accounting.sqlite");
  db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  const schemaPath = path.join(__dirname, "../src/db/schema.sql");
  db.exec(fs.readFileSync(schemaPath, "utf8"));
  verifyDatabase(db);
}
function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 640,
    title: "ONYX Smart Accounting",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, "../dist/index.html"));
}
ipcMain.handle("onyx:query", (_event, sql, params = []) => db.prepare(sql).all(...params));
ipcMain.handle("onyx:run", (_event, sql, params = []) => {
  const result = db.prepare(sql).run(...params);
  return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
});
ipcMain.handle("onyx:transaction", (_event, statements) => {
  const execute = db.transaction((items) => items.map((item) => {
    const result = db.prepare(item.sql).run(...(item.params || []));
    return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
  }));
  return execute(statements);
});
ipcMain.handle("onyx:backup", async () => {
  const result = await dialog.showSaveDialog({
    title: "حفظ نسخة احتياطية",
    defaultPath: "ONYX-backup.sqlite",
    filters: [{ name: "SQLite database", extensions: ["sqlite", "db"] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await db.backup(result.filePath);
  return { canceled: false, filePath: result.filePath };
});
ipcMain.handle("onyx:restore", async () => {
  const result = await dialog.showOpenDialog({
    title: "استعادة نسخة احتياطية",
    properties: ["openFile"],
    filters: [{ name: "SQLite database", extensions: ["sqlite", "db"] }]
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const candidate = new Database(result.filePaths[0], { readonly: true, fileMustExist: true });
  try {
    verifyDatabase(candidate);
  } finally {
    candidate.close();
  }

  const target = path.join(app.getPath("userData"), "onyx-smart-accounting.sqlite");
  const suffix = ".restore-" + Date.now();
  const staged = target + suffix + ".tmp";
  const rollback = target + suffix + ".previous";
  fs.copyFileSync(result.filePaths[0], staged);
  const stagedDb = new Database(staged, { readonly: true, fileMustExist: true });
  try {
    verifyDatabase(stagedDb);
  } finally {
    stagedDb.close();
  }

  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  let movedOld = false;
  let movedNew = false;
  try {
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = target + suffix;
      if (fs.existsSync(sidecar)) fs.rmSync(sidecar);
    }
    fs.renameSync(target, rollback);
    movedOld = true;
    fs.renameSync(staged, target);
    movedNew = true;
    openDatabase();
    fs.rmSync(rollback, { force: true });
    return { canceled: false };
  } catch (error) {
    try {
      if (db && db.open) db.close();
      if (movedNew && fs.existsSync(target)) fs.rmSync(target);
      if (movedOld && fs.existsSync(rollback)) fs.renameSync(rollback, target);
      if (!db || !db.open) openDatabase();
    } catch (rollbackError) {
      throw new Error("فشلت الاستعادة وتعذر إعادة قاعدة البيانات السابقة: " + (rollbackError.message || String(rollbackError)));
    }
    throw new Error("تعذر تطبيق النسخة الاحتياطية؛ أُعيدت قاعدة البيانات السابقة. السبب: " + (error.message || String(error)));
  } finally {
    if (fs.existsSync(staged)) fs.rmSync(staged);
  }
});
app.whenReady().then(() => {
  openDatabase();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("before-quit", () => { if (db && db.open) db.close(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });