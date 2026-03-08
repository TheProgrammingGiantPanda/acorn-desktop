/**
 * WimpManager — implements Wimp_* SWIs.
 *
 * Most SWIs are intercepted for native side-effects (creating BrowserWindows,
 * updating the iconbar, etc.) and then passed through to the ROM so that ROM's
 * own Wimp state stays correct.  Only Wimp_Poll and the canvas-redraw pair
 * (Wimp_RedrawWindow / Wimp_GetRectangle) are handled entirely in JS.
 */

import type { RegisterFile, SwiReturnHook } from "@theprogramminggiantpanda/arm-emulator";
import type { SystemBus }    from "@theprogramminggiantpanda/arm-emulator";
import type { NativeHost, NativeMenuItem } from "./native-host.js";
import {
  type WimpWindowDef, type WimpIcon, type WimpWindow,
  WimpEvent, WF_HAS_TITLE, IF_INDIRECTED, IF_TEXT,
  osUnitsToPx, pxToOsUnits,
} from "./types.js";
import type { ArchimedesMachine } from "@theprogramminggiantpanda/arm-emulator";
import type { SpritePool, SpriteData } from "../sprite/sprite-pool.js";

/** Return type for WimpManager handler methods — mirrors SwiHandler return type */
type WR = void | 'passthrough' | { passthrough: true; afterReturn: SwiReturnHook };

/** Read a null-terminated string from ARM RAM */
function readString(bus: SystemBus, addr: number, maxLen = 256): string {
  let str = "";
  for (let i = 0; i < maxLen; i++) {
    const ch = bus.read8(addr + i);
    if (ch === 0 || ch === 0xFF) break;
    str += String.fromCharCode(ch);
  }
  return str;
}

/** Write a null-terminated string into ARM RAM */
function writeString(bus: SystemBus, addr: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    bus.write8(addr + i, str.charCodeAt(i));
  }
  bus.write8(addr + str.length, 0);
}

/** Read a 64-byte Wimp window definition block from RAM (R1) */
function readWindowDef(bus: SystemBus, addr: number): WimpWindowDef {
  const r = (off: number) => bus.read32(addr + off) | 0;
  const titleFlags = r(72);
  let title = "";
  if (titleFlags & IF_INDIRECTED) {
    const ptr = r(76);
    title = readString(bus, ptr);
  } else if (titleFlags & IF_TEXT) {
    // Inline — 12 bytes at offset 76
    title = readString(bus, addr + 76, 12);
  }

  return {
    visX0: r(0),  visY0: r(4),  visX1: r(8),  visY1: r(12),
    scrollX: r(16), scrollY: r(20),
    behind: r(24),
    flags: r(28),
    titleFg: (r(32) >>> 0) & 0xFF,
    titleBg: (r(32) >>> 8) & 0xFF,
    workFg:  (r(32) >>> 16) & 0xFF,
    workBg:  (r(32) >>> 24) & 0xFF,
    scrollBarOuterColour: (r(36)) & 0xFF,
    scrollBarInnerColour: (r(36) >>> 8) & 0xFF,
    titleBarHighlightColour: (r(36) >>> 16) & 0xFF,
    workX0: r(40), workY0: r(44), workX1: r(48), workY1: r(52),
    titleFlags,
    workAreaButtonType: (r(56)) & 0xFF,
    spriteArea: r(60),
    minWidth:  r(64) & 0xFFFF,
    minHeight: (r(64) >>> 16) & 0xFFFF,
    title,
    numIcons: r(84),
  };
}

/** Read a Wimp menu structure from RAM */
function readMenu(bus: SystemBus, addr: number): { title: string; items: NativeMenuItem[] } {
  const title = readString(bus, addr, 12);
  const items: NativeMenuItem[] = [];
  let ptr = addr + 28; // menu items start after header
  for (;;) {
    const flags    = bus.read32(ptr);
    const submenu  = bus.read32(ptr + 4);
    const iconFlags = bus.read32(ptr + 8);
    let text = "";
    if (iconFlags & IF_INDIRECTED) {
      text = readString(bus, bus.read32(ptr + 12));
    } else {
      text = readString(bus, ptr + 12, 12);
    }
    const item: NativeMenuItem = { text, flags };
    if (submenu !== 0 && submenu !== -1) {
      item.submenu = readMenu(bus, submenu).items;
    }
    items.push(item);
    if (flags & (1 << 7)) break; // last item
    ptr += 24;
  }
  return { title, items };
}

