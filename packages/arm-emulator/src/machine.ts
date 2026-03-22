/**
 * Archimedes Machine
 *
 * Wires together the CPU, RAM, ROM, and system bus.
 * Video output and window management are handled externally via SWI handlers
 * registered by the risc-os package — the machine itself has no display.
 */

import { ARM2CPU, type SwiHandler, type CpuVariant } from "./cpu/arm2.js";
import { SystemBus } from "./memory/bus.js";
import { MEMC } from "./chips/memc.js";
import { IOC }  from "./chips/ioc.js";
import { VIDC } from "./chips/vidc.js";
import type { MachineConfig } from "@theprogramminggiantpanda/shared";
import { Logger } from "@theprogramminggiantpanda/shared";

const ARM2_CLOCK_HZ = 8_000_000;
const ARM3_CLOCK_HZ = 25_000_000;
const STEPS_PER_TICK = 10_000; // instructions per setTimeout slice

export class ArchimedesMachine {
  readonly cpu:  ARM2CPU;
  readonly bus:  SystemBus;
  readonly memc: MEMC;
  readonly ioc:  IOC;
  readonly vidc: VIDC;

  private running  = false;
  private paused   = false;
  private tickHandle: ReturnType<typeof setTimeout> | null = null;

  /** True when the real ROM has been booted (vs. bare-program HLE mode). */
  romBooted = false;

  mhz = 0;
  private cycleSnapshot = 0;
  private lastMeasure   = 0;
  private _dataAbortCount = 0;

  /** Accumulated emulated microseconds since last VBL — drives 50 Hz VBL IRQ. */
  private vblAccumUs = 0;
  private static readonly VBL_PERIOD_US = 20_000; // 50 Hz = 20 ms

  constructor(private readonly config: MachineConfig, private readonly logger = new Logger()) {
    this.memc = new MEMC();
    this.ioc  = new IOC();

    this.vidc = new VIDC();
    this.bus = new SystemBus(config.ramSize, this.vidc, this.memc, this.ioc);
    this.cpu = new ARM2CPU(this.bus, config.cpuVariant as CpuVariant, logger);

    this.ioc.onIRQ = () => this.cpu.triggerIRQ();
    this.ioc.onFIQ = () => this.cpu.triggerFIQ();
    this.bus.onDataAbort = () => {
      if (this._dataAbortCount < 5) {
        this._dataAbortCount++;
        const pc = this.cpu.regs.pc.toString(16).padStart(8, '0');
        this.logger.debug(`[data abort #${this._dataAbortCount}] PC=0x${pc}`);
      }
      this.cpu.triggerDataAbort();
    };
  }

  loadROM(data: Uint8Array): void {
    this.bus.loadROM(data);
  }

  /**
   * Load an ARM binary into logical RAM and prepare the CPU to run it.
   *
   * Releases the ROM alias (making logical RAM visible at address 0), writes
   * the binary at `addr` (default 0x8000), and plants an unconditional branch
   * at address 0 so the CPU jumps there on its first instruction fetch.
   *
   * Must be called after `start()` but before the first CPU tick executes
   * (i.e. synchronously, since ticks are scheduled via setTimeout).
   */
  loadProgram(data: Uint8Array, addr = 0x8000): void {
    if (addr < 8) throw new RangeError(`loadProgram: addr must be >= 8, got 0x${addr.toString(16)}`);
    this.bus.releaseROMAlias();

    // ARM branch encoding: 0xEA000000 | signed_offset_words
    // offset = (target - (PC + 8)) / 4; at address 0, PC+8 = 8
    const offset = ((addr - 8) >>> 2) & 0x00FF_FFFF;
    const branch = (0xEA00_0000 | offset) >>> 0;
    this.bus.dmaWrite(0, new Uint8Array([
      branch         & 0xFF,
      (branch >>>  8) & 0xFF,
      (branch >>> 16) & 0xFF,
      (branch >>> 24) & 0xFF,
    ]));

    this.bus.dmaWrite(addr, data);
  }

  /**
   * Write data to physical RAM at the given offset (bypassing MEMC).
   * The data will be accessible at the same logical address when that logical
   * address >= 0x80000 (in the emulator's linear-mapped region).
   */
  writePhysical(physOffset: number, data: Uint8Array): void {
    this.bus.dmaWrite(physOffset, data);
  }

