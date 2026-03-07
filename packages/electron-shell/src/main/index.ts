/**
 * Electron main process entry point
 */
import { app, BrowserWindow, ipcMain, Menu, dialog } from "electron";
import path from "path";
import fs from "fs";
import { buildMenu } from "./menu.js";
import { IPC } from "@acorn/shared";
import type { RomLoadedPayload, DiskLoadedPayload } from "@acorn/shared";

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 800,
    height: 640,
    minWidth: 640,
    minHeight: 520,
    title: "Acorn Desktop",
    backgroundColor: "#1a1a1a",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    // Show native frame with title bar
    frame: true,
    show: false,
  });

  // Build and apply native menu
  const menu = buildMenu(win);
  Menu.setApplicationMenu(menu);

  // Load renderer
  if (isDev) {
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  win.once("ready-to-show", () => win.show());

  win.on("closed", () => { mainWindow = null; });

  return win;
}

// ---------------------------------------------------------------------------
// IPC handlers (renderer → main)
// ---------------------------------------------------------------------------

/** Load ROM file and send its contents to renderer */
ipcMain.handle(IPC.LOAD_ROM, async (_event, payload: { path: string }) => {
  try {
    const data = fs.readFileSync(payload.path);
    const result: RomLoadedPayload = { path: payload.path, sizeBytes: data.length };
    mainWindow?.webContents.send(IPC.ROM_LOADED, result, data.buffer);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    mainWindow?.webContents.send(IPC.ERROR, { message: msg, fatal: false });
    return { ok: false, error: msg };
  }
});

/** Load disk image and send its contents to renderer */
ipcMain.handle(IPC.LOAD_DISK, async (_event, payload: { path: string }) => {
  try {
    const data = fs.readFileSync(payload.path);
    const result: DiskLoadedPayload = {
      path: payload.path,
      name: path.basename(payload.path),
      sizeBytes: data.length,
    };
    mainWindow?.webContents.send(IPC.DISK_LOADED, result, data.buffer);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    mainWindow?.webContents.send(IPC.ERROR, { message: msg, fatal: false });
    return { ok: false, error: msg };
  }
});

/** Handle drag-and-drop file from renderer */
ipcMain.handle(IPC.DRAG_FILE, async (_event, filePath: string) => {
  if (!fs.existsSync(filePath)) return { ok: false, error: "File not found" };
  const ext = path.extname(filePath).toLowerCase();
  const romExts    = [".rom", ".bin", ".img", ".arc"];
  const diskExts   = [".adf", ".adl", ".hdf", ".vhd"];

  if (romExts.includes(ext)) {
    return ipcMain.emit(IPC.LOAD_ROM, null, { path: filePath });
  }
  if (diskExts.includes(ext)) {
    return ipcMain.emit(IPC.LOAD_DISK, null, { path: filePath });
  }
  return { ok: false, error: `Unknown file type: ${ext}` };
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  mainWindow = createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
