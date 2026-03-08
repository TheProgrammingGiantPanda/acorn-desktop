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
    cpu.swiHandlers.set(SWI.OS_SpriteOp,  (r, b) => spriteHandler.handleOS(r, b));
    cpu.swiHandlers.set(SWI.Wimp_SpriteOp,(r, b) => spriteHandler.handleWimp(r, b));

    // Stubs for less critical SWIs — acknowledge without doing anything
    const stub = () => {};
    for (const n of [
      SWI.Wimp_GetWindowInfo, SWI.Wimp_SetIconState, SWI.Wimp_GetIconState,
      SWI.Wimp_DragBox, SWI.Wimp_SetCaretPosition, SWI.Wimp_GetCaretPosition,
      SWI.Wimp_DecodeMenu, SWI.Wimp_WhichIcon, SWI.Wimp_SetExtent,
      SWI.Wimp_SetPointerShape, SWI.Wimp_OpenTemplate, SWI.Wimp_CloseTemplate,
      SWI.Wimp_LoadTemplate, SWI.Wimp_ProcessKey,
      // Wimp_StartTask (0x400DE) is intentionally absent — passthrough to ROM
      SWI.Wimp_GetWindowOutline, SWI.Wimp_PlotIcon, SWI.Wimp_SetMode,
      SWI.Wimp_CreateSubMenu, SWI.Wimp_SetFontColours,
      SWI.Wimp_GetMenuState, SWI.Wimp_TextColour,
    ]) {
      cpu.swiHandlers.set(n, stub);
    }

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

    // Font stubs
    for (const n of [
      SWI.Font_FindFont, SWI.Font_LoseFont, SWI.Font_Paint,
      SWI.Font_StringWidth, SWI.Font_SetFontColours,
    ]) {
      cpu.swiHandlers.set(n, stub);
    }

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
