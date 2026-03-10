/**
 * Acorn Archimedes System Bus / Memory Controller
 *
 * ARM2 physical address space is 26-bit (64 MB).
 * Archimedes memory map (all within 0x000_0000–0x3FF_FFFF):
 *
 *   0x000_0000 – 0x1FF_FFFF  Logical RAM (MEMC CAM-translated), State 0
 *   0x200_0000 – 0x2FF_FFFF  Physical RAM (direct)
 *   0x300_0000 – 0x33F_FFFF  I/O space (IOC at 0x320_0000)
 *   0x340_0000 – 0x37F_FFFF  ROM LOW (read) / VIDC (write 0x340–0x35F) / DMA (write 0x360–0x37F)
 *   0x380_0000 – 0x3BF_FFFF  ROM HIGH (read) / MEMC LOG2PHYS page-table (write)
 *
 * ROM Alias State Machine (ROMMapFlag):
 *   State 1 (initial): First read from 0x000–0x7FF_FFF → transitions to State 2, returns ROM data
 *   State 2:           0x000–0x7FF_FFF = ROM alias; 0x800–0x1FFF_FFF = ABORT;
 *                      any read ≥ 0x200_0000 → transitions to State 0
 *   State 0:           Normal MEMC operation
 */

import type { VIDC } from "../chips/vidc.js";
import type { MEMC } from "../chips/memc.js";
import type { IOC }  from "../chips/ioc.js";

// Archimedes memory map constants (26-bit address space)
const PHYS_RAM_BASE  = 0x0200_0000; // Physical RAM
const IO_BASE        = 0x0300_0000; // I/O space (IOC, etc.)
const IO_END         = 0x033F_FFFF;
const ROM_LOW_BASE   = 0x0340_0000; // ROM LOW (read) / VIDC+DMA (write)
const ROM_LOW_END    = 0x037F_FFFF;
const VIDC_BASE      = 0x0340_0000; // VIDC write range
const VIDC_END       = 0x035F_FFFF;
const DMA_BASE       = 0x0360_0000; // DMA / MEMC control write range
const DMA_END        = 0x037F_FFFF;

const ROM_HIGH_BASE  = 0x0380_0000; // ROM HIGH (read) / MEMC LOG2PHYS (write)
const ROM_HIGH_END   = 0x03BF_FFFF;
const IOC_BASE       = 0x0320_0000; // IOC registers (sub-range of I/O)
const IOC_END        = 0x0323_FFFF;
const LOGICAL_END    = 0x01FF_FFFF; // Top of MEMC logical address space

export class SystemBus {
  private ram: Uint8Array;
  private rom: Uint8Array;
  private romMask = 0;

  /**
   * ROM alias state machine:
   *   1 = State 1 (initial after reset): ROM aliased at 0x0, first access triggers → State 2
   *   2 = State 2: ROM direct at 0x0–0x7FFFFF, 0x800000–0x1FFFFFF aborts,
   *                first access ≥ 0x200000 triggers → State 0
   *   0 = State 0: normal MEMC operation
   */
  private romMapState: 0 | 1 | 2 = 1;

  /** Called when a logical-address translation fault occurs during a DATA access. */
  onDataAbort?: () => void;

  /**
   * Set to true if the most recent read32/read8 call was aborted by a MEMC
   * translation fault.  The CPU checks this after instruction fetches to take
   * a PREFETCH ABORT exception rather than a DATA ABORT.
   * Reset to false at the start of every read32 call.
   */
  readAborted = false;

  // Diagnostic: log first N peripheral accesses only
  private _iocReadCount   = 0;
  private _periWriteCount = 0;
  private readonly _IOC_READ_LIMIT    = 5000;
  private readonly _PERI_WRITE_LIMIT  = 5000;

  constructor(
    ramBytes: number,
    private readonly vidc: VIDC,
    private readonly memc: MEMC,
    private readonly ioc: IOC,
  ) {
    this.ram = new Uint8Array(ramBytes);
    this.rom = new Uint8Array(0);
  }

