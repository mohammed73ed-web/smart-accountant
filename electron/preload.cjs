const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("onyx", {
  db: {
    query: (sql, params = []) => ipcRenderer.invoke("onyx:query", sql, params),
    run: (sql, params = []) => ipcRenderer.invoke("onyx:run", sql, params),
    transaction: (statements) => ipcRenderer.invoke("onyx:transaction", statements),
    backup: () => ipcRenderer.invoke("onyx:backup"),
    cloudBackup: () => ipcRenderer.invoke("onyx:cloud-backup"),
    restore: () => ipcRenderer.invoke("onyx:restore")
  }
});