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
import type { MachineConfig } from "@theprogramminggiantpanda/shared";

const ARM2_CLOCK_HZ = 8_000_000;
const ARM3_CLOCK_HZ = 25_000_000;
const STEPS_PER_TICK = 10_000; // instructions per setTimeout slice

export class ArchimedesMachine {
  readonly cpu: ARM2CPU;
  readonly bus: SystemBus;
  readonly memc: MEMC;
  readonly ioc:  IOC;

  private running  = false;
  private paused   = false;
  private tickHandle: ReturnType<typeof setTimeout> | null = null;

  mhz = 0;
  private cycleSnapshot = 0;
  private lastMeasure   = 0;

  constructor(private readonly config: MachineConfig) {
    this.memc = new MEMC();
    this.ioc  = new IOC();

    // VIDC stub — satisfies bus constructor but does nothing (no hardware rendering)
    const vidcStub = {
      write: () => {},
      displayWidth:  640,
      displayHeight: 512,
      bpp:           4 as 4,
      renderFrame:   () => {},
    } as unknown as import("./chips/vidc.js").VIDC;

    this.bus = new SystemBus(config.ramSize, vidcStub, this.memc, this.ioc);
    this.cpu = new ARM2CPU(this.bus, config.cpuVariant as CpuVariant);

    this.ioc.onIRQ = () => this.cpu.triggerIRQ();
    this.ioc.onFIQ = () => this.cpu.triggerFIQ();
    this.bus.onDataAbort = () => this.cpu.triggerDataAbort();
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
  }

  start(): void {
    this.running = true;
    this.paused  = false;
    this.reset();
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

  private scheduleTick(): void {
    this.tickHandle = setTimeout(() => this.tick(), 0);
  }

  private tick(): void {
    if (!this.running || this.paused) return;

    const clockHz  = (this.config.cpuVariant === "ARM3" ? ARM3_CLOCK_HZ : ARM2_CLOCK_HZ)
                     * this.config.speedMultiplier;
    const steps    = this.config.speedMultiplier === 0
      ? STEPS_PER_TICK * 10   // uncapped
      : STEPS_PER_TICK;

    this.cpu.step(steps);
    this.ioc.tick(Math.floor((steps / clockHz) * 1_000_000));

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
