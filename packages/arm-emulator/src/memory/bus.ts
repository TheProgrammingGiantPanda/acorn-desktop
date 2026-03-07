/**
 * Acorn Archimedes System Bus / Memory Controller
 *
 * Physical memory map (ARM2 physical addresses):
 *
 *   0x0000_0000 – 0x01FF_FFFF  Logical RAM (via MEMC)
 *   0x0200_0000 – 0x03FF_FFFF  Physical RAM (up to 4MB on A305/A310)
 *   0x0400_0000 – 0x1FFF_FFFF  (unmapped / expansion)
 *   0x2000_0000 – 0x27FF_FFFF  I/O (IOC) and Video (VIDC) registers
 *   0x3200_0000 – 0x3200_001F  IOC registers
 *   0x3500_0000 – 0x35FF_FFFF  VIDC write-only registers
 *   0x36E0_0000 – 0x36FF_FFFF  MEMC control registers
 *   0x3400_0000 – 0x37FF_FFFF  ROM (4 MB window)
 *
 * At reset, ROM is also visible at 0x0000_0000 until MEMC releases.
 */

import type { VIDC } from "../chips/vidc.js";
import type { MEMC } from "../chips/memc.js";
import type { IOC }  from "../chips/ioc.js";

const ROM_BASE   = 0x3400_0000;
const ROM_END    = 0x37FF_FFFF;
const VIDC_BASE  = 0x3500_0000;
const VIDC_END   = 0x35FF_FFFF;
const IOC_BASE   = 0x3200_0000;
const IOC_END    = 0x323F_FFFF;
const MEMC_BASE  = 0x36E0_0000;
const MEMC_END   = 0x36FF_FFFF;
const PHYS_RAM_BASE = 0x0200_0000;

export class SystemBus {
  private ram: Uint8Array;
  private rom: Uint8Array;
  private romActive = true; // ROM mapped at 0 until MEMC releases

  constructor(
    ramBytes: number,
    private readonly vidc: VIDC,
    private readonly memc: MEMC,
    private readonly ioc: IOC,
  ) {
    this.ram = new Uint8Array(ramBytes);
    this.rom = new Uint8Array(0); // loaded via loadROM()
  }

  loadROM(data: Uint8Array): void {
    this.rom = new Uint8Array(data);
  }

  releaseROMAlias(): void {
    this.romActive = false;
  }

  // --------------------------------------------------------------------------
  // 32-bit read/write (aligned)
  // --------------------------------------------------------------------------
  read32(addr: number): number {
    addr = addr >>> 0;
    const aligned = addr & ~3;

    if (this.romActive && aligned < this.rom.length) {
      return this.readROM32(aligned);
    }
    // Peripheral regions must be checked before the broad ROM window (0x3400-0x37FF)
    // because MEMC (0x36E0), VIDC (0x3500), and IOC (0x3200) all fall within it.
    if (aligned >= IOC_BASE && aligned <= IOC_END) {
      return this.ioc.read(aligned - IOC_BASE);
    }
    if (aligned >= MEMC_BASE && aligned <= MEMC_END) {
      return this.memc.readControl(aligned - MEMC_BASE);
    }
    if (aligned >= ROM_BASE && aligned <= ROM_END) {
      return this.readROM32(aligned - ROM_BASE);
    }
    if (aligned >= PHYS_RAM_BASE && aligned < PHYS_RAM_BASE + this.ram.length) {
      return this.readRAM32(aligned - PHYS_RAM_BASE);
    }
    if (aligned < this.ram.length) {
      // Logical RAM (simplified — MEMC translation omitted)
      return this.readRAM32(aligned);
    }
    return 0xDEAD_BEEF; // open bus
  }

  write32(addr: number, value: number): void {
    addr = addr >>> 0;
    const aligned = addr & ~3;

    if (aligned >= VIDC_BASE && aligned <= VIDC_END) {
      this.vidc.write(value >>> 0);
      return;
    }
    if (aligned >= MEMC_BASE && aligned <= MEMC_END) {
      this.memc.writeControl(aligned - MEMC_BASE, value >>> 0);
      return;
    }
    if (aligned >= IOC_BASE && aligned <= IOC_END) {
      this.ioc.write(aligned - IOC_BASE, value >>> 0);
      return;
    }
    if (aligned >= PHYS_RAM_BASE && aligned < PHYS_RAM_BASE + this.ram.length) {
      this.writeRAM32(aligned - PHYS_RAM_BASE, value >>> 0);
      return;
    }
    if (aligned < this.ram.length) {
      this.writeRAM32(aligned, value >>> 0);
    }
    // ROM writes are ignored
  }

  // --------------------------------------------------------------------------
  // 8-bit read/write
  // --------------------------------------------------------------------------
  read8(addr: number): number {
    addr = addr >>> 0;
    const w = this.read32(addr & ~3);
    const shift = (addr & 3) * 8;
    return (w >>> shift) & 0xFF;
  }

  write8(addr: number, value: number): void {
    addr = addr >>> 0;
    const aligned = addr & ~3;
    const shift = (addr & 3) * 8;
    const old = this.read32(aligned);
    this.write32(aligned, (old & ~(0xFF << shift)) | ((value & 0xFF) << shift));
  }

  // --------------------------------------------------------------------------
  // Raw RAM / ROM helpers
  // --------------------------------------------------------------------------
  private readRAM32(offset: number): number {
    if (offset + 3 >= this.ram.length) return 0;
    return (this.ram[offset]! |
            (this.ram[offset + 1]! << 8) |
            (this.ram[offset + 2]! << 16) |
            (this.ram[offset + 3]! << 24)) >>> 0;
  }

  private writeRAM32(offset: number, value: number): void {
    if (offset + 3 >= this.ram.length) return;
    this.ram[offset]     = value & 0xFF;
    this.ram[offset + 1] = (value >>> 8)  & 0xFF;
    this.ram[offset + 2] = (value >>> 16) & 0xFF;
    this.ram[offset + 3] = (value >>> 24) & 0xFF;
  }

  private readROM32(offset: number): number {
    if (offset + 3 >= this.rom.length) return 0;
    return (this.rom[offset]! |
            (this.rom[offset + 1]! << 8) |
            (this.rom[offset + 2]! << 16) |
            (this.rom[offset + 3]! << 24)) >>> 0;
  }

  /** Direct RAM read for DMA (e.g. VIDC DMA) */
  dmaRead(physAddr: number, length: number): Uint8Array {
    const offset = physAddr >= PHYS_RAM_BASE
      ? physAddr - PHYS_RAM_BASE
      : physAddr;
    return this.ram.subarray(offset, offset + length);
  }

  /** Direct RAM write for DMA (e.g. file load) */
  dmaWrite(physAddr: number, data: Uint8Array): void {
    const offset = physAddr >= PHYS_RAM_BASE
      ? physAddr - PHYS_RAM_BASE
      : physAddr;
    const end = Math.min(offset + data.length, this.ram.length);
    this.ram.set(data.subarray(0, end - offset), offset);
  }
}
