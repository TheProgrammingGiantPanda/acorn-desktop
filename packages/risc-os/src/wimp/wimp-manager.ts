/**
 * WimpManager — implements Wimp_* SWIs.
 *
 * Most SWIs are intercepted for native side-effects (creating BrowserWindows,
 * updating the iconbar, etc.) and then passed through to the ROM so that ROM's
 * own Wimp state stays correct.  Only Wimp_Poll and the canvas-redraw pair
 * (Wimp_RedrawWindow / Wimp_GetRectangle) are handled entirely in JS.
 *
 * Task tracking
 * ─────────────
 * RISC OS uses cooperative multitasking: a task switch can only happen inside
 * Wimp_Poll (ROM runs other tasks then returns to the caller).  We identify the
 * currently-running task by reading MEMC's translation of logical 0x8000 — the
 * physical base address of the application slot changes every time ROM remaps
 * for a different task.  This gives us a stable, ROM-authoritative task ID
 * without needing to intercept every task-management SWI ourselves.
 */

import type { RegisterFile, SwiReturnHook } from "@theprogramminggiantpanda/arm-emulator";
import type { SystemBus }    from "@theprogramminggiantpanda/arm-emulator";
import type { NativeHost, NativeMenuItem } from "./native-host.js";
import { Logger } from "@theprogramminggiantpanda/shared";
import {
  type WimpWindowDef, type WimpIcon, type WimpWindow,
  WimpEvent, IF_INDIRECTED, IF_TEXT,
  osUnitsToPx,
} from "./types.js";
import type { ArchimedesMachine } from "@theprogramminggiantpanda/arm-emulator";
import type { SpritePool, SpriteData } from "../sprite/sprite-pool.js";

/** Return type for WimpManager handler methods — mirrors SwiHandler return type */
type WR = void | 'passthrough' | { passthrough: true; afterReturn: SwiReturnHook };

// ---------------------------------------------------------------------------
// Per-task state
// ---------------------------------------------------------------------------

interface WimpTask {
  /** ROM-assigned task handle (from Wimp_Initialise R1 on exit) */
  handle:   number;
  name:     string;
  /** Physical address that logical 0x8000 translated to when the task initialised */
  physBase: number;
  /** Set of window handles created by this task (for cleanup on CloseDown) */
  windows:  Set<number>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Read a Wimp window definition block from RAM (R1) */
function readWindowDef(bus: SystemBus, addr: number): WimpWindowDef {
  const r = (off: number) => bus.read32(addr + off) | 0;
  const titleFlags = r(72);
  let title = "";
  if (titleFlags & IF_INDIRECTED) {
    title = readString(bus, r(76));
  } else if (titleFlags & IF_TEXT) {
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
  let ptr = addr + 28;
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
    if (flags & (1 << 7)) break;
    ptr += 24;
  }
  return { title, items };
}

// ---------------------------------------------------------------------------
// WimpManager
// ---------------------------------------------------------------------------

export class WimpManager {
  /** All registered tasks, keyed by ROM task handle */
  private tasks = new Map<number, WimpTask>();
  /** Same tasks, keyed by the physical address of logical 0x8000 at init time */
  private tasksByPhysBase = new Map<number, WimpTask>();

  /** All windows across all tasks, keyed by window handle */
  private windows = new Map<number, WimpWindow>();

  private machine!: ArchimedesMachine;
  private spritePool: SpritePool | null = null;

  // ── OS_Plot / VDU drawing state ────────────────────────────────────────────
  private currentRedrawHandle: number | null = null;
  private graphicsX = 0;
  private graphicsY = 0;
  private fgColour = "#000000";
  private pendingCmds: import("./native-host.js").DrawCommand[] = [];

  constructor(
    private readonly host: NativeHost,
    private readonly logger: Logger = new Logger(),
  ) {}

