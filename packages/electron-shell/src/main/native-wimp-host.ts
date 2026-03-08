/**
 * NativeWimpHost — Electron implementation of the NativeHost interface.
 *
 * Each RISC OS window gets a real BrowserWindow.
 * Menus use Electron's native Menu API.
 * The iconbar maps to a persistent docked BrowserWindow.
 */

import {
  BrowserWindow, Menu, MenuItem, dialog, screen, ipcMain,
} from "electron";
import path from "path";
import type {
  NativeHost, NativeMenuItem, DrawCommand,
  WimpWindowDef, WimpIcon, WimpPollEvent,
} from "@theprogramminggiantpanda/risc-os";
import { WimpEvent, WimpMsg, osUnitsToPx } from "@theprogramminggiantpanda/risc-os";

const isDev = !require("electron").app.isPackaged;

function rendererURL(page: string): string {
  return isDev
    ? `http://localhost:5173/${page}`
    : `file://${path.join(__dirname, `../../renderer/${page}`)}`;
}

/** Convert OS-unit coordinates to screen pixels */
function osRect(def: Pick<WimpWindowDef, "visX0"|"visY0"|"visX1"|"visY1">) {
  // RISC OS: Y grows upward, origin at bottom-left of screen
  const disp = screen.getPrimaryDisplay();
  const H = disp.workAreaSize.height;
  const x = osUnitsToPx(def.visX0);
  const w = osUnitsToPx(def.visX1 - def.visX0);
  const h = osUnitsToPx(def.visY1 - def.visY0);
  const y = H - osUnitsToPx(def.visY1); // flip Y axis
  return { x, y, width: Math.max(80, w), height: Math.max(40, h) };
}

export class NativeWimpHost implements NativeHost {
  /** Map from RISC OS window handle → BrowserWindow */
  private windows = new Map<number, BrowserWindow>();

  /** Pending Wimp_Poll resolvers */
  private pollResolvers: Array<(ev: WimpPollEvent) => void> = [];
  /** Queued events that arrived before Wimp_Poll was called */
  private pendingEvents: WimpPollEvent[] = [];

  /** Mouse state (updated by window events) */
  private pointer = { x: 0, y: 0, buttons: 0, winHandle: 0, iconHandle: -1 };

  /** Iconbar BrowserWindow */
  private iconbarWin: BrowserWindow | null = null;
  private iconbarEntries = new Map<number, { sprite: string; text: string }>();

  constructor() {
    this.createIconbar();
    this.listenIPC();
  }

  // --------------------------------------------------------------------------
  // NativeHost implementation
  // --------------------------------------------------------------------------

  async createWindow(handle: number, def: WimpWindowDef): Promise<string> {
    const rect = osRect(def);
    const win = new BrowserWindow({
      x: rect.x,
      y: rect.y,
      width:  rect.width,
      height: rect.height,
      minWidth:  def.minWidth  ? osUnitsToPx(def.minWidth)  : 120,
      minHeight: def.minHeight ? osUnitsToPx(def.minHeight) : 80,
      title: def.title || "RISC OS",
      show: false,
      frame: true,               // native title bar
      resizable: !!(def.flags & (1 << 1)),
      webPreferences: {
        preload: path.join(__dirname, "../preload/window-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        additionalArguments: [`--wimp-handle=${handle}`],
      },
    });

    win.loadURL(rendererURL(`window.html?handle=${handle}`));

    // Forward close button → Wimp CloseWindow event
    win.on("close", (e) => {
      e.preventDefault();
      this.deliverEvent({ code: WimpEvent.Close, data: [handle, 0, 0, 0, 0, 0, 0, 0] });
    });

    // Track window moves/resizes → update pointer/window state
    win.on("moved", () => {
      const [x, y] = win.getPosition();
      const [w, h] = win.getSize();
      const disp = screen.getPrimaryDisplay();
      const H = disp.workAreaSize.height;
      // Deliver open event so RISC OS knows the new position
      this.deliverEvent({
        code: WimpEvent.Open,
        data: [handle, x * 2, (H - y - h) * 2, (x + w) * 2, (H - y) * 2, 0, 0, -1],
      });
    });

    win.on("resize", () => win.webContents.send("wimp-resize"));

    this.windows.set(handle, win);
    return `win-${handle}`;
  }

  async openWindow(
    handle: number,
    def: Pick<WimpWindowDef, "visX0"|"visY0"|"visX1"|"visY1"|"scrollX"|"scrollY"|"behind">
  ): Promise<void> {
    const win = this.windows.get(handle);
    if (!win) return;
    const rect = osRect(def);
    win.setBounds(rect);
    win.show();
    win.focus();
    if (def.behind === -2) win.setAlwaysOnTop(false); // send to back (best effort)
  }

  async closeWindow(handle: number): Promise<void> {
    this.windows.get(handle)?.hide();
  }

  async destroyWindow(handle: number): Promise<void> {
    const win = this.windows.get(handle);
    if (win && !win.isDestroyed()) win.destroy();
    this.windows.delete(handle);
  }

  async updateIcon(winHandle: number, iconHandle: number, icon: WimpIcon): Promise<void> {
    this.windows.get(winHandle)?.webContents.send("wimp-update-icon", { iconHandle, icon });
  }

  async draw(winHandle: number, cmds: DrawCommand[]): Promise<void> {
    this.windows.get(winHandle)?.webContents.send("wimp-draw", cmds);
  }

  updateWindowPixels(handle: number, pixels: Uint8ClampedArray, width: number, height: number): void {
    const win = this.windows.get(handle);
    if (win && !win.isDestroyed()) {
      win.webContents.send("wimp-pixels", { width, height, pixels: Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength) });
    }
  }