  /**
   * Capture the VIDC frame buffer and extract the rectangular region that
   * corresponds to a RISC OS window's visible area.
   *
   * @param osX0/osY0/osX1/osY1  Window visible area in OS units (Y increases upward)
   * @returns RGBA pixel data + dimensions, or null if the screen isn't set up yet
   */
  captureWindowRegion(
    osX0: number, osY0: number, osX1: number, osY1: number,
  ): { pixels: Uint8ClampedArray; width: number; height: number } | null {
    const sw = this.vidc.displayWidth;
    const sh = this.vidc.displayHeight;
    if (sw <= 0 || sh <= 0) return null;

    const bpp      = this.vidc.bpp;
    const frameLen = Math.ceil(sw * sh * bpp / 8);
    const screenRAM = this.bus.dmaRead(this.memc.videoDMAStart, frameLen);

    const fullRGBA = new Uint8ClampedArray(sw * sh * 4);
    this.vidc.renderFrame(screenRAM, fullRGBA);

    // OS units → pixels  (typically 2 OS units = 1 pixel)
    const px0 = Math.max(0, Math.min(sw, Math.round(osX0 / 2)));
    const px1 = Math.max(0, Math.min(sw, Math.round(osX1 / 2)));
    // RISC OS Y increases upward; frame buffer Y=0 is at the top
    const py0 = Math.max(0, Math.min(sh, sh - Math.round(osY1 / 2)));
    const py1 = Math.max(0, Math.min(sh, sh - Math.round(osY0 / 2)));

    const rw = px1 - px0;
    const rh = py1 - py0;
    if (rw <= 0 || rh <= 0) return null;

    const pixels = new Uint8ClampedArray(rw * rh * 4);
    for (let y = 0; y < rh; y++) {
      const srcOff = ((py0 + y) * sw + px0) * 4;
      pixels.set(fullRGBA.subarray(srcOff, srcOff + rw * 4), y * rw * 4);
    }
    return { pixels, width: rw, height: rh };
  }

  /**
   * Execute a RISC OS CLI command via the ROM's own CLI handler.
   *
   * Writes a tiny ARM stub + null-terminated command string to a scratch area
   * in RAM (0x7E000) and wakes the CPU to execute it.  The stub calls
   * SWI OS_CLI which passthroughs to ROM — the ROM's Obey interpreter handles
   * *commands, !Run scripts, and ARM binaries natively.
   *
   * The CPU must be suspended (swiPending = true) before calling this method,
   * which is the normal state while the Wimp desktop is idle in Wimp_Poll.
   */
  execCLI(command: string): void {
    if (!this.cpu.swiPending) return; // CPU is running — cannot safely inject

    const SCRATCH = 0x7E000; // scratch area just below the HostFS module
    const enc = new TextEncoder().encode(command + '\0');
    const stub = new Uint8Array(12 + enc.length);
    const view = new DataView(stub.buffer);

    // ADD R0, PC, #4  — when this executes, PC = SCRATCH+8, so R0 = SCRATCH+12
    view.setUint32(0, 0xE28F0004, true);
    // SWI OS_CLI (0x05) — passthroughs to ROM in ROM boot mode
    view.setUint32(4, 0xEF000005, true);
    // B . — infinite loop / halt if OS_CLI ever returns (e.g. non-Wimp command)
    view.setUint32(8, 0xEAFFFFFE, true);
    stub.set(enc, 12);

    this.bus.dmaWrite(SCRATCH, stub);
    // Point LR at the halt so unexpected returns land safely
    this.cpu.regs.write(14, SCRATCH + 8);
    this.cpu.regs.pc = SCRATCH;
    this.wakeFromSWI();
  }