  get romSize(): number { return this.rom.length; }

  loadROM(data: Uint8Array): void {
    this.rom = new Uint8Array(data);
    // ROM mask for repeating: must be (power-of-two − 1).
    // Align size up to next power of two for the mask.
    let size = this.rom.length;
    let p = 1;
    while (p < size) p <<= 1;
    this.romMask = p - 1;
  }

  /** Force-release the ROM alias (used by tests / machine reset). */
  releaseROMAlias(): void {
    this.romMapState = 0;
  }

  // --------------------------------------------------------------------------
  // 32-bit read
  // --------------------------------------------------------------------------
  read32(addr: number): number {
    this.readAborted = false;
    addr = (addr >>> 0) & 0x3FF_FFFF; // 26-bit physical address
    const aligned = addr & ~3;

    // ---- State 1: first read from 0x0–0x7FFFFF triggers State1→State2 ----
    if (this.romMapState === 1) {
      if (aligned < 0x800000) {
        this.romMapState = 2;
        return this.readROM32(aligned & this.romMask);
      }
      // Addresses ≥ 0x800000 in State 1: fall through to normal handling
    }

    // ---- State 2 ----
    if (this.romMapState === 2) {
      if (aligned < 0x800000) {
        // ROM alias (no state transition)
        return this.readROM32(aligned & this.romMask);
      }
      if (aligned <= LOGICAL_END) {
        // 0x800000–0x1FFFFFF: abort.
        // Use readAborted flag so the CPU takes PABORT (instruction fetch) or
        // DABORT (data read) at the correct point, rather than firing the abort
        // callback synchronously mid-instruction (which could corrupt the PC).
        this.readAborted = true;
        return 0;
      }
      // Any read ≥ 0x2000000 transitions to State 0
      this.romMapState = 0;
      // Fall through to State 0 handling below
    }

    // ---- State 0: normal MEMC operation ----
    if (aligned >= ROM_HIGH_BASE && aligned <= ROM_HIGH_END) {
      return this.readROM32((aligned - ROM_HIGH_BASE) & this.romMask);
    }
    if (aligned >= ROM_LOW_BASE && aligned <= ROM_LOW_END) {
      // ROM LOW: same image, or return 0 if no ROMLow
      return this.readROM32((aligned - ROM_LOW_BASE) & this.romMask);
    }
    if (aligned >= IOC_BASE && aligned <= IOC_END) {
      const v = this.ioc.read(aligned - IOC_BASE);
      if (this._iocReadCount < this._IOC_READ_LIMIT) {
        this._iocReadCount++;
        console.debug(`[BUS] IOC read  off=0x${(aligned - IOC_BASE).toString(16).padStart(2, '0')} → 0x${v.toString(16)}`);
      }
      return v;
    }
    if (aligned >= IO_BASE && aligned <= IO_END) {
      // Other IO space: open bus
      return 0xFFFF_FFFF;
    }
    if (aligned >= PHYS_RAM_BASE && aligned < PHYS_RAM_BASE + this.ram.length) {
      return this.readRAM32(aligned - PHYS_RAM_BASE);
    }
    if (aligned <= LOGICAL_END) {
      return this.readLogical(aligned);
    }
    return 0xDEAD_BEEF; // open bus
  }