export class WimpManager {
  private windows  = new Map<number, WimpWindow>();
  readonly events  = new (class { push(_: unknown) {} })(); // no-op — events come via ROM poll
  private taskName = "Unknown";
  private taskHandle = 0;
  private machine!: ArchimedesMachine;

  // ── OS_Plot / VDU drawing state ────────────────────────────────────────────
  private currentRedrawHandle: number | null = null;
  private graphicsX = 0;
  private graphicsY = 0;
  private fgColour = "#000000";
  private pendingCmds: import("./native-host.js").DrawCommand[] = [];
  private spritePool: SpritePool | null = null;

  constructor(private readonly host: NativeHost) {}

  setMachine(m: ArchimedesMachine): void { this.machine = m; }
  setSpritePool(pool: SpritePool): void  { this.spritePool = pool; }

  // ---------------------------------------------------------------------------
  // SWI implementations
  // ---------------------------------------------------------------------------

  /**
   * Wimp_Initialise — read task name, then passthrough so ROM registers the task.
   * afterReturn captures ROM's real task handle from R1.
   */
  initialise(regs: RegisterFile, bus: SystemBus): WR {
    this.taskName = readString(bus, regs.read(2));
    return {
      passthrough: true,
      afterReturn: (r) => {
        this.taskHandle = r.read(1);
        console.log(`[Wimp_Initialise] task="${this.taskName}" handle=${this.taskHandle} (ROM-assigned)`);
      },
    };
  }

  /**
   * Wimp_CreateWindow — passthrough to ROM first; afterReturn creates the native
   * BrowserWindow using the handle ROM assigned (written to R1 on exit).
   */
  createWindow(regs: RegisterFile, bus: SystemBus): WR {
    const def = readWindowDef(bus, regs.read(1));
    return {
      passthrough: true,
      afterReturn: (r) => {
        const handle = r.read(1); // ROM's assigned window handle
        this.host.createWindow(handle, def);
        this.windows.set(handle, { handle, def, icons: new Map(), open: false, dirty: true });
      },
    };
  }

  /** Wimp_OpenWindow — update native window, then let ROM update its state */
  openWindow(regs: RegisterFile, bus: SystemBus): WR {
    const blockAddr = regs.read(1);
    const handle = bus.read32(blockAddr) | 0;
    const win    = this.windows.get(handle);
    if (win) {
      win.def.visX0   = bus.read32(blockAddr + 4)  | 0;
      win.def.visY0   = bus.read32(blockAddr + 8)  | 0;
      win.def.visX1   = bus.read32(blockAddr + 12) | 0;
      win.def.visY1   = bus.read32(blockAddr + 16) | 0;
      win.def.scrollX = bus.read32(blockAddr + 20) | 0;
      win.def.scrollY = bus.read32(blockAddr + 24) | 0;
      win.def.behind  = bus.read32(blockAddr + 28) | 0;
      win.open = true;
      this.host.openWindow(handle, win.def);
    }
    return 'passthrough';
  }

  /** Wimp_CloseWindow — hide native window, let ROM update its state */
  closeWindow(regs: RegisterFile, bus: SystemBus): WR {
    const handle = bus.read32(regs.read(1)) | 0;
    const win = this.windows.get(handle);
    if (win) {
      win.open = false;
      this.host.closeWindow(handle);
    }
    return 'passthrough';
  }

  /** Wimp_DeleteWindow — destroy native window, let ROM clean up its state */
  deleteWindow(regs: RegisterFile, bus: SystemBus): WR {
    const handle = bus.read32(regs.read(1)) | 0;
    this.host.destroyWindow(handle);
    this.windows.delete(handle);
    return 'passthrough';
  }

