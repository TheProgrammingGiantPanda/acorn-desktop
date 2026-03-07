/**
 * Archimedes Machine
 *
 * Top-level emulator that wires together CPU, chips, and bus.
 * Runs the emulation loop and produces video frames.
 */

import { ARM2CPU, type CpuVariant } from "./cpu/arm2.js";
import { SystemBus } from "./memory/bus.js";
import { VIDC } from "./chips/vidc.js";
import { MEMC } from "./chips/memc.js";
import { IOC }  from "./chips/ioc.js";
import type { MachineConfig } from "@acorn/shared";

/** Archimedes base clock frequencies */
const ARM2_CLOCK_HZ = 8_000_000;  // 8 MHz
const ARM3_CLOCK_HZ = 25_000_000; // 25 MHz

/** Target frame rate */
const TARGET_FPS = 50; // PAL

export interface FrameCallback {
  (pixels: Uint8ClampedArray, width: number, height: number): void;
}

export class ArchimedesMachine {
  readonly cpu: ARM2CPU;
  readonly bus: SystemBus;
  readonly vidc: VIDC;
  readonly memc: MEMC;
  readonly ioc: IOC;

  private frameBuffer: Uint8ClampedArray;
  private running = false;
  private paused  = false;
  private frameCallback?: FrameCallback;

  /** Measured performance */
  fps = 0;
  mhz = 0;

  private lastFrameTime = 0;
  private frameCount = 0;

  constructor(private readonly config: MachineConfig) {
    this.vidc = new VIDC();
    this.memc = new MEMC();
    this.ioc  = new IOC();
    this.bus  = new SystemBus(config.ramSize, this.vidc, this.memc, this.ioc);
    this.cpu  = new ARM2CPU(this.bus, config.cpuVariant as CpuVariant);

    // Wire IOC interrupts to CPU
    this.ioc.onIRQ = () => this.cpu.triggerIRQ();
    this.ioc.onFIQ = () => this.cpu.triggerFIQ();

    // Initial frame buffer (will be resized on first frame)
    this.frameBuffer = new Uint8ClampedArray(640 * 512 * 4);
  }

  loadROM(data: Uint8Array): void {
    this.bus.loadROM(data);
  }

  onFrame(cb: FrameCallback): void {
    this.frameCallback = cb;
  }

  reset(): void {
    this.memc.reset();
    this.ioc.reset();
    this.cpu.reset();
    this.frameCount = 0;
    this.lastFrameTime = Date.now();
  }

  pause(): void  { this.paused = true; }
  resume(): void { this.paused = false; }

  start(): void {
    this.running = true;
    this.paused  = false;
    this.reset();
    this.runLoop();
  }

  stop(): void {
    this.running = false;
  }

  private runLoop(): void {
    if (!this.running) return;

    const clockHz = (this.config.cpuVariant === "ARM3" ? ARM3_CLOCK_HZ : ARM2_CLOCK_HZ)
                    * this.config.speedMultiplier;
    const cyclesPerFrame = Math.floor(clockHz / TARGET_FPS);

    const tick = () => {
      if (!this.running) return;
      if (!this.paused) {
        this.executeFrame(cyclesPerFrame);
      }
      // Schedule next frame (use setImmediate/setTimeout in Node, requestAnimationFrame in renderer)
      if (typeof requestAnimationFrame !== "undefined") {
        requestAnimationFrame(tick);
      } else {
        setImmediate(tick);
      }
    };

    if (typeof requestAnimationFrame !== "undefined") {
      requestAnimationFrame(tick);
    } else {
      setImmediate(tick);
    }
  }

  private executeFrame(cycles: number): void {
    // Run CPU for one frame worth of cycles
    this.cpu.step(cycles);

    // IOC timer tick (~20ms per frame at 50Hz)
    this.ioc.tick(1_000_000 / TARGET_FPS);

    // Render frame via VIDC
    const w = this.vidc.displayWidth;
    const h = this.vidc.displayHeight;
    const needed = w * h * 4;
    if (this.frameBuffer.length !== needed) {
      this.frameBuffer = new Uint8ClampedArray(needed);
    }

    if (this.memc.videoDMAEnabled) {
      const screenRAM = this.bus.dmaRead(
        this.memc.videoDMAStart,
        Math.ceil((w * h * this.vidc.bpp) / 8)
      );
      this.vidc.renderFrame(screenRAM, this.frameBuffer);
    }

    // Signal VBL to IOC
    this.ioc.vblank();

    this.frameCallback?.(this.frameBuffer, w, h);

    // FPS counter
    this.frameCount++;
    const now = Date.now();
    const elapsed = now - this.lastFrameTime;
    if (elapsed >= 1000) {
      this.fps = Math.round((this.frameCount * 1000) / elapsed);
      this.mhz = parseFloat(((this.cpu.cycleCount / elapsed) / 1000).toFixed(1));
      this.frameCount = 0;
      this.cpu.cycleCount = 0;
      this.lastFrameTime = now;
    }
  }
}
