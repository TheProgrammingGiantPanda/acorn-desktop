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
import { HostFsHandler } from "./hostfs-handler.js";
import { generateHostFsModule, MODULE_INIT_OFFSET, MODULE_SENTINEL_SWI } from "./hostfs-arm-module.js";
import { buildAppMenu } from "./menu.js";
import type { MachineConfig, DirEntry } from "@theprogramminggiantpanda/shared";
import { IPC, Logger } from "@theprogramminggiantpanda/shared";

const isDev = !app.isPackaged;
const logger = new Logger(isDev ? 'debug' : 'error');

// Special iconbar handle for the HostFS disc icon (-999 won't collide with task handles)
const HOSTFS_ICONBAR_HANDLE = -999;

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
    win.webContents.openDevTools({ mode: "bottom" });
  } else {
    win.loadFile(path.join(__dirname, "../../renderer/index.html"));
  }

  Menu.setApplicationMenu(buildAppMenu(win, { onLoadROM, onReset, onSetSpeed, onSetCPU }));
  return win;
}

let launcherWindow: BrowserWindow | null = null;

// ---------------------------------------------------------------------------
// HostFS browser window
// ---------------------------------------------------------------------------
function createHostFsBrowserWindow(riscosPath: string): BrowserWindow {
  const encodedPath = encodeURIComponent(riscosPath);
  const win = new BrowserWindow({
    width:    480,
    height:   400,
    minWidth: 320,
    minHeight: 200,
    title:    `HostFS: ${riscosPath}`,
    webPreferences: {
      preload: path.join(__dirname, "../preload/hostfs-browser-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    win.loadURL(`http://localhost:5173/hostfs-browser.html?path=${encodedPath}`);
  } else {
    win.loadFile(
      path.join(__dirname, "../../renderer/hostfs-browser.html"),
      { query: { path: riscosPath } },
    );
  }

  return win;
}

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
// List HostFS directory contents for the browser
// ---------------------------------------------------------------------------
function listDir(riscosPath: string): DirEntry[] {
  const programsDir = resolveAssets("assets", "programs");

  // Resolve HostFS::$ → programsDir; HostFS::$.Dir.Sub → programsDir/Dir/Sub
  let nativePath: string;
  if (riscosPath === "HostFS::$" || riscosPath === "HostFS::$.") {
    nativePath = programsDir;
  } else if (riscosPath.startsWith("HostFS::$.")) {
    const inner = riscosPath.slice("HostFS::$.".length);
    nativePath = path.join(programsDir, ...inner.split("."));
  } else {
    return [];
  }

  let entries: string[] = [];
  try { entries = fs.readdirSync(nativePath).sort(); }
  catch { return []; }

  return entries
    .filter(name => {
      try { fs.statSync(path.join(nativePath, name)); return true; }
      catch { return false; }
    })
    .map((name): DirEntry => {
      const entryPath = path.join(nativePath, name);
      let stat: fs.Stats;
      try { stat = fs.statSync(entryPath); }
      catch { return { name, isDir: false, isApp: false }; }

      const isDir = stat.isDirectory();
      const isApp = name.startsWith("!");
      let sprite: DirEntry["sprite"] | undefined;

      if (isDir && isApp) {
        // Try loading the sprite for !App directories
        const spriteName  = name.slice(1).toLowerCase();
        const spritePath  = path.join(entryPath, "!Sprites");
        try {
          const data = fs.readFileSync(spritePath);
          const pool = new SpritePool();
          pool.loadArea(new Uint8Array(data));
          const found = pool.get(`!${spriteName}`) ?? pool.get(spriteName);
          if (found) {
            sprite = {
              rgba:   Array.from(found.rgba),
              width:  found.width,
              height: found.height,
            };
          }
        } catch { /* no !Sprites or parse error — use generic icon */ }
      }

      return { name, isDir, isApp, sprite };
    });
}

// ---------------------------------------------------------------------------
// Machine lifecycle
// ---------------------------------------------------------------------------
function startMachine(romData: Uint8Array, appHostPath?: string): void {
  machine?.stop();

  // When launching a specific app, root the FS at the app's parent directory
  // so the app dir is accessible as $.!AppName inside RISC OS.
  // In HostFS browser mode (no appHostPath), root at assets/programs/.
  const fsRoot = appHostPath
    ? path.dirname(path.resolve(appHostPath))
    : resolveAssets("assets", "programs");

  const nodeFs = new NodeFsHost(fsRoot);

  machine    = new ArchimedesMachine(config, logger);
  wimpHost   = new NativeWimpHost();

  // obeyFs gives the ObeyInterpreter access to !Run / !Boot scripts on disk.
  // fs is intentionally omitted: in ROM boot mode the real ROM FileSwitch
  // handles OS_File / OS_Find / etc.; HostFsHandler (registered below)
  // intercepts only HostFS:: paths and passes everything else through to ROM.
  dispatcher = new SwiDispatcher(machine, wimpHost, {
    onOutput: (text) => {
      logger.debug(`[RISC OS] ${text}`);
      launcherWindow?.webContents.send("console-output", text);
    },
    obeyFs: nodeFs,
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
    onServiceStartFiler: () => {
      logger.debug(`[HostFS] Service_StartFiler received — adding iconbar disc icon`);
      wimpHost?.setIconbarEntry(HOSTFS_ICONBAR_HANDLE, "hostfsdisk", "HostFS::$");
    },
  });

  // Register HostFS: intercepts OS_File/OS_Find/OS_GBPB/OS_Args for "HostFS::"
  // paths, passes everything else through to the real ROM FileSwitch.
  const hostfs = new HostFsHandler(fsRoot);
  hostfs.register(machine);

  machine.loadROM(romData);
  machine.bootROM();

  // ── ARM module integration ────────────────────────────────────────────────
  // Write the HostFS ARM module binary into physical RAM at 0x80000.
  // In the emulator's linear mapping, logical 0x80000 = physical 0x80000.
  const MODULE_BASE   = 0x80000;
  const moduleBinary  = generateHostFsModule(MODULE_BASE);
  machine.writePhysical(MODULE_BASE, moduleBinary);

  // Register private SWIs that the module stubs delegate to
  hostfs.registerPrivateSWIs(machine);

  // Register SWI 0x041509 — service entry callback (add iconbar icon)
  machine.cpu.swiHandlers.set(0x041509, () => {
    logger.debug(`[HostFS] ARM module service callback — adding iconbar disc icon`);
    wimpHost?.setIconbarEntry(HOSTFS_ICONBAR_HANDLE, "hostfsdisk", "HostFS::$");
  });

  // One-shot hook on first Wimp_Poll to run the module init ARM routine.
  // This registers HostFS with FileSwitch via OS_FSControl 12 (which passthroughs
  // to the real ROM), then fires MODULE_SENTINEL_SWI to signal completion.
  let moduleInitDone = false;
  const origPollHandler = machine.cpu.swiHandlers.get(0x400C7); // Wimp_Poll
  machine.cpu.swiHandlers.set(0x400C7, (r, b) => {
    if (!moduleInitDone) {
      moduleInitDone = true;
      machine!.cpu.swiPending = true;
      machine!.runArmCallback(MODULE_BASE + MODULE_INIT_OFFSET, MODULE_SENTINEL_SWI)
        .then(() => {
          logger.debug(`[HostFS] Module init complete`);
          // Restore original Wimp_Poll handler and resume
          if (origPollHandler) {
            machine!.cpu.swiHandlers.set(0x400C7, origPollHandler);
          } else {
            machine!.cpu.swiHandlers.delete(0x400C7);
          }
          void dispatcher!.wimp.poll(r, b, false);
        })
        .catch(err => {
          logger.error(`[HostFS] Module init failed: ${err}`);
          if (origPollHandler) {
            machine!.cpu.swiHandlers.set(0x400C7, origPollHandler);
          } else {
            machine!.cpu.swiHandlers.delete(0x400C7);
          }
          void dispatcher!.wimp.poll(r, b, false);
        });
      return; // CPU suspended — don't call poll yet
    }
    origPollHandler?.(r, b);
  });

  // Fallback: add iconbar icon after a delay in case Service_StartFiler
  // is not broadcast (e.g. ROM doesn't have Filer)
  setTimeout(() => {
    if (wimpHost && !wimpHost["iconbarEntries"]?.has(HOSTFS_ICONBAR_HANDLE)) {
      logger.debug(`[HostFS] Fallback — adding iconbar disc icon`);
      wimpHost.setIconbarEntry(HOSTFS_ICONBAR_HANDLE, "hostfsdisk", "HostFS::$");
    }
  }, 3000);

  bootAllApps();

  if (appHostPath) {
    launchApp(nodeFs, appHostPath);
  }
  // No specific app — just boot the ROM and wait for the Filer to start.
  // The Service_StartFiler callback (or the fallback timer) will add the icon.

  // Hide the launcher now that the ROM is running — the Filer provides the UI.
  // (We keep it hidden rather than closed so the app process stays alive while
  // RISC OS boots and opens its own windows.)
  launcherWindow?.hide();
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
// HostFS browser IPC
// ---------------------------------------------------------------------------
ipcMain.handle(IPC.HOSTFS_LIST_DIR, (_ev, riscosPath: string): DirEntry[] => {
  try {
    return listDir(riscosPath);
  } catch (err) {
    logger.error(`[hostfs:list-dir] ${err}`);
    return [];
  }
});

ipcMain.handle(IPC.HOSTFS_LAUNCH, (_ev, riscosPath: string) => {
  logger.debug(`[hostfs:launch] ${riscosPath}`);
  if (!dispatcher || !machine) {
    logger.error(`[hostfs:launch] machine not ready`);
    return;
  }

  const programsDir = resolveAssets("assets", "programs");
  const programsFs  = new NodeFsHost(programsDir);

  // Resolve HostFS::$.!App → $.!App
  let riscosRelPath = riscosPath;
  if (riscosRelPath.startsWith("HostFS::$")) {
    riscosRelPath = riscosRelPath.slice("HostFS::".length); // e.g. "$.!Paint"
  }

  const runScript = `${riscosRelPath}.!Run`;
  if (programsFs.stat(runScript) !== null) {
    logger.debug(`[hostfs:launch] running obey: ${runScript}`);
    dispatcher.obey.runFile(runScript);
  } else {
    const runImage = `${riscosRelPath}.!RunImage`;
    logger.debug(`[hostfs:launch] no !Run, trying binary: ${runImage}`);
    if (programsFs.stat(runImage) !== null) {
      const data = programsFs.readFile(runImage);
      machine.startApp(data);
    } else {
      logger.error(`[hostfs:launch] no !Run or !RunImage found for ${riscosPath}`);
    }
  }
});

ipcMain.handle(IPC.HOSTFS_OPEN_DIR, (_ev, riscosPath: string) => {
  logger.debug(`[hostfs:open-dir] ${riscosPath}`);
  createHostFsBrowserWindow(riscosPath);
});

// ---------------------------------------------------------------------------
// Iconbar click → open HostFS browser
// ---------------------------------------------------------------------------
// Listen for iconbar-click in main process to intercept HOSTFS_ICONBAR_HANDLE.
// NativeWimpHost also listens for this event, so it will forward other handles
// to RISC OS tasks normally.
ipcMain.on("iconbar-click", (_ev, { taskHandle }: { taskHandle: number; buttons: number }) => {
  if (taskHandle === HOSTFS_ICONBAR_HANDLE) {
    createHostFsBrowserWindow("HostFS::$");
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

  launcherWindow = createLauncherWindow();
  launcherWindow.on("closed", () => { launcherWindow = null; });
  launcherWindow.webContents.once("did-finish-load", tryAutoLoadROM);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      launcherWindow = createLauncherWindow();
      launcherWindow.on("closed", () => { launcherWindow = null; });
      launcherWindow.webContents.once("did-finish-load", tryAutoLoadROM);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    machine?.stop();
    app.quit();
  }
});