  /**
   * Wimp_Poll / Wimp_PollIdle
   *
   * 1. Sync-check our native event queue (mouse, window, keyboard events).
   * 2. If empty, passthrough to ROM — ROM may have messages/events queued.
   * 3. If ROM also returns Null, suspend CPU and wait for next native event.
   */
  poll(regs: RegisterFile, bus: SystemBus, _pollIdle: boolean): WR {
    const mask      = regs.read(0);
    const blockAddr = regs.read(1);

    // Fast path: native event already waiting
    const pending = this.host.tryPollEvent(mask);
    if (pending) {
      for (let i = 0; i < pending.data.length; i++) {
        bus.write32(blockAddr + i * 4, pending.data[i]!);
      }
      regs.write(0, pending.code);
      return; // no passthrough, no suspend
    }

    // Let ROM check its own queue (messages sent by modules/apps via Wimp_SendMessage)
    return {
      passthrough: true,
      afterReturn: (r, b) => {
        const romCode = r.read(0);
        if (romCode !== WimpEvent.Null && !((mask >> romCode) & 1)) {
          // ROM delivered a real unmasked event — already written to the block by ROM.
          // CPU resumes normally.
          return;
        }
        // ROM also returned Null. Suspend and wait for a native event.
        this.machine.cpu.swiPending = true;
        void this.host.pollEvent(mask).then((ev) => {
          for (let i = 0; i < ev.data.length; i++) {
            b.write32(blockAddr + i * 4, ev.data[i]!);
          }
          r.write(0, ev.code);
          this.machine.wakeFromSWI();
        });
      },
    };
  }

  /** Wimp_RedrawWindow — enters the canvas redraw loop (pure HLE, no passthrough) */
  redrawWindow(regs: RegisterFile, bus: SystemBus): void {
    const blockAddr = regs.read(1);
    const handle    = bus.read32(blockAddr) | 0;
    const win       = this.windows.get(handle);
    if (!win) {
      regs.write(0, 0);
      return;
    }

    // Write window state for the app to read
    const d = win.def;
    bus.write32(blockAddr + 0,  d.visX0);
    bus.write32(blockAddr + 4,  d.visY0);
    bus.write32(blockAddr + 8,  d.visX1);
    bus.write32(blockAddr + 12, d.visY1);
    bus.write32(blockAddr + 16, d.scrollX);
    bus.write32(blockAddr + 20, d.scrollY);
    bus.write32(blockAddr + 24, win.open ? -1 : 0);
    bus.write32(blockAddr + 28, d.flags | (win.open ? 0x10000 : 0));
    regs.write(0, 1); // non-zero = rectangle to redraw

    this.currentRedrawHandle = handle;
    this.pendingCmds = [
      {
        type: "os_setup",
        x: win.def.scrollX,
        y: win.def.scrollY,
        w: win.def.visX1 - win.def.visX0,
        h: win.def.visY1 - win.def.visY0,
      },
      { type: "clear", x: 0, y: 0 },
    ];
  }

  /**
   * Wimp_GetRectangle — ends the canvas redraw loop (pure HLE, no passthrough).
   * Flushes all batched OS_Plot commands to the native window canvas.
   */
  getWindowRect(regs: RegisterFile, _bus: SystemBus): void {
    regs.write(0, 0); // no more rectangles

    if (this.currentRedrawHandle !== null && this.pendingCmds.length > 0) {
      this.host.draw(this.currentRedrawHandle, this.pendingCmds);
    }
    this.pendingCmds = [];
    this.currentRedrawHandle = null;
  }

  // ── OS_Plot interception ───────────────────────────────────────────────────

