/**
 * Electron main process
 *
 * Starts the ARM emulator + RISC OS SWI layer.
 * Each RISC OS program window becomes a real native BrowserWindow.
 */

import { app, BrowserWindow, ipcMain, Menu, dialog } from "electron";
import path from "path";
import fs from "fs";
import { ArchimedesMachine } from "@theprogramminggiantpanda/arm-emulator";
import { SwiDispatcher } from "@theprogramminggiantpanda/risc-os";
import { NativeWimpHost } from "./native-wimp-host.js";
import { NodeFsHost } from "./node-fs-host.js";
import { buildAppMenu } from "./menu.js";
import type { MachineConfig } from "@theprogramminggiantpanda/shared";
import { IPC } from "@theprogramminggiantpanda/shared";

const isDev = !app.isPackaged;

let machine:    ArchimedesMachine | null = null;
let dispatcher: SwiDispatcher    | null = null;
let wimpHost:   NativeWimpHost   | null = null;

const defaultConfig: MachineConfig = {
  model:           "A310",
  ramSize:         1 * 1024 * 1024,
  cpuVariant:      "ARM2",
  speedMultiplier: 1.0,
};
let config: MachineConfig = { ...defaultConfig };

// ---------------------------------------------------------------------------
// Launcher window (ROM picker + status)
// ---------------------------------------------------------------------------
function createLauncherWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width:  560,
    height: 360,
    title:  "Acorn Desktop",
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    win.loadURL("http://localhost:5173/index.html");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(__dirname, "../../renderer/index.html"));
  }

  Menu.setApplicationMenu(buildAppMenu(win, { onLoadROM, onReset, onSetSpeed, onSetCPU }));
  return win;
}

let launcherWindow: BrowserWindow | null = null;

// ---------------------------------------------------------------------------
// Machine lifecycle
// ---------------------------------------------------------------------------
function startMachine(romData: Uint8Array): void {
  machine?.stop();

  const fsRoot = path.join(app.getPath("documents"), "RISCOS");
  machine    = new ArchimedesMachine(config);
  wimpHost   = new NativeWimpHost();
  dispatcher = new SwiDispatcher(machine, wimpHost, {
    onOutput: (text) => launcherWindow?.webContents.send("console-output", text),
    fs: new NodeFsHost(fsRoot),
  });

  machine.loadROM(romData);
  machine.start();

  launcherWindow?.webContents.send("machine-started", { model: config.model });
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
async function onLoadROM(): Promise<void> {
  if (!launcherWindow) return;
  const result = await dialog.showOpenDialog(launcherWindow, {
    title: "Load RISC OS ROM",
    filters: [
      { name: "ROM Images", extensions: ["rom", "bin", "img"] },
      { name: "All Files",  extensions: ["*"] },
    ],
    properties: ["openFile"],
  });
  if (result.canceled || !result.filePaths[0]) return;
  try {
    const data = fs.readFileSync(result.filePaths[0]);
    startMachine(new Uint8Array(data));
    launcherWindow?.webContents.send(IPC.ROM_LOADED, {
      path: result.filePaths[0],
      sizeBytes: data.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    launcherWindow?.webContents.send(IPC.ERROR, { message: msg, fatal: false });
  }
}

function onReset(): void {
  machine?.reset();
}

function onSetSpeed(mult: number): void {
  config = { ...config, speedMultiplier: mult };
}

function onSetCPU(variant: "ARM2" | "ARM3"): void {
  config = { ...config, cpuVariant: variant };
}

// Drag-and-drop from renderer
ipcMain.handle(IPC.DRAG_FILE, async (_ev, filePath: string) => {
  if (!fs.existsSync(filePath)) return;
  const ext = path.extname(filePath).toLowerCase();
  if ([".rom", ".bin", ".img"].includes(ext)) {
    const data = fs.readFileSync(filePath);
    startMachine(new Uint8Array(data));
  }
});

ipcMain.handle(IPC.LOAD_ROM,  async (_ev, payload: { path: string }) => {
  try {
    const data = fs.readFileSync(payload.path);
    startMachine(new Uint8Array(data));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// ---------------------------------------------------------------------------
// Auto-load ROM from assets/roms/ on startup
// ---------------------------------------------------------------------------
function tryAutoLoadROM(): void {
  const romsDir = path.join(app.getAppPath(), "assets", "roms");

  let files: string[] = [];
  try {
    files = fs.readdirSync(romsDir);
  } catch { /* directory missing — fall through to error */ }

  const romFile = files.find(f => /\.(rom|bin|img)$/i.test(f));
  if (!romFile) {
    dialog.showErrorBox(
      "No ROM found",
      `Place a RISC OS ROM image (.rom, .bin, or .img) in:\n\n${romsDir}`,
    );
    app.quit();
    return;
  }

  try {
    const data = fs.readFileSync(path.join(romsDir, romFile));
    startMachine(new Uint8Array(data));
    launcherWindow?.webContents.send(IPC.ROM_LOADED, {
      path: path.join(romsDir, romFile),
      sizeBytes: data.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    dialog.showErrorBox("Failed to load ROM", msg);
    app.quit();
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  launcherWindow = createLauncherWindow();
  launcherWindow.on("closed", () => { launcherWindow = null; });

  // Delay auto-load until the renderer is ready to receive IPC events
  launcherWindow.webContents.once("did-finish-load", tryAutoLoadROM);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      launcherWindow = createLauncherWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    machine?.stop();
    app.quit();
  }
});