  setMachine(m: ArchimedesMachine): void { this.machine = m; }
  setSpritePool(pool: SpritePool): void  { this.spritePool = pool; }

  // ---------------------------------------------------------------------------
  // Task resolution
  // ---------------------------------------------------------------------------

  /**
   * Returns the WimpTask whose application slot (logical 0x8000) is currently
   * mapped by MEMC — i.e. whichever task the ARM CPU is running right now.
   *
   * Returns null if the task has not yet called Wimp_Initialise (e.g. during
   * the ROM boot sequence before any task registers).
   */
  private currentTask(): WimpTask | null {
    const phys = this.machine.memc.translateAddress(0x8000);
    if (phys === null) return null;
    return this.tasksByPhysBase.get(phys) ?? null;
  }

  // ---------------------------------------------------------------------------
  // SWI implementations
  // ---------------------------------------------------------------------------

  /**
   * Wimp_Initialise — read task name, passthrough to ROM, then afterReturn:
   *   - records ROM's task handle (R1)
   *   - snapshots MEMC's physical base for 0x8000 as this task's identity key
   */
  initialise(regs: RegisterFile, bus: SystemBus): WR {
    const name = readString(bus, regs.read(2));
    this.logger.debug(`[Wimp_Initialise] task="${name}" → passthrough to ROM`);
    return {
      passthrough: true,
      afterReturn: (_r) => {
        const handle   = _r.read(1);
        const physBase = this.machine.memc.translateAddress(0x8000) ?? 0;
        const task: WimpTask = { handle, name, physBase, windows: new Set() };
        this.tasks.set(handle, task);
        this.tasksByPhysBase.set(physBase, task);
        this.logger.debug(`[Wimp_Initialise] afterReturn: task="${name}" handle=${handle} physBase=0x${physBase.toString(16)} totalTasks=${this.tasks.size}`);
      },
    };
  }

  /**
   * Wimp_CreateWindow — passthrough to ROM first; afterReturn creates the native
   * BrowserWindow using the handle ROM assigned (R1 on exit) and registers it
   * under the current task.
   */
  createWindow(regs: RegisterFile, bus: SystemBus): WR {
    const def  = readWindowDef(bus, regs.read(1));
    const task = this.currentTask();
    this.logger.debug(`[Wimp_CreateWindow] title="${def.title}" task=${task?.handle} → passthrough to ROM`);
    return {
      passthrough: true,
      afterReturn: (r) => {
        const handle = r.read(1);
        this.logger.debug(`[Wimp_CreateWindow] afterReturn: handle=${handle} title="${def.title}" task=${task?.handle}`);
        this.host.createWindow(handle, def);
        this.windows.set(handle, { handle, def, icons: new Map(), open: false, dirty: true });
        task?.windows.add(handle);
        this.logger.debug(`[Wimp_CreateWindow] BrowserWindow created handle=${handle} totalWindows=${this.windows.size}`);
      },
    };
  }

  /** Wimp_OpenWindow — update native window, then let ROM update its state */
  openWindow(regs: RegisterFile, bus: SystemBus): WR {
    const blockAddr = regs.read(1);
    const handle = bus.read32(blockAddr) | 0;
    const win    = this.windows.get(handle);
    this.logger.debug(`[Wimp_OpenWindow] handle=${handle} found=${!!win}`);
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
    this.logger.debug(`[Wimp_CloseWindow] handle=${handle} found=${!!win}`);
    if (win) {
      win.open = false;
      this.host.closeWindow(handle);
    }
    return 'passthrough';
  }

  /** Wimp_DeleteWindow — destroy native window, let ROM clean up */
  deleteWindow(regs: RegisterFile, bus: SystemBus): WR {
    const handle = bus.read32(regs.read(1)) | 0;
    this.logger.debug(`[Wimp_DeleteWindow] handle=${handle}`);
    this.host.destroyWindow(handle);
    this.windows.delete(handle);
    for (const task of this.tasks.values()) task.windows.delete(handle);
    return 'passthrough';
  }