  async showMenu(title: string, items: NativeMenuItem[], x: number, y: number): Promise<number[] | null> {
    return new Promise((resolve) => {
      const menu = Menu.buildFromTemplate(
        this.buildMenuTemplate(items, [], resolve)
      );
      menu.popup({ x, y, callback: () => resolve(null) });
      void title;
    });
  }

  async showError(message: string, flags: number, name: string): Promise<number> {
    const buttons = [];
    if (flags & 1) buttons.push("Continue");
    if (flags & 2) buttons.push("Cancel");
    if (buttons.length === 0) buttons.push("OK");

    const result = await dialog.showMessageBox({
      type: "error",
      title: name || "RISC OS Error",
      message,
      buttons,
    });
    return result.response + 1; // RISC OS: 1=Continue, 2=Cancel
  }

  getPointerInfo() {
    return this.pointer;
  }

  pollEvent(mask: number): Promise<WimpPollEvent> {
    // Check if we have a queued non-masked event
    for (let i = 0; i < this.pendingEvents.length; i++) {
      const ev = this.pendingEvents[i]!;
      if (!((mask >> ev.code) & 1)) {
        this.pendingEvents.splice(i, 1);
        return Promise.resolve(ev);
      }
    }
    // Otherwise wait
    return new Promise((resolve) => {
      this.pollResolvers.push((ev) => {
        if ((mask >> ev.code) & 1) {
          // Event is masked — re-queue it and try next
          this.pendingEvents.push(ev);
          // Deliver a null event so the CPU doesn't block forever
          resolve({ code: WimpEvent.Null, data: [] });
        } else {
          resolve(ev);
        }
      });
    });
  }

  setIconbarEntry(taskHandle: number, sprite: string, text: string): void {
    this.iconbarEntries.set(taskHandle, { sprite, text });
    this.iconbarWin?.webContents.send("iconbar-update", [...this.iconbarEntries.entries()]);
  }

  removeIconbarEntry(taskHandle: number): void {
    this.iconbarEntries.delete(taskHandle);
    this.iconbarWin?.webContents.send("iconbar-update", [...this.iconbarEntries.entries()]);
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  /** Deliver an event: wake a waiting Wimp_Poll or queue it */
  deliverEvent(ev: WimpPollEvent): void {
    if (this.pollResolvers.length > 0) {
      const resolve = this.pollResolvers.shift()!;
      resolve(ev);
    } else {
      this.pendingEvents.push(ev);
    }
  }

  private buildMenuTemplate(
    items: NativeMenuItem[],
    path: number[],
    resolve: (sel: number[] | null) => void,
  ): Electron.MenuItemConstructorOptions[] {
    return items.map((item, idx) => {
      const currentPath = [...path, idx];
      if (item.submenu) {
        return {
          label: item.text,
          submenu: this.buildMenuTemplate(item.submenu, currentPath, resolve),
        };
      }
      return {
        label: item.text,
        enabled: !(item.flags & (1 << 6)), // bit 6 = greyed
        type: (item.flags & (1 << 4)) ? "separator" : "normal",
        click: () => resolve(currentPath),
      };
    });
  }

  private createIconbar(): void {
    const disp = screen.getPrimaryDisplay();
    const { x: areaX, y: areaY, width, height } = disp.workArea;

    this.iconbarWin = new BrowserWindow({
      x: areaX,
      y: areaY + height - 68,
      width,
      height: 68,
      frame: false,
      resizable: false,
      movable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      transparent: true,
      webPreferences: {
        preload: path.join(__dirname, "../preload/iconbar-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.iconbarWin.loadURL(rendererURL("iconbar.html"));
    this.iconbarWin.setIgnoreMouseEvents(false);
  }

  private listenIPC(): void {
    // Window renderer → main: user clicked inside a RISC OS window
    ipcMain.on("wimp-click", (_ev, { winHandle, x, y, buttons, iconHandle }) => {
      const disp = screen.getPrimaryDisplay();
      this.pointer = { x: x * 2, y: y * 2, buttons, winHandle, iconHandle: iconHandle ?? -1 };
      this.deliverEvent({
        code: WimpEvent.Click,
        data: [winHandle, iconHandle ?? -1, buttons, x * 2, y * 2, 0, 0, 0],
      });
    });

    // Key press
    ipcMain.on("wimp-key", (_ev, { winHandle, charCode }) => {
      this.deliverEvent({
        code: WimpEvent.KeyPressed,
        data: [winHandle, -1, 0, 0, charCode, 0, 0, 0],
      });
    });

    // Iconbar icon clicked → deliver click on handle -2 (iconbar)
    ipcMain.on("iconbar-click", (_ev, { taskHandle, buttons }) => {
      this.deliverEvent({
        code: WimpEvent.Click,
        data: [-2, taskHandle, buttons, 0, 0, 0, 0, 0],
      });
    });

    // Null poll timer — keep apps alive even when idle
    setInterval(() => {
      if (this.pollResolvers.length > 0) {
        this.deliverEvent({ code: WimpEvent.Null, data: [] });
      }
    }, 100);
  }
}