  /**
   * Run a brief ARM routine at the given logical address.
   * Assumes the CPU is currently suspended (swiPending = true).
   * The routine should end with SWI sentinelSwiNum.
   * Resolves when the sentinel SWI fires.
   * Restores CPU registers on completion.
   */
  runArmCallback(routineLogicalAddr: number, sentinelSwiNum: number): Promise<void> {
    return new Promise((resolve) => {
      const savedR15 = this.cpu.regs.r15;
      const savedR0  = this.cpu.regs.read(0);
      const savedR1  = this.cpu.regs.read(1);
      const savedR2  = this.cpu.regs.read(2);
      const savedR3  = this.cpu.regs.read(3);

      this.cpu.swiHandlers.set(sentinelSwiNum, () => {
        this.cpu.swiHandlers.delete(sentinelSwiNum);
        // Restore saved registers
        this.cpu.regs.r15 = savedR15;
        this.cpu.regs.write(0, savedR0);
        this.cpu.regs.write(1, savedR1);
        this.cpu.regs.write(2, savedR2);
        this.cpu.regs.write(3, savedR3);
        // Re-suspend CPU — caller will resume normally
        this.cpu.swiPending = true;
        resolve();
      });

      // Set PC to our routine (keep current flags/mode in R15)
      this.cpu.regs.pc = routineLogicalAddr;
      // Resume CPU to execute the routine
      this.wakeFromSWI();
    });
  }

  /** Register a SWI handler by SWI number */
  registerSWI(swiNum: number, handler: SwiHandler): void {
    this.cpu.swiHandlers.set(swiNum, handler);
  }

  /** Register multiple SWI handlers at once */
  registerSWIs(handlers: Record<number, SwiHandler>): void {
    for (const [num, handler] of Object.entries(handlers)) {
      this.cpu.swiHandlers.set(Number(num), handler);
    }
  }

  reset(): void {
    this.memc.reset();
    this.ioc.reset();
    this.cpu.reset();
    this.cycleSnapshot = 0;
    this.lastMeasure   = Date.now();
    this.vblAccumUs    = 0;
    this.romBooted     = false;
  }

  /**
   * Load a RISC OS ARM binary into application space without disturbing the
   * MEMC/IOC state from the ROM boot.  The binary is written to the physical
   * RAM that the current MEMC mapping assigns to `logicalAddr`, so the OS page
   * tables remain intact.  Only the CPU program counter and mode are changed.
   */
  startApp(data: Uint8Array, logicalAddr = 0x8000): void {
    this.stop();

    // Ensure the application slot has valid MEMC mappings for the full Wimp
    // slot.  After ROM boot the OS should have mapped application space, but if
    // any pages are missing we fill them in using the next available physical
    // pages so the AIF decompressor can write the decompressed image.
    const maxPPN = Math.floor(this.config.ramSize / this.memc.pageSize);
    this.memc.forceMapRange(logicalAddr, 512 * 1024, maxPPN);

    // Resolve the physical RAM offset using the ROM's current MEMC mapping.
    const phys = this.memc.translateAddress(logicalAddr);
    const writeDest = phys !== null ? phys : logicalAddr;
    // Release the ROM alias so logical addresses < rom.length go through MEMC/RAM
    // rather than returning ROM data. The ROM boot has already completed.
    this.bus.releaseROMAlias();

    // Install minimal exception handlers only in HLE mode (no ROM boot).
    // When the real ROM has booted it programs its own vectors in RAM — we must
    // not overwrite them or IRQ/SWI dispatch will break.
    if (!this.romBooted) {
      // The ROM relied on the ROM alias for exception handling; after releasing it,
      // those vectors are zeros which cause infinite zero-RAM traversal on any fault.
      // MOVS PC, R14 (0xE1B0F00E) = return from exception, skipping the faulted instr.
      // B .         (0xEAFFFFFE) = infinite loop (halt) for vectors we never expect.
      const vecPhys = this.memc.translateAddress(0);
      if (vecPhys !== null) {
        const MOVS_PC_R14 = 0xE1B0F00E;
        const B_SELF      = 0xEAFFFFFE;
        const writeVec = (logOff: number, instr: number) => {
          this.bus.dmaWrite(vecPhys + logOff, new Uint8Array([
            instr & 0xFF, (instr >>> 8) & 0xFF, (instr >>> 16) & 0xFF, (instr >>> 24) & 0xFF,
          ]));
        };
        writeVec(0x00, B_SELF);       // Reset — should never fire
        writeVec(0x04, B_SELF);       // Undefined instruction — halt
        writeVec(0x08, MOVS_PC_R14); // SWI — return (our JS handler intercepts first)
        writeVec(0x0C, MOVS_PC_R14); // Prefetch abort — skip
        writeVec(0x10, MOVS_PC_R14); // Data abort — skip faulted instruction
        writeVec(0x14, B_SELF);       // Reserved — halt
        writeVec(0x18, MOVS_PC_R14); // IRQ — return
        writeVec(0x1C, MOVS_PC_R14); // FIQ — return
      }
    }

    this.bus.dmaWrite(writeDest, data);

    // Switch CPU to User mode (mode bits = 0) and set the entry point.
    // Preserve flags in R15; only update mode and PC.
    this.cpu.regs.r15 = (this.cpu.regs.r15 & ~0x03) >>> 0; // clear mode bits → User
    this.cpu.regs.pc  = logicalAddr;

    // Set up registers as RISC OS would before calling an ARM application.
    // R13 (SP): stack pointer — top of a 32 KB Wimp slot (0x8000 + 32KB = 0x10000)
    // R5:       secondary frame pointer used by some Acorn C runtime stubs
    // R14 (LR): return address — 0 causes the CPU to halt via the Reset vector
    const APP_STACK_TOP = logicalAddr + 0x8000; // 32 KB above load address
    this.cpu.regs.write(5,  APP_STACK_TOP);
    this.cpu.regs.write(13, APP_STACK_TOP);
    this.cpu.regs.write(14, 0);
    this.cpu.halted      = false;
    this.cpu.swiPending  = false;
    this._dataAbortCount = 0;
    this.cycleSnapshot   = 0;
    this.lastMeasure     = Date.now();

    this.running = true;
    this.paused  = false;
    this.scheduleTick();
  }

