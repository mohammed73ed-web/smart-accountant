const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");

let db;
function openDatabase() {
  const file = path.join(app.getPath("userData"), "onyx-smart-accounting.sqlite");
  db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  const schemaPath = path.join(__dirname, "../src/db/schema.sql");
  db.exec(fs.readFileSync(schemaPath, "utf8"));
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
    const integrity = candidate.pragma("integrity_check", { simple: true });
    const foreignKeys = candidate.pragma("foreign_key_check");
    if (integrity !== "ok" || foreignKeys.length) throw new Error("ملف النسخة الاحتياطية غير سليم.");
  } finally {
    candidate.close();
  }
  const target = path.join(app.getPath("userData"), "onyx-smart-accounting.sqlite");
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  fs.copyFileSync(result.filePaths[0], target);
  openDatabase();
  return { canceled: false };
});
app.whenReady().then(() => {
  openDatabase();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("before-quit", () => { if (db && db.open) db.close(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });