/**
 * SWI Dispatcher
 *
 * Registers all RISC OS SWI handlers onto an ArchimedesMachine.
 * The machine's CPU will call these instead of vectoring to ROM.
 */

import type { ArchimedesMachine } from "@theprogramminggiantpanda/arm-emulator";
import type { NativeHost } from "../wimp/native-host.js";
import type { FileSystemHost } from "../fs/fs-host.js";
import { WimpManager } from "../wimp/wimp-manager.js";
import { OSFileHandler } from "../fs/os-fs.js";
import { makeOSHandlers, type OutputCallback } from "./os-core.js";
import { SystemVariables, type VarType } from "../sysvar/sysvar.js";
import { ObeyInterpreter } from "../obey/obey.js";
import { SpriteAreaRegistry } from "../sprite/sprite-pool.js";
import { ModuleRegistry } from "../modules/module-registry.js";
import { OSSpriteHandler } from "../sprite/os-sprite.js";
import * as SWI from "../swi-numbers.js";

export interface DispatcherOptions {
  /** Called when the emulated program writes text output */
  onOutput?: OutputCallback;
  /**
   * Filesystem for the ObeyInterpreter to read !Run / !Boot scripts.
   * When omitted, Obey cannot execute script files (inline commands still work).
   */
  obeyFs?: FileSystemHost;
  /**
   * If provided, HLE OS file-system SWIs (OS_File, OS_Find, OS_Args,
   * OS_BGet, OS_BPut, OS_GBPB, OS_FSControl) are registered on the CPU.
   * Omit in ROM boot mode — the real ROM FileSwitch handles those SWIs.
   */
  fs?: FileSystemHost;
  /** Called when an Obey Run command targets an ARM binary */
  onRunBinary?: (riscosPath: string) => void;
  /**
   * Called when Service_StartFiler (&4D) is broadcast — the Filer has started
   * and modules should add their disc icons to the iconbar.
   */
  onServiceStartFiler?: () => void;
}

export class SwiDispatcher {
  readonly wimp:         WimpManager;
  readonly sysvar:       SystemVariables;
  readonly obey:         ObeyInterpreter;
  readonly spriteAreas:  SpriteAreaRegistry;
  readonly modules:      ModuleRegistry;

  constructor(
    private readonly machine: ArchimedesMachine,
    host: NativeHost,
    options: DispatcherOptions = {},
  ) {
    this.wimp        = new WimpManager(host);
    this.wimp.setMachine(machine);
    this.sysvar      = new SystemVariables();
    this.spriteAreas = new SpriteAreaRegistry();
    this.wimp.setSpritePool(this.spriteAreas.system);
    this.modules     = new ModuleRegistry();
    this.obey        = new ObeyInterpreter(options.obeyFs ?? options.fs, this.sysvar, {
      onOutput:    options.onOutput,
      onRunBinary: options.onRunBinary,
      spritePool:  this.spriteAreas.system,
      modules:     this.modules,
    });
    this.registerAll(options.onOutput ?? (() => {}), options.fs, options);
  }