  start(): void {
    this.running = true;
    this.paused  = false;
    this.reset();
    this.scheduleTick();
  }

  /**
   * Boot the machine by executing the loaded ROM from address 0.
   *
   * Unlike `start()` + `loadProgram()`, this does NOT install any HLE stubs at
   * address 0 or release the ROM alias manually — the ROM itself releases the
   * alias when it writes the MEMC control register.  SWI handlers registered
   * via `registerSWI()` still intercept Wimp and OS SWIs before the ROM's own
   * SWI vector is reached, so native-window Wimp rendering continues to work.
   *
   * A RISC OS ROM image must have been loaded with `loadROM()` before calling
   * this method.
   */
  bootROM(): void {
    this.reset();
    this.running   = true;
    this.paused    = false;
    this.romBooted = true;
    this.scheduleTick();
  }

  stop(): void {
    this.running = false;
    if (this.tickHandle !== null) {
      clearTimeout(this.tickHandle);
      this.tickHandle = null;
    }
  }

  pause():  void { this.paused = true; }
  resume(): void { this.paused = false; }

  /** Called externally when an async SWI (e.g. Wimp_Poll) completes */
  wakeFromSWI(): void {
    this.cpu.resumeFromSWI();
    if (this.running && !this.paused) this.scheduleTick();
  }

  scheduleTick(): void {
    this.tickHandle = setTimeout(() => this.tick(), 0);
  }

  private tick(): void {
    if (!this.running || this.paused) return;

    const clockHz  = (this.config.cpuVariant === "ARM3" ? ARM3_CLOCK_HZ : ARM2_CLOCK_HZ)
                     * this.config.speedMultiplier;
    const steps    = this.config.speedMultiplier === 0
      ? STEPS_PER_TICK * 10   // uncapped
      : STEPS_PER_TICK;

    try {
      this.cpu.step(steps);
    } catch (err) {
      const pc = this.cpu.regs.pc.toString(16).padStart(8, '0');
      this.logger.error(`[CPU crash] PC=0x${pc} — ${err}`);
      this.running = false;
      return;
    }
    const stepUs = Math.floor((steps / clockHz) * 1_000_000);
    this.ioc.tick(stepUs);

    // Fire vertical-blank interrupt at ~50 Hz so the ROM task switcher wakes.
    this.vblAccumUs += stepUs;
    if (this.vblAccumUs >= ArchimedesMachine.VBL_PERIOD_US) {
      this.vblAccumUs -= ArchimedesMachine.VBL_PERIOD_US;
      this.ioc.vblank();
    }

    // MHz measurement
    const now = Date.now();
    if (now - this.lastMeasure >= 1000) {
      const delta = this.cpu.cycleCount - this.cycleSnapshot;
      this.mhz = parseFloat((delta / 1_000_000).toFixed(2));
      this.cycleSnapshot = this.cpu.cycleCount;
      this.lastMeasure   = now;
    }

    // Keep looping unless a SWI put the CPU into pending state
    if (!this.cpu.swiPending) this.scheduleTick();
  }
}
