const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { createVerifiedBackup } = require("../electron/backup.cjs");

function verifyDatabase(db) {
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='records'").get());
}

test("verified backup is created as a readable SQLite copy", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "onex-backup-"));
  const sourcePath = path.join(folder, "source.sqlite");
  const destination = path.join(folder, "backup.sqlite");
  const db = new Database(sourcePath);
  db.exec("CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO records(value) VALUES('ONEX');");
  try {
    const result = await createVerifiedBackup({ database: db, destination, Database, verifyDatabase });
    assert.equal(fs.existsSync(destination), true);
    assert.ok(result.bytes > 0);
    const copy = new Database(destination, { readonly: true });
    assert.equal(copy.prepare("SELECT value FROM records").get().value, "ONEX");
    copy.close();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM records").get().n, 1);
  } finally {
    db.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("backup refuses to overwrite an existing file or the active database", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "onex-backup-"));
  const sourcePath = path.join(folder, "source.sqlite");
  const destination = path.join(folder, "backup.sqlite");
  const db = new Database(sourcePath);
  db.exec("CREATE TABLE records(id INTEGER PRIMARY KEY);");
  fs.writeFileSync(destination, "keep");
  try {
    await assert.rejects(
      () => createVerifiedBackup({ database: db, destination, Database, verifyDatabase }),
      /موجود بالفعل/
    );
    await assert.rejects(
      () => createVerifiedBackup({ database: db, destination: sourcePath, Database, verifyDatabase }),
      /قاعدة البيانات النشط/
    );
    assert.equal(fs.readFileSync(destination, "utf8"), "keep");
  } finally {
    db.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("backup rejects a database that fails integrity verification", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "onex-backup-"));
  const sourcePath = path.join(folder, "source.sqlite");
  const destination = path.join(folder, "backup.sqlite");
  const db = new Database(sourcePath);
  db.exec("CREATE TABLE records(id INTEGER PRIMARY KEY);");
  try {
    await assert.rejects(
      () => createVerifiedBackup({
        database: db, destination, Database,
        verifyDatabase: () => { throw new Error("invalid schema"); }
      }),
      /invalid schema/
    );
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.readdirSync(folder).some((name) => name.includes(".tmp-")), false);
  } finally {
    db.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
