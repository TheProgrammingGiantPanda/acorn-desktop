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
import { SwiDispatcher, ObeyInterpreter, SpritePool } from "@theprogramminggiantpanda/risc-os";
import { NativeWimpHost } from "./native-wimp-host.js";
import { NodeFsHost } from "./node-fs-host.js";
import { buildAppMenu } from "./menu.js";
import type { MachineConfig, AppEntry } from "@theprogramminggiantpanda/shared";
import { IPC, Logger } from "@theprogramminggiantpanda/shared";

const isDev = !app.isPackaged;
const logger = new Logger(isDev ? 'debug' : 'error');

// ---------------------------------------------------------------------------
// Asset path resolution
// In dev, `electron .` runs from packages/electron-shell/ but assets/ lives
// at the monorepo root (two levels up).  In a packaged app, assets are
// bundled inside app.getAppPath().
// ---------------------------------------------------------------------------
function resolveAssets(...parts: string[]): string {
  const localPath = path.join(app.getAppPath(), ...parts);
  if (fs.existsSync(localPath)) return localPath;
  return path.join(app.getAppPath(), "..", "..", ...parts);
}

let machine:    ArchimedesMachine | null = null;
let dispatcher: SwiDispatcher    | null = null;
let wimpHost:   NativeWimpHost   | null = null;

// ---------------------------------------------------------------------------
// CLI argument: first non-flag positional arg after the Electron app path
// e.g.  electron . ./assets/programs/!Paint
// ---------------------------------------------------------------------------
function parseAppArg(): string | undefined {
  // process.argv: [electron-binary, app-entry, ...user-args]
  return process.argv.slice(2).find(a => !a.startsWith("-"));
}

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

let launcherWindow:        BrowserWindow | null = null;
let programsBrowserWindow: BrowserWindow | null = null;

