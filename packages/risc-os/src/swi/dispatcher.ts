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
import * as SWI from "../swi-numbers.js";

export interface DispatcherOptions {
  /** Called when the emulated program writes text output */
  onOutput?: OutputCallback;
  /** If provided, OS file-system SWIs (OS_File, OS_Find, etc.) are active */
  fs?: FileSystemHost;
}

export class SwiDispatcher {
  readonly wimp: WimpManager;

  constructor(
    private readonly machine: ArchimedesMachine,
    host: NativeHost,
    options: DispatcherOptions = {},
  ) {
    this.wimp = new WimpManager(host);
    this.wimp.setMachine(machine);
    this.registerAll(options.onOutput ?? (() => {}), options.fs);
  }

  private registerAll(output: OutputCallback, fs?: FileSystemHost): void {
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
    cpu.swiHandlers.set(SWI.OS_Module,       os.OS_Module);
    cpu.swiHandlers.set(SWI.OS_WriteN,       os.OS_WriteN);

    // ── Wimp ─────────────────────────────────────────────────────────────────
    const w = this.wimp;

    cpu.swiHandlers.set(SWI.Wimp_Initialise, (r, b) => w.initialise(r, b));

    // Async Wimp calls: wrap in a fire-and-forget that suspends the CPU
    const async_ = (fn: () => Promise<void>) => () => { void fn(); };

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

    // Stubs for less critical SWIs — acknowledge without doing anything
    const stub = () => {};
    for (const n of [
      SWI.Wimp_GetWindowInfo, SWI.Wimp_SetIconState, SWI.Wimp_GetIconState,
      SWI.Wimp_DragBox, SWI.Wimp_SetCaretPosition, SWI.Wimp_GetCaretPosition,
      SWI.Wimp_DecodeMenu, SWI.Wimp_WhichIcon, SWI.Wimp_SetExtent,
      SWI.Wimp_SetPointerShape, SWI.Wimp_OpenTemplate, SWI.Wimp_CloseTemplate,
      SWI.Wimp_LoadTemplate, SWI.Wimp_ProcessKey, SWI.Wimp_StartTask,
      SWI.Wimp_GetWindowOutline, SWI.Wimp_PlotIcon, SWI.Wimp_SetMode,
      SWI.Wimp_SpriteOp, SWI.Wimp_CreateSubMenu, SWI.Wimp_SetFontColours,
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

    // Suppress void from async_ usage warning
    void async_;
  }

  /** Inject a Wimp event from the host (e.g. user clicked a button) */
  injectEvent(ev: Parameters<WimpManager["pushEvent"]>[0]): void {
    this.wimp.pushEvent(ev);
  }
}