  osPlot(code: number, x: number, y: number): void {
    if (this.currentRedrawHandle === null) return;

    const absolute   = !!(code & 4);
    const drawAction = code & 3;
    const opType     = (code >>> 3) & 0x1F;

    const absX = absolute ? x : this.graphicsX + x;
    const absY = absolute ? y : this.graphicsY + y;

    if (drawAction !== 0) {
      switch (opType) {
        case 0:
          this.pendingCmds.push({
            type: "os_line",
            x: this.graphicsX, y: this.graphicsY,
            w: absX, h: absY,
            colour: this.fgColour,
          });
          break;
        case 12:
          this.pendingCmds.push({
            type: "os_rect",
            x: Math.min(this.graphicsX, absX),
            y: Math.min(this.graphicsY, absY),
            w: Math.abs(absX - this.graphicsX),
            h: Math.abs(absY - this.graphicsY),
            colour: this.fgColour,
          });
          break;
      }
    }

    this.graphicsX = absX;
    this.graphicsY = absY;
  }

  setGraphicsFgColour(css: string): void { this.fgColour = css; }
  setGraphicsBgColour(_css: string): void { /* background ops not yet implemented */ }

  /** Wimp_CreateMenu (pure HLE — native menu, no passthrough) */
  async createMenu(regs: RegisterFile, bus: SystemBus): Promise<void> {
    const menuAddr = regs.read(1);
    const x = regs.read(2);
    const y = regs.read(3);
    if (menuAddr === -1) return; // close menu

    const { title, items } = readMenu(bus, menuAddr);
    const selection = await this.host.showMenu(title, items, osUnitsToPx(x), osUnitsToPx(y));

    if (selection) {
      const blockAddr = regs.read(1);
      for (let i = 0; i < selection.length; i++) {
        bus.write32(blockAddr + i * 4, selection[i]!);
      }
      bus.write32(blockAddr + selection.length * 4, -1);
      // Menu selection delivered via native event route — push to host
      this.host.tryPollEvent; // (host delivers via deliverEvent internally)
    }
  }

  /** Wimp_ReportError (pure HLE — native dialog, no passthrough) */
  async reportError(regs: RegisterFile, bus: SystemBus): Promise<void> {
    const errBlock = regs.read(0);
    const flags    = regs.read(1);
    const nameAddr = regs.read(2);
    const message  = readString(bus, errBlock + 4);
    const name     = readString(bus, nameAddr);

    this.machine.cpu.swiPending = true;
    const button = await this.host.showError(message, flags, name);
    regs.write(1, button);
    this.machine.wakeFromSWI();
  }

  /**
   * Wimp_CreateIcon — for iconbar icons (winHandle = -2), add to native iconbar.
   * Always passthrough so ROM also tracks the icon.
   */
  createIcon(regs: RegisterFile, bus: SystemBus): WR {
    const blockAddr  = regs.read(1);
    const winHandle  = bus.read32(blockAddr) | 0;
    const flags = bus.read32(blockAddr + 20);

    if (winHandle === -2) {
      // Iconbar icon: extract sprite name from validation string ("Sspritename") or text
      let sprite = "application";
      let text   = "";
      if (flags & IF_INDIRECTED) {
        text       = readString(bus, bus.read32(blockAddr + 24));
        const vstr = readString(bus, bus.read32(blockAddr + 28));
        if (vstr && (vstr[0] === 'S' || vstr[0] === 's')) {
          sprite = vstr.slice(1);
        } else if (text) {
          sprite = text;
        }
      } else {
        text   = readString(bus, blockAddr + 24, 12);
        sprite = text || sprite;
      }

      const spriteData: SpriteData | undefined = this.spritePool?.get(sprite);
      console.log(`[Wimp_CreateIcon(-2)] sprite="${sprite}" spriteDataFound=${!!spriteData}`);
      this.host.setIconbarEntry(this.taskHandle, sprite, text || sprite, spriteData);
    }

    // Always passthrough — ROM tracks the icon and assigns the handle
    return 'passthrough';
  }

  /** Wimp_CloseDown — clean up native resources, then let ROM deregister the task */
  closeDown(_regs: RegisterFile, _bus: SystemBus): WR {
    this.host.removeIconbarEntry(this.taskHandle);
    for (const [handle] of this.windows) {
      this.host.destroyWindow(handle);
    }
    this.windows.clear();
    return 'passthrough';
  }

  /** Expose event push for host-side events (kept for backwards compat) */
  pushEvent(_ev: unknown): void { /* events now come via ROM poll passthrough */ }
}