  /**
   * Wimp_Poll / Wimp_PollIdle
   *
   * 1. Sync-check our native event queue (mouse, window, keyboard events).
   * 2. If empty, passthrough to ROM — ROM may have messages/events queued for
   *    this or other tasks, or it may run other tasks and return null.
   * 3. If ROM also returns Null, suspend the CPU and wait for the next native event.
   *
   * Task identity: the task calling poll is whatever MEMC has mapped at 0x8000
   * right now.  After ROM's poll returns (step 2), MEMC may have switched to a
   * different task.  If we reach step 3, MEMC is unchanged (we suspended before
   * any switch) so the waking event correctly belongs to the current task.
   */
  poll(regs: RegisterFile, bus: SystemBus, _pollIdle: boolean): WR {
    const mask      = regs.read(0);
    const blockAddr = regs.read(1);

    // Fast path: native event already waiting
    const pending = this.host.tryPollEvent(mask);
    this.logger.debug(`[Wimp_Poll] mask=0x${mask.toString(16)} pending=${pending?.code ?? 'none'} task=${this.currentTask()?.handle}`);
    if (pending) {
      for (let i = 0; i < pending.data.length; i++) {
        bus.write32(blockAddr + i * 4, pending.data[i]!);
      }
      regs.write(0, pending.code);
      return;
    }

    // Snapshot the current task's physical base so we can reject this hook
    // if ROM switches to a different task before returning here (cooperative
    // multitasking: ROM may restore another task's context — same logical
    // return address, different MEMC mapping).
    const physBaseAtPush = this.machine.memc.translateAddress(0x8000) ?? 0;

    // Let ROM check its own queue (Wimp_SendMessage deliveries, etc.)
    return {
      passthrough: true,
      afterReturn: (r, b) => {
        const currentPhys = this.machine.memc.translateAddress(0x8000) ?? 0;
        if (currentPhys !== physBaseAtPush) {
          // ROM switched to a different task — this is not our return. Decline.
          return false;
        }
        const romCode = r.read(0);
        this.logger.debug(`[Wimp_Poll] afterReturn: ROM returned event=${romCode} task=${this.currentTask()?.handle}`);
        if (romCode !== WimpEvent.Null && !((mask >> romCode) & 1)) {
          // ROM delivered a real unmasked event — already written to the block.
          this.logger.debug(`[Wimp_Poll] ROM event delivered code=${romCode}`);
          return;
        }
        // ROM returned Null. Suspend and wait for a native event.
        this.logger.debug(`[Wimp_Poll] suspending CPU, awaiting native event`);
        this.machine.cpu.swiPending = true;
        void this.host.pollEvent(mask).then((ev) => {
          this.logger.debug(`[Wimp_Poll] native event arrived code=${ev.code} data=[${ev.data.slice(0,4).join(',')}]`);
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
    if (!win) { regs.write(0, 0); return; }

    const d = win.def;
    bus.write32(blockAddr + 0,  d.visX0);
    bus.write32(blockAddr + 4,  d.visY0);
    bus.write32(blockAddr + 8,  d.visX1);
    bus.write32(blockAddr + 12, d.visY1);
    bus.write32(blockAddr + 16, d.scrollX);
    bus.write32(blockAddr + 20, d.scrollY);
    bus.write32(blockAddr + 24, win.open ? -1 : 0);
    bus.write32(blockAddr + 28, d.flags | (win.open ? 0x10000 : 0));
    regs.write(0, 1);

    this.currentRedrawHandle = handle;
    this.pendingCmds = [
      { type: "os_setup", x: d.scrollX, y: d.scrollY,
        w: d.visX1 - d.visX0, h: d.visY1 - d.visY0 },
      { type: "clear", x: 0, y: 0 },
    ];
  }

  /**
   * Wimp_GetRectangle — ends the canvas redraw loop; flushes draw commands
   * to the native window canvas (pure HLE, no passthrough).
   */
  getWindowRect(regs: RegisterFile, _bus: SystemBus): void {
    regs.write(0, 0);
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
          this.pendingCmds.push({ type: "os_line",
            x: this.graphicsX, y: this.graphicsY, w: absX, h: absY,
            colour: this.fgColour });
          break;
        case 12:
          this.pendingCmds.push({ type: "os_rect",
            x: Math.min(this.graphicsX, absX), y: Math.min(this.graphicsY, absY),
            w: Math.abs(absX - this.graphicsX), h: Math.abs(absY - this.graphicsY),
            colour: this.fgColour });
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
    if (menuAddr === -1) return;

    const { title, items } = readMenu(bus, menuAddr);
    const selection = await this.host.showMenu(
      title, items, osUnitsToPx(regs.read(2)), osUnitsToPx(regs.read(3)));

    if (selection) {
      const blockAddr = regs.read(1);
      for (let i = 0; i < selection.length; i++) {
        bus.write32(blockAddr + i * 4, selection[i]!);
      }
      bus.write32(blockAddr + selection.length * 4, -1);
    }
  }

  /** Wimp_ReportError (pure HLE — native dialog, no passthrough) */
  async reportError(regs: RegisterFile, bus: SystemBus): Promise<void> {
    const message = readString(bus, regs.read(0) + 4);
    const name    = readString(bus, regs.read(2));

    this.machine.cpu.swiPending = true;
    const button = await this.host.showError(message, regs.read(1), name);
    regs.write(1, button);
    this.machine.wakeFromSWI();
  }

  /**
   * Wimp_CreateIcon — for iconbar icons (winHandle = -2), add to native iconbar
   * under the current task's handle.  Always passthrough so ROM tracks the icon.
   */
  createIcon(regs: RegisterFile, bus: SystemBus): WR {
    const blockAddr = regs.read(1);
    const winHandle = bus.read32(blockAddr) | 0;
    const flags     = bus.read32(blockAddr + 20);

    if (winHandle === -2) {
      let sprite = "application";
      let text   = "";
      if (flags & IF_INDIRECTED) {
        text       = readString(bus, bus.read32(blockAddr + 24));
        const vstr = readString(bus, bus.read32(blockAddr + 28));
        if (vstr && (vstr[0] === 'S' || vstr[0] === 's')) sprite = vstr.slice(1);
        else if (text) sprite = text;
      } else {
        text   = readString(bus, blockAddr + 24, 12);
        sprite = text || sprite;
      }

      const task       = this.currentTask();
      const taskHandle = task?.handle ?? 0;
      const spriteData: SpriteData | undefined = this.spritePool?.get(sprite);
      this.logger.debug(`[Wimp_CreateIcon(-2)] task=${taskHandle} sprite="${sprite}" spriteDataFound=${!!spriteData}`);
      this.host.setIconbarEntry(taskHandle, sprite, text || sprite, spriteData);
    }

    return 'passthrough';
  }

  /**
   * Wimp_CloseDown — destroy only this task's windows and remove its iconbar
   * entry, then passthrough so ROM deregisters the task.
   */
  closeDown(_regs: RegisterFile, _bus: SystemBus): WR {
    const task = this.currentTask();
    if (task) {
      this.host.removeIconbarEntry(task.handle);
      for (const handle of task.windows) {
        this.host.destroyWindow(handle);
        this.windows.delete(handle);
      }
      this.tasks.delete(task.handle);
      this.tasksByPhysBase.delete(task.physBase);
      this.logger.debug(`[Wimp_CloseDown] task="${task.name}" handle=${task.handle}`);
    }
    return 'passthrough';
  }

  /** Expose event push for host-side events (kept for backwards compat) */
  pushEvent(_ev: unknown): void { /* events now come via ROM poll passthrough */ }
}
