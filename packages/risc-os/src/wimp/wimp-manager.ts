/**
 * WimpManager — implements all Wimp_* SWIs.
 *
 * Reads/writes data from ARM RAM via the SystemBus, calls NativeHost to
 * manage real OS windows, and feeds events back via Wimp_Poll.
 */

import type { RegisterFile } from "@theprogramminggiantpanda/arm-emulator";
import type { SystemBus }    from "@theprogramminggiantpanda/arm-emulator";
import type { NativeHost, NativeMenuItem } from "./native-host.js";
import { WimpEventQueue }   from "./event-queue.js";
import {
  type WimpWindowDef, type WimpIcon, type WimpWindow,
  WimpEvent, WF_HAS_TITLE, IF_INDIRECTED, IF_TEXT,
  osUnitsToPx, pxToOsUnits,
} from "./types.js";
import type { ArchimedesMachine } from "@theprogramminggiantpanda/arm-emulator";

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

/** Write a window state block back to RAM (for Wimp_GetWindowState) */
function writeWindowState(bus: SystemBus, addr: number, win: WimpWindow): void {
  const d = win.def;
  bus.write32(addr + 0,  d.visX0);
  bus.write32(addr + 4,  d.visY0);
  bus.write32(addr + 8,  d.visX1);
  bus.write32(addr + 12, d.visY1);
  bus.write32(addr + 16, d.scrollX);
  bus.write32(addr + 20, d.scrollY);
  bus.write32(addr + 24, win.open ? -1 : 0); // behind
  bus.write32(addr + 28, d.flags | (win.open ? 0x10000 : 0));
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
  private nextHandle = 1;
  readonly events  = new WimpEventQueue();
  private taskName = "Unknown";
  private taskHandle = 0;
  private machine!: ArchimedesMachine;

  constructor(private readonly host: NativeHost) {}

  setMachine(m: ArchimedesMachine): void { this.machine = m; }

  // ---------------------------------------------------------------------------
  // SWI implementations — each method maps to one Wimp_* SWI
  // ---------------------------------------------------------------------------

  /** Wimp_Initialise (SWI 0x400C0) */
  initialise(regs: RegisterFile, bus: SystemBus): void {
    // R0 = minimum Wimp version needed, R1 = "TASK", R2 = ptr to task name
    const nameAddr = regs.read(2);
    this.taskName   = readString(bus, nameAddr);
    this.taskHandle = this.nextHandle++;
    regs.write(0, 310);             // Wimp version we claim (3.10)
    regs.write(1, this.taskHandle); // task handle
    this.host.setIconbarEntry(this.taskHandle, "application", this.taskName);
  }

  /** Wimp_CreateWindow (SWI 0x400C1) */
  async createWindow(regs: RegisterFile, bus: SystemBus): Promise<void> {
    const blockAddr = regs.read(1);
    const def = readWindowDef(bus, blockAddr);
    const handle = this.nextHandle++;

    const win: WimpWindow = { handle, def, icons: new Map(), open: false, dirty: true };
    this.windows.set(handle, win);

    await this.host.createWindow(handle, def);
    regs.write(0, handle);
  }

  /** Wimp_OpenWindow (SWI 0x400C5) */
  async openWindow(regs: RegisterFile, bus: SystemBus): Promise<void> {
    const blockAddr = regs.read(1);
    const handle = bus.read32(blockAddr) | 0;
    const win    = this.windows.get(handle);
    if (!win) return;

    win.def.visX0   = bus.read32(blockAddr + 4)  | 0;
    win.def.visY0   = bus.read32(blockAddr + 8)  | 0;
    win.def.visX1   = bus.read32(blockAddr + 12) | 0;
    win.def.visY1   = bus.read32(blockAddr + 16) | 0;
    win.def.scrollX = bus.read32(blockAddr + 20) | 0;
    win.def.scrollY = bus.read32(blockAddr + 24) | 0;
    win.def.behind  = bus.read32(blockAddr + 28) | 0;
    win.open = true;

    await this.host.openWindow(handle, win.def);

    // Immediately queue a Redraw event so the app redraws the window
    this.events.push({ code: WimpEvent.Redraw, data: [handle] });
  }

  /** Wimp_CloseWindow (SWI 0x400C6) */
  async closeWindow(regs: RegisterFile, bus: SystemBus): Promise<void> {
    const handle = bus.read32(regs.read(1)) | 0;
    const win = this.windows.get(handle);
    if (!win) return;
    win.open = false;
    await this.host.closeWindow(handle);
    this.events.push({ code: WimpEvent.Close, data: [handle] });
  }

  /** Wimp_DeleteWindow (SWI 0x400C3) */
  async deleteWindow(regs: RegisterFile, bus: SystemBus): Promise<void> {
    const handle = bus.read32(regs.read(1)) | 0;
    await this.host.destroyWindow(handle);
    this.windows.delete(handle);
  }

  /**
   * Wimp_Poll / Wimp_PollIdle (SWI 0x400C7 / 0x400E1)
   *
   * Puts the CPU into pending state, waits for an event, then writes it
   * into the block at R1 and resumes.
   */
  async poll(regs: RegisterFile, bus: SystemBus, _pollIdle: boolean): Promise<void> {
    const mask      = regs.read(0);
    const blockAddr = regs.read(1);

    this.machine.cpu.swiPending = true;

    const ev = await this.host.pollEvent(mask);

    // Write event data block
    for (let i = 0; i < ev.data.length; i++) {
      bus.write32(blockAddr + i * 4, ev.data[i]!);
    }
    regs.write(0, ev.code);

    this.machine.wakeFromSWI();
  }

  /** Wimp_RedrawWindow (SWI 0x400C8) — enters the redraw loop */
  redrawWindow(regs: RegisterFile, bus: SystemBus): void {
    const blockAddr = regs.read(1);
    const handle    = bus.read32(blockAddr) | 0;
    const win       = this.windows.get(handle);
    if (win) {
      writeWindowState(bus, blockAddr, win);
      regs.write(0, 1); // non-zero = there is a rectangle to redraw
    } else {
      regs.write(0, 0); // unknown window — nothing to draw
    }
  }

  /**
   * Wimp_GetRectangle (SWI 0x400CA) — advances the redraw loop.
   *
   * We always return R0=0 (no more rectangles) since we give apps one
   * dirty rect per redraw event.  Before returning we capture the window's
   * region from the VIDC frame buffer and push the pixels to the native canvas.
   */
  getWindowRect(regs: RegisterFile, bus: SystemBus): void {
    const blockAddr = regs.read(1);
    const handle    = bus.read32(blockAddr) | 0;
    const win       = this.windows.get(handle);

    regs.write(0, 0); // no more rectangles

    if (win?.open) {
      const result = this.machine.captureWindowRegion(
        win.def.visX0, win.def.visY0, win.def.visX1, win.def.visY1,
      );
      if (result) {
        this.host.updateWindowPixels(handle, result.pixels, result.width, result.height);
      }
    }
  }

  /** Wimp_GetWindowState (SWI 0x400CB) */
  getWindowState(regs: RegisterFile, bus: SystemBus): void {
    const blockAddr = regs.read(1);
    const handle    = bus.read32(blockAddr) | 0;
    const win = this.windows.get(handle);
    if (win) writeWindowState(bus, blockAddr, win);
  }

  /** Wimp_ForceRedraw (SWI 0x400D1) */
  forceRedraw(regs: RegisterFile, _bus: SystemBus): void {
    const handle = regs.read(0);
    const win = this.windows.get(handle);
    if (win) {
      win.dirty = true;
      this.events.push({ code: WimpEvent.Redraw, data: [handle] });
    }
  }

  /** Wimp_CreateMenu (SWI 0x400D4) */
  async createMenu(regs: RegisterFile, bus: SystemBus): Promise<void> {
    const menuAddr = regs.read(1);
    const x = regs.read(2);
    const y = regs.read(3);
    if (menuAddr === -1) {
      // Close any open menu — no-op for native menus
      return;
    }
    const { title, items } = readMenu(bus, menuAddr);
    const selection = await this.host.showMenu(title, items, osUnitsToPx(x), osUnitsToPx(y));

    if (selection) {
      const blockAddr = regs.read(1); // selection written to a known buffer — simplified
      for (let i = 0; i < selection.length; i++) {
        bus.write32(blockAddr + i * 4, selection[i]!);
      }
      bus.write32(blockAddr + selection.length * 4, -1);
      this.events.push({ code: WimpEvent.MenuSelection, data: selection });
    }
  }

  /** Wimp_ReportError (SWI 0x400DF) */
  async reportError(regs: RegisterFile, bus: SystemBus): Promise<void> {
    const errBlock = regs.read(0);
    const flags    = regs.read(1);
    const nameAddr = regs.read(2);
    const message  = readString(bus, errBlock + 4); // skip 4-byte error number
    const name     = readString(bus, nameAddr);

    this.machine.cpu.swiPending = true;
    const button = await this.host.showError(message, flags, name);
    regs.write(1, button);
    this.machine.wakeFromSWI();
  }

  /** Wimp_GetPointerInfo (SWI 0x400CF) */
  getPointerInfo(regs: RegisterFile, bus: SystemBus): void {
    const blockAddr = regs.read(1);
    const info = this.host.getPointerInfo();
    bus.write32(blockAddr + 0,  info.x);
    bus.write32(blockAddr + 4,  info.y);
    bus.write32(blockAddr + 8,  info.buttons);
    bus.write32(blockAddr + 12, info.winHandle);
    bus.write32(blockAddr + 16, info.iconHandle);
  }

  /** Wimp_SlotSize (SWI 0x400EC) */
  slotSize(regs: RegisterFile, _bus: SystemBus): void {
    // R0 = requested slot size, -1 = don't change; R1 = next slot
    // Return the machine's RAM size as both current and next
    const ram = 1 * 1024 * 1024; // 1 MB
    regs.write(0, ram);
    regs.write(1, ram);
    regs.write(2, ram * 2);
  }

  /** Wimp_ReadSysInfo (SWI 0x400F2) */
  readSysInfo(regs: RegisterFile, _bus: SystemBus): void {
    switch (regs.read(0)) {
      case 0: // screen mode
        regs.write(0, 27); // mode 27 = 800×600 256-colour
        break;
      case 1: // Wimp version
        regs.write(0, 310);
        break;
      case 2: // number of tasks
        regs.write(0, 1);
        break;
      case 5: // monitor type
        regs.write(0, 4); // SVGA
        break;
      case 7: // desk size
        regs.write(0, pxToOsUnits(1280));
        regs.write(1, pxToOsUnits(1024));
        break;
    }
  }

  /** Wimp_CloseDown (SWI 0x400DD) */
  closeDown(_regs: RegisterFile, _bus: SystemBus): void {
    this.host.removeIconbarEntry(this.taskHandle);
    for (const [handle] of this.windows) {
      this.host.destroyWindow(handle);
    }
    this.windows.clear();
  }

  /** Wimp_SendMessage (SWI 0x400E7) */
  sendMessage(regs: RegisterFile, bus: SystemBus): void {
    // Simplified: just deliver to our own event queue
    const blockAddr = regs.read(2);
    const size   = bus.read32(blockAddr)     & 0xFFFF;
    const action = bus.read32(blockAddr + 16);
    const data: number[] = [];
    for (let i = 0; i * 4 < size; i++) {
      data.push(bus.read32(blockAddr + i * 4));
    }
    this.events.push({ code: WimpEvent.UserMessage, data });
    void action;
  }

  /** Wimp_CreateIcon (SWI 0x400C2) — adds icon to a window */
  createIcon(regs: RegisterFile, bus: SystemBus): void {
    const blockAddr  = regs.read(1);
    const winHandle  = bus.read32(blockAddr) | 0;
    const iconHandle = this.nextHandle++;
    const icon: WimpIcon = {
      x0: bus.read32(blockAddr + 4)  | 0,
      y0: bus.read32(blockAddr + 8)  | 0,
      x1: bus.read32(blockAddr + 12) | 0,
      y1: bus.read32(blockAddr + 16) | 0,
      flags: bus.read32(blockAddr + 20),
      text: "", sprite: "", validation: "", maxLen: 0,
    };
    const flags = icon.flags;
    if (flags & IF_INDIRECTED) {
      icon.text       = readString(bus, bus.read32(blockAddr + 24));
      icon.validation = readString(bus, bus.read32(blockAddr + 28));
      icon.maxLen     = bus.read32(blockAddr + 32);
    } else {
      icon.text = readString(bus, blockAddr + 24, 12);
    }

    if (winHandle === -2) {
      // Iconbar icon: extract sprite name from validation ("Sspritename") or text
      let sprite = "application";
      if (icon.validation && (icon.validation[0] === 'S' || icon.validation[0] === 's')) {
        sprite = icon.validation.slice(1);
      } else if (icon.text) {
        sprite = icon.text;
      }
      this.host.setIconbarEntry(iconHandle, sprite, icon.text || sprite);
      regs.write(0, iconHandle);
      return;
    }

    const win = this.windows.get(winHandle);
    if (win) {
      win.icons.set(iconHandle, icon);
      this.host.updateIcon(winHandle, iconHandle, icon);
    }
    regs.write(0, iconHandle);
  }

  /** Expose event queue push for host-side events */
  pushEvent(ev: Parameters<WimpEventQueue["push"]>[0]): void {
    this.events.push(ev);
  }
}
