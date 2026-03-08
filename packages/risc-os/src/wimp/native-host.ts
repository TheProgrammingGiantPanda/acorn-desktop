/**
 * NativeHost — abstract interface between the RISC OS Wimp emulation and the
 * host windowing system (implemented by electron-shell).
 *
 * Each method may be async; the Wimp layer awaits them where needed.
 */

import type { WimpWindowDef, WimpIcon, WimpPollEvent } from "./types.js";

export interface DrawCommand {
  /**
   * Canvas-pixel drawing types (used by icon renderer etc.):
   *   clear, fillRect, strokeRect, text, line, sprite
   *
   * OS-unit drawing types (used by OS_Plot interception):
   *   os_setup  — configure the window for coordinate translation:
   *               x = scrollX (work-area X at window's left edge)
   *               y = scrollY (work-area Y at window's TOP edge, RISC OS upward Y)
   *               w = window width in OS units  (visX1 - visX0)
   *               h = window height in OS units (visY1 - visY0)
   *   os_line   — draw line from (x,y) to (w,h) in work-area OS units
   *   os_rect   — draw filled rect; x,y = OS lower-left corner (work-area),
   *               w,h = width/height in OS units
   */
  type: "fillRect" | "strokeRect" | "text" | "line" | "clear" | "sprite"
      | "os_setup" | "os_line" | "os_rect";
  x: number; y: number;
  w?: number; h?: number;
  text?: string;
  colour?: string;
  font?: string;
  sprite?: string;
}

export interface NativeHost {
  /**
   * Create a native window.
   * Returns an opaque native handle (used in subsequent calls).
   */
  createWindow(handle: number, def: WimpWindowDef): Promise<string>;

  /** Show/reposition a native window */
  openWindow(handle: number, def: Pick<WimpWindowDef, "visX0"|"visY0"|"visX1"|"visY1"|"scrollX"|"scrollY"|"behind">): Promise<void>;

  /** Hide a native window (keep it alive) */
  closeWindow(handle: number): Promise<void>;

  /** Destroy a native window permanently */
  destroyWindow(handle: number): Promise<void>;

  /** Update an icon's state in a native window */
  updateIcon(winHandle: number, iconHandle: number, icon: WimpIcon): Promise<void>;

  /** Send drawing commands to a window's canvas */
  draw(winHandle: number, cmds: DrawCommand[]): Promise<void>;

  /** Show a native menu (returns selected item path or null) */
  showMenu(title: string, items: NativeMenuItem[], x: number, y: number): Promise<number[] | null>;

  /** Show an error dialog */
  showError(message: string, flags: number, name: string): Promise<number>;

  /** Report pointer position (screen coords in OS units) and button state */
  getPointerInfo(): { x: number; y: number; buttons: number; winHandle: number; iconHandle: number };

  /**
   * Wait for the next Wimp event and resolve with it.
   * mask: bitmask of events to ignore (bit N = ignore event N)
   */
  pollEvent(mask: number): Promise<WimpPollEvent>;

  /** Update the taskbar / iconbar entry for this task */
  setIconbarEntry(taskHandle: number, sprite: string, text: string): void;

  /** Remove the iconbar entry */
  removeIconbarEntry(taskHandle: number): void;

}

export interface NativeMenuItem {
  text: string;
  flags: number;       // Wimp menu item flags
  submenu?: NativeMenuItem[];
  submenuHandle?: number; // Wimp window handle if submenu is a dialogue
}