// ---------------------------------------------------------------------------
// Boot sequence: run !Boot for every app in assets/programs/
// ---------------------------------------------------------------------------
function bootAllApps(): void {
  if (!dispatcher) return;

  const programsDir = resolveAssets("assets", "programs");
  let entries: string[];
  try {
    entries = fs.readdirSync(programsDir);
  } catch {
    return; // no programs directory — silently skip
  }

  const appDirs = entries
    .filter(name => name.startsWith("!"))
    .filter(name => {
      try { return fs.statSync(path.join(programsDir, name)).isDirectory(); }
      catch { return false; }
    })
    .sort();

  if (appDirs.length === 0) return;

  const programsFs = new NodeFsHost(programsDir);
  const onOutput = (text: string) => launcherWindow?.webContents.send("console-output", text);

  for (const appName of appDirs) {
    const bootPath   = `$.${appName}.!Boot`;
    const spritePath = `$.${appName}.!Sprites`;

    if (programsFs.stat(bootPath) !== null) {
      const obey = new ObeyInterpreter(programsFs, dispatcher.sysvar, {
        onOutput,
        spritePool: dispatcher.spriteAreas.system,
        // onRunBinary intentionally omitted: !Boot scripts almost never run
        // ARM binaries directly, and there is no machine context to load into
        // at this point in the boot sequence.
      });
      obey.runFile(bootPath);
    } else if (programsFs.stat(spritePath) !== null) {
      // No !Boot but has !Sprites — load sprites directly into the system area
      try {
        dispatcher.spriteAreas.system.loadArea(programsFs.readFile(spritePath));
      } catch { /* ignore unreadable sprite files */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Programs browser window
// ---------------------------------------------------------------------------
function createProgramsBrowserWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width:       480,
    height:      400,
    minWidth:    320,
    minHeight:   200,
    title:       "Programs",
    webPreferences: {
      preload: path.join(__dirname, "../preload/programs-browser-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    win.loadURL("http://localhost:5173/programs-browser.html");
  } else {
    win.loadFile(path.join(__dirname, "../../renderer/programs-browser.html"));
  }

  win.on("closed", () => { programsBrowserWindow = null; });
  return win;
}

/** Scan assets/programs/ and build the app list with decoded sprites. */
function listApps(): AppEntry[] {
  const programsDir = resolveAssets("assets", "programs");
  let entries: string[] = [];
  try { entries = fs.readdirSync(programsDir); } catch { return []; }

  return entries
    .filter(name => name.startsWith("!"))
    .filter(name => {
      try { return fs.statSync(path.join(programsDir, name)).isDirectory(); }
      catch { return false; }
    })
    .sort()
    .map((name): AppEntry => {
      const displayName = name.slice(1); // strip leading "!"
      const spriteName  = displayName.toLowerCase();
      const spritePath  = path.join(programsDir, name, "!Sprites");
      let sprite: AppEntry["sprite"] | undefined;

      try {
        const data = fs.readFileSync(spritePath);
        const pool = new SpritePool();
        pool.loadArea(new Uint8Array(data));

        // Try "!name" first (RISC OS convention), then plain "name"
        const found = pool.get(`!${spriteName}`) ?? pool.get(spriteName);
        if (found) {
          sprite = {
            rgba:   Array.from(found.rgba),
            width:  found.width,
            height: found.height,
          };
        }
      } catch { /* no !Sprites or parse error — use generic icon */ }

      return { name, displayName, sprite };
    });
}

// ---------------------------------------------------------------------------
// Machine lifecycle
// ---------------------------------------------------------------------------
function startMachine(romData: Uint8Array, appHostPath?: string): void {
  machine?.stop();

  // When launching a specific app, root the FS at the app's parent directory
  // so the app dir is accessible as $.!AppName inside RISC OS.
  // In programs-browser mode (no appHostPath), root at assets/programs/ so
  // dispatcher.obey.runFile("$.!AppName.!Run") resolves correctly.
  const fsRoot = appHostPath
    ? path.dirname(path.resolve(appHostPath))
    : resolveAssets("assets", "programs");

  const nodeFs = new NodeFsHost(fsRoot);

  machine    = new ArchimedesMachine(config, logger);
  wimpHost   = new NativeWimpHost();
  dispatcher = new SwiDispatcher(machine, wimpHost, {
    onOutput: (text) => {
      logger.debug(`[RISC OS] ${text}`);
      launcherWindow?.webContents.send("console-output", text);
    },
    fs: nodeFs,
    onRunBinary: (riscosPath) => {
      logger.debug(`[onRunBinary] loading: ${riscosPath}`);
      try {
        const data = nodeFs.readFile(riscosPath);
        logger.debug(`[onRunBinary] binary size: ${data.length} bytes — starting app`);
        // SWI 0xADBEEF is the AIF "not yet decompressed" guard — halt cleanly.
        machine!.cpu.swiHandlers.set(0xADBEEF, () => {
          logger.debug(`[AIF] decompressor guard SWI — binary not decompressed correctly`);
          machine!.cpu.halted = true;
        });
        machine!.startApp(data);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[onRunBinary] failed: ${msg}`);
        launcherWindow?.webContents.send(IPC.ERROR, { message: `Cannot run ${riscosPath}: ${msg}`, fatal: false });
      }
    },
  });

  machine.loadROM(romData);
  machine.bootROM();

  bootAllApps();

  if (appHostPath) {
    launchApp(nodeFs, appHostPath);
  } else {
    // No specific app — open the programs browser
    if (!programsBrowserWindow || programsBrowserWindow.isDestroyed()) {
      programsBrowserWindow = createProgramsBrowserWindow();
    } else {
      programsBrowserWindow.focus();
    }
  }

  launcherWindow?.webContents.send("machine-started", { model: config.model });
}

// ---------------------------------------------------------------------------
// App launch (CLI)
// ---------------------------------------------------------------------------
function launchApp(nodeFs: NodeFsHost, hostPath: string): void {
  const resolved = path.resolve(hostPath);

  if (!fs.existsSync(resolved)) {
    launcherWindow?.webContents.send(IPC.ERROR, {
      message: `App path not found: ${hostPath}`,
      fatal: false,
    });
    return;
  }

  const stat = fs.statSync(resolved);

  if (stat.isDirectory()) {
    const appName   = path.basename(resolved);          // e.g. "!Paint"

    if (!appName.startsWith("!")) {
      launcherWindow?.webContents.send(IPC.ERROR, {
        message: `App directory name must start with '!': ${appName}`,
        fatal: false,
      });
      return;
    }

    const runScript = `$.${appName}.!Run`;              // e.g. "$.!Paint.!Run"

    if (nodeFs.stat(runScript) !== null) {
      // Normal RISC OS app: run the !Run Obey script
      dispatcher!.obey.runFile(runScript);
    } else {
      // No !Run — try !RunImage as a raw binary
      const riscosRunImage = `$.${appName}.!RunImage`;
      if (nodeFs.stat(riscosRunImage) !== null) {
        machine!.loadProgram(nodeFs.readFile(riscosRunImage));
      } else {
        launcherWindow?.webContents.send(IPC.ERROR, {
          message: `No !Run or !RunImage found in: ${hostPath}`,
          fatal: false,
        });
      }
    }
  } else {
    // Raw binary file — load it directly at 0x8000
    const data = fs.readFileSync(resolved);
    machine!.loadProgram(new Uint8Array(data));
  }
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
// Programs browser IPC
// ---------------------------------------------------------------------------
ipcMain.handle(IPC.BROWSER_LIST_APPS, (): AppEntry[] => {
  try {
    return listApps();
  } catch (err) {
    logger.error(`[browser:list-apps] ${err}`);
    return [];
  }
});

ipcMain.handle(IPC.BROWSER_LAUNCH_APP, (_ev, appName: string) => {
  logger.debug(`[launch] ${appName}`);
  const programsDir = resolveAssets("assets", "programs");
  const appHostPath = path.join(programsDir, appName);

  if (!fs.existsSync(appHostPath)) { logger.error(`[launch] path not found: ${appHostPath}`); return; }
  if (!dispatcher) { logger.error(`[launch] dispatcher not ready`); return; }

  const programsFs = new NodeFsHost(programsDir);
  const runScript  = `$.${appName}.!Run`;

  if (programsFs.stat(runScript) !== null) {
    logger.debug(`[launch] running obey: ${runScript}`);
    dispatcher.obey.runFile(runScript);
  } else {
    const runImage = `$.${appName}.!RunImage`;
    logger.debug(`[launch] no !Run, trying binary: ${runImage}`);
    if (programsFs.stat(runImage) !== null) {
      const data = programsFs.readFile(runImage);
      machine!.startApp(data);
    } else {
      logger.error(`[launch] no !Run or !RunImage found in ${appName}`);
    }
  }
});

ipcMain.handle(IPC.BROWSER_INSTALL_APP, async (_ev, hostPath: string): Promise<{ ok: boolean; error?: string }> => {
  try {
    const name = path.basename(hostPath);
    if (!name.startsWith("!")) {
      return { ok: false, error: `Directory name must start with '!': ${name}` };
    }

    const stat = fs.statSync(hostPath);
    if (!stat.isDirectory()) {
      return { ok: false, error: "Only !App directories can be installed" };
    }

    const programsDir = resolveAssets("assets", "programs");
    const destDir     = path.join(programsDir, name);
    fs.cpSync(hostPath, destDir, { recursive: true });

    // Run !Boot for the newly installed app
    if (dispatcher) {
      const programsFs = new NodeFsHost(programsDir);
      const bootPath   = `$.${name}.!Boot`;
      const spritePath = `$.${name}.!Sprites`;

      if (programsFs.stat(bootPath) !== null) {
        const obey = new ObeyInterpreter(programsFs, dispatcher.sysvar, {
          onOutput: (text) => launcherWindow?.webContents.send("console-output", text),
          spritePool: dispatcher.spriteAreas.system,
        });
        obey.runFile(bootPath);
      } else if (programsFs.stat(spritePath) !== null) {
        try {
          dispatcher.spriteAreas.system.loadArea(programsFs.readFile(spritePath));
        } catch { /* ignore */ }
      }
    }

    // Tell the browser window to refresh
    programsBrowserWindow?.webContents.send(IPC.BROWSER_REFRESH);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// ---------------------------------------------------------------------------
// Auto-load ROM from assets/roms/ on startup
// ---------------------------------------------------------------------------
function tryAutoLoadROM(): void {
  const romsDir = resolveAssets("assets", "roms");

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
    startMachine(new Uint8Array(data), parseAppArg());
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
  Menu.setApplicationMenu(buildAppMenu(null, { onLoadROM, onReset, onSetSpeed, onSetCPU }));

  if (parseAppArg()) {
    // Launching a specific app: show launcher window for status/error feedback
    launcherWindow = createLauncherWindow();
    launcherWindow.on("closed", () => { launcherWindow = null; });
    launcherWindow.webContents.once("did-finish-load", tryAutoLoadROM);
  } else {
    // No specific app: go straight to programs browser, no launcher needed
    tryAutoLoadROM();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (parseAppArg()) {
        launcherWindow = createLauncherWindow();
        launcherWindow.on("closed", () => { launcherWindow = null; });
        launcherWindow.webContents.once("did-finish-load", tryAutoLoadROM);
      } else {
        programsBrowserWindow = createProgramsBrowserWindow();
      }
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    machine?.stop();
    app.quit();
  }
});