  private registerAll(output: OutputCallback, fs?: FileSystemHost, options: DispatcherOptions = {}): void {
    const m = this.machine;
    const cpu = m.cpu;

    // ── OS core ──────────────────────────────────────────────────────────────
    const os = makeOSHandlers(m, output);
    cpu.swiHandlers.set(SWI.OS_WriteC,       os.OS_WriteC);
    cpu.swiHandlers.set(SWI.OS_Write0,       os.OS_Write0);
    cpu.swiHandlers.set(SWI.OS_NewLine,      os.OS_NewLine);
    cpu.swiHandlers.set(SWI.OS_Exit,         os.OS_Exit);
    cpu.swiHandlers.set(SWI.OS_GetEnv,       os.OS_GetEnv);
    cpu.swiHandlers.set(SWI.OS_Byte,         os.OS_Byte);
    cpu.swiHandlers.set(SWI.OS_IntOn,        os.OS_IntOn);
    cpu.swiHandlers.set(SWI.OS_IntOff,       os.OS_IntOff);
    cpu.swiHandlers.set(SWI.OS_Mouse,        os.OS_Mouse);
    cpu.swiHandlers.set(SWI.OS_ReadModeVar,  os.OS_ReadModeVar);
    cpu.swiHandlers.set(SWI.OS_Heap,         os.OS_Heap);
    cpu.swiHandlers.set(SWI.OS_WriteN,       os.OS_WriteN);

    // OS_ServiceCall (SWI &30): intercept Service_StartFiler then pass to ROM
    cpu.swiHandlers.set(SWI.OS_ServiceCall, (regs) => {
      const service = regs.read(1) >>> 0;
      // Service_StartFiler = 0x4D: Filer is starting, modules should add disc icons
      if (service === 0x4D) {
        options.onServiceStartFiler?.();
      }
      return 'passthrough'; // Always let ROM dispatch to modules too
    });

    // ── System variables ──────────────────────────────────────────────────────
    const { sysvar, obey } = this;

    // OS_CLI: passthrough to ROM — the ROM's CLI handler interprets *commands,
    // Obey scripts, and ARM binaries natively.  We must not intercept it here
    // or we shadow the ROM's own command processing in ROM boot mode.

    cpu.swiHandlers.set(SWI.OS_ReadVarVal, (regs, bus) => {
      const name  = readCString(bus, regs.read(0));
      const bufAddr = regs.read(1);
      const bufLen  = regs.read(2);
      const value = sysvar.get(name);
      if (value === undefined) {
        regs.C = true;
        regs.write(2, -1 >>> 0);
        return;
      }
      const bytes = new TextEncoder().encode(value);
      if (bufLen > 0) {
        const n = Math.min(bytes.length, bufLen);
        for (let i = 0; i < n; i++) bus.write8(bufAddr + i, bytes[i]!);
        regs.write(2, n);
      } else {
        // R2=0: caller just wants the length
        regs.write(2, bytes.length);
      }
      regs.C = false;
    });

    cpu.swiHandlers.set(SWI.OS_SetVarVal, (regs, bus) => {
      const name    = readCString(bus, regs.read(0));
      const valAddr = regs.read(1);
      const valLen  = regs.read(2) | 0; // signed
      const type    = regs.read(4);

      if (valAddr === 0 || valLen < 0) {
        sysvar.unset(name);
        return;
      }

      let value: string;
      if (valLen === 0) {
        value = readCString(bus, valAddr);
      } else {
        const bytes = new Uint8Array(valLen);
        for (let i = 0; i < valLen; i++) bytes[i] = bus.read8(valAddr + i);
        value = new TextDecoder().decode(bytes);
      }

      const varType: VarType = type === 2 ? 'macro' : type === 1 ? 'number' : 'string';
      sysvar.set(name, value, varType);
    });

    // ── Wimp ─────────────────────────────────────────────────────────────────
    const w = this.wimp;

    cpu.swiHandlers.set(SWI.Wimp_Initialise, (r, b) => w.initialise(r, b));

    // Async Wimp calls: fire-and-forget, suspending the CPU until wakeFromSWI()
    cpu.swiHandlers.set(SWI.Wimp_CreateWindow,
      (r, b) => { m.cpu.swiPending = true; void w.createWindow(r, b).then(() => m.wakeFromSWI()); });

    cpu.swiHandlers.set(SWI.Wimp_OpenWindow,
      (r, b) => { m.cpu.swiPending = true; void w.openWindow(r, b).then(() => m.wakeFromSWI()); });

    cpu.swiHandlers.set(SWI.Wimp_CloseWindow,
      (r, b) => { m.cpu.swiPending = true; void w.closeWindow(r, b).then(() => m.wakeFromSWI()); });

    cpu.swiHandlers.set(SWI.Wimp_DeleteWindow,
      (r, b) => { m.cpu.swiPending = true; void w.deleteWindow(r, b).then(() => m.wakeFromSWI()); });

    cpu.swiHandlers.set(SWI.Wimp_Poll,
      (r, b) => { void w.poll(r, b, false); });

    cpu.swiHandlers.set(SWI.Wimp_PollIdle,
      (r, b) => { void w.poll(r, b, true); });

    cpu.swiHandlers.set(SWI.Wimp_RedrawWindow,    (r, b) => w.redrawWindow(r, b));
    cpu.swiHandlers.set(SWI.Wimp_UpdateWindow,    (r, b) => w.redrawWindow(r, b));
    cpu.swiHandlers.set(SWI.Wimp_GetRectangle,    (r, b) => w.getWindowRect(r, b));
    cpu.swiHandlers.set(SWI.Wimp_GetWindowState,  (r, b) => w.getWindowState(r, b));
    cpu.swiHandlers.set(SWI.Wimp_ForceRedraw,     (r, b) => w.forceRedraw(r, b));
    cpu.swiHandlers.set(SWI.Wimp_CreateIcon,      (r, b) => w.createIcon(r, b));
    cpu.swiHandlers.set(SWI.Wimp_GetPointerInfo,  (r, b) => w.getPointerInfo(r, b));
    cpu.swiHandlers.set(SWI.Wimp_SlotSize,        (r, b) => w.slotSize(r, b));
    cpu.swiHandlers.set(SWI.Wimp_ReadSysInfo,     (r, b) => w.readSysInfo(r, b));
    cpu.swiHandlers.set(SWI.Wimp_CloseDown,       (r, b) => w.closeDown(r, b));
    cpu.swiHandlers.set(SWI.Wimp_SendMessage,     (r, b) => w.sendMessage(r, b));

    cpu.swiHandlers.set(SWI.Wimp_CreateMenu,
      (r, b) => { m.cpu.swiPending = true; void w.createMenu(r, b).then(() => m.wakeFromSWI()); });

    cpu.swiHandlers.set(SWI.Wimp_ReportError,
      (r, b) => { void w.reportError(r, b); });

    // ── Sprite operations ─────────────────────────────────────────────────────
    const spriteHandler = new OSSpriteHandler(this.spriteAreas, fs);

    cpu.swiHandlers.set(SWI.OS_SpriteOp, (regs, bus) => {
      // Save the area selector and pointer before any register modification
      const r0 = regs.read(0);
      const r1 = regs.read(1);  // sprite area ptr (user areas only)
      const isUserArea = !!(r0 & 0x100);

      // HLE: handle locally (file loads, info queries).
      // This runs regardless of ROM availability.
      spriteHandler.handleOS(regs, bus);

      // Passthrough: let ROM also run so its internal state stays in sync.
      // afterReturn: invalidate the user-area cache so the next getUserPool()
      // call re-parses any changes ROM may have written into ARM memory.
      return {
        passthrough: true,
        afterReturn: (_r, b) => {
          if (isUserArea) this.spriteAreas.invalidateUser(r1);
          void b; // bus available if needed for future system-area sync
        },
      };
    });

    cpu.swiHandlers.set(SWI.Wimp_SpriteOp, (r, b) => spriteHandler.handleWimp(r, b));

    // All remaining Wimp_* SWIs passthrough to ROM.
    // The ROM's Wimp handles GetWindowInfo, SetIconState, ProcessKey, SetExtent,
    // SetMode, etc. correctly.  No-op stubs were actively harmful — they
    // returned zeroed registers where apps expected real data.

    // ── File system ───────────────────────────────────────────────────────────
    if (fs) {
      const fsHandler = new OSFileHandler(fs);
      cpu.swiHandlers.set(SWI.OS_File,      (r, b) => fsHandler.file(r, b));
      cpu.swiHandlers.set(SWI.OS_Find,      (r, b) => fsHandler.find(r, b));
      cpu.swiHandlers.set(SWI.OS_Args,      (r, b) => fsHandler.args(r, b));
      cpu.swiHandlers.set(SWI.OS_BGet,      (r, b) => fsHandler.bget(r, b));
      cpu.swiHandlers.set(SWI.OS_BPut,      (r, b) => fsHandler.bput(r, b));
      cpu.swiHandlers.set(SWI.OS_GBPB,      (r, b) => fsHandler.gbpb(r, b));
      cpu.swiHandlers.set(SWI.OS_FSControl, (r, b) => fsHandler.fsControl(r, b));
    }

    // Font_* SWIs passthrough to ROM — the ROM's font manager handles them.

    // ── Graphics interception (OS_Plot / OS_SetColour) ────────────────────────
    //
    // We intercept OS_Plot to build per-window canvas draw commands during
    // Wimp redraw loops.  OS_SetColour lets us track the current draw colour.
    // All other VDU/graphics calls passthrough to ROM.

    cpu.swiHandlers.set(SWI.OS_Plot, (regs) => {
      const code = regs.read(0);
      const x    = regs.read(1) | 0; // signed 32-bit
      const y    = regs.read(2) | 0;
      this.wimp.osPlot(code, x, y);
      return 'passthrough'; // let ROM update its own graphics state too
    });

    cpu.swiHandlers.set(SWI.OS_SetColour, (regs) => {
      const action = regs.read(0) >>> 0;
      const colour = regs.read(1) >>> 0;

      // colour is either a logical palette index (0–15) or a ColourTrans
      // physical colour (&BBGGRR00: bits 31:24=B, 23:16=G, 15:8=R, 7:0=0).
      let css: string;
      if (colour <= 15) {
        // Logical colour — look up in the VIDC palette the ROM has programmed
        const palEntry = this.machine.vidc.palette[colour] ?? 0;
        const r = ((palEntry)       & 0xF) * 17;
        const g = ((palEntry >>> 4) & 0xF) * 17;
        const b = ((palEntry >>> 8) & 0xF) * 17;
        css = `rgb(${r},${g},${b})`;
      } else {
        // ColourTrans physical colour &BBGGRR00
        const r = (colour >>> 8)  & 0xFF;
        const g = (colour >>> 16) & 0xFF;
        const b = (colour >>> 24) & 0xFF;
        css = `rgb(${r},${g},${b})`;
      }

      if (action & 0x80) {
        this.wimp.setGraphicsBgColour(css);
      } else {
        this.wimp.setGraphicsFgColour(css);
      }
      return 'passthrough';
    });

  }

  /** Inject a Wimp event from the host (e.g. user clicked a button) */
  injectEvent(ev: Parameters<WimpManager["pushEvent"]>[0]): void {
    this.wimp.pushEvent(ev);
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

function readCString(bus: { read8(addr: number): number }, addr: number): string {
  let s = "";
  for (let i = 0; i < 4096; i++) {
    const c = bus.read8(addr + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}