  // --------------------------------------------------------------------------
  // 32-bit write
  // --------------------------------------------------------------------------
  write32(addr: number, value: number): void {
    addr = (addr >>> 0) & 0x3FF_FFFF;
    const aligned = addr & ~3;

    // In State 2, any write ≥ 0x200000 transitions to State 0
    if (this.romMapState === 2 && aligned >= PHYS_RAM_BASE) {
      this.romMapState = 0;
    }

    // MEMC LOG2PHYS: write to 0x3800000–0x3BFFFFF programs the page table.
    // Only the write ADDRESS encodes the LPN/PPL/PPN — data is ignored.
    if (aligned >= ROM_HIGH_BASE && aligned <= ROM_HIGH_END) {
      if (++this._periWriteCount <= this._PERI_WRITE_LIMIT)
        console.debug(`[BUS] MEMC LOG2PHYS write addr=0x${aligned.toString(16)}`);
      this.memc.writeCam(aligned - ROM_HIGH_BASE);
      return;
    }
    if (aligned >= VIDC_BASE && aligned <= VIDC_END) {
      if (++this._periWriteCount <= this._PERI_WRITE_LIMIT)
        console.debug(`[BUS] VIDC write val=0x${value.toString(16).padStart(8, '0')}`);
      this.vidc.write(value >>> 0);
      return;
    }
    if (aligned >= DMA_BASE && aligned <= DMA_END) {
      const dmaOff = aligned - DMA_BASE;
      const region = dmaOff >>> 17;
      if (++this._periWriteCount <= this._PERI_WRITE_LIMIT)
        console.debug(`[BUS] DMA write addr=0x${aligned.toString(16)} region=${region} (memc.ctrl=${region===7}) val=0x${value.toString(16).padStart(8,'0')}`);
      // DMA range: sound/video buffer + MEMC control programming (address-encoded, data ignored)
      this.memc.writeDma(dmaOff);
      return;
    }
    if (aligned >= IOC_BASE && aligned <= IOC_END) {
      if (++this._periWriteCount <= this._PERI_WRITE_LIMIT)
        console.debug(`[BUS] IOC write off=0x${(aligned - IOC_BASE).toString(16).padStart(2, '0')} val=0x${value.toString(16).padStart(8, '0')}`);
      this.ioc.write(aligned - IOC_BASE, value >>> 0);
      return;
    }
    if (aligned >= PHYS_RAM_BASE && aligned < PHYS_RAM_BASE + this.ram.length) {
      this.writeRAM32(aligned - PHYS_RAM_BASE, value >>> 0);
      return;
    }
    if (aligned <= LOGICAL_END) {
      this.writeLogical(aligned, value >>> 0);
    }
    // ROM writes are ignored
  }

  // --------------------------------------------------------------------------
  // 8-bit read/write
  // --------------------------------------------------------------------------
  read8(addr: number): number {
    addr = (addr >>> 0) & 0x3FF_FFFF;
    const w = this.read32(addr & ~3);
    const shift = (addr & 3) * 8;
    return (w >>> shift) & 0xFF;
  }

  write8(addr: number, value: number): void {
    addr = (addr >>> 0) & 0x3FF_FFFF;
    const aligned = addr & ~3;
    const shift = (addr & 3) * 8;
    const old = this.read32(aligned);
    this.write32(aligned, (old & ~(0xFF << shift)) | ((value & 0xFF) << shift));
  }

  // --------------------------------------------------------------------------
  // Logical RAM (MEMC CAM-translated)
  // --------------------------------------------------------------------------
  private readLogical(logical: number): number {
    const phys = this.memc.translateAddress(logical);
    if (phys === null) {
      // Signal abort to caller via flag; the CPU decides whether this is a
      // prefetch abort (instruction fetch) or a data abort (LDR/LDM).
      this.readAborted = true;
      return 0;
    }
    return this.readRAM32(phys - PHYS_RAM_BASE);
  }

  private _writeAbortCount = 0;
  private readonly _WRITE_ABORT_LIMIT = 20;

  private writeLogical(logical: number, value: number): void {
    const phys = this.memc.translateAddress(logical);
    if (phys === null) {
      if (this._writeAbortCount < this._WRITE_ABORT_LIMIT) {
        this._writeAbortCount++;
        console.debug(`[BUS] write ABORT logical=0x${logical.toString(16)} val=0x${value.toString(16)} (LPN=${logical >>> ((12 + ((this.memc.control >>> 2) & 3)))}, maxCAM=${128 >>> ((this.memc.control >>> 2) & 3)})`);
      }
      this.onDataAbort?.();
      return;
    }
    this.writeRAM32(phys - PHYS_RAM_BASE, value);
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
