/**
 * MEMC (Memory Controller) - Acorn Archimedes
 *
 * The MEMC handles:
 *  - Logical-to-physical address translation (page tables via CAM)
 *  - DMA for VIDC (video and sound)
 *  - OS/application memory protection
 *  - ROM alias control
 *
 * Control register bits (written to address 0x36E0_0000+):
 *   bits 11:8  – DMA sound buffer (half-page select)
 *   bits 7:2   – Operating system mode / video DMA page size
 *   bit 1      – Sound DMA enable
 *   bit 0      – Video DMA enable
 *
 * CAM entries are programmed by ARM writes to the address range
 * 0x3600_0000–0x37FF_FFFF (bus-space equivalent of hardware 0x0360_0000–0x037F_FFFF).
 * Only the write address encodes the mapping; the data value is ignored.
 *
 * CAM write address layout (offset from CAM_BASE, by page size index S):
 *   bits [20:14]             – Logical Page Number (LPN), 7−S bits wide
 *   bits [13:12]             – Protection level (PPL), 2 bits
 *   bits [(pageShift−10):2]  – Physical Page Number (PPN), 10−S bits wide
 *
 * Page sizes and CAM capacity:
 *   S=0 → 4 KB, 128 entries   S=2 → 16 KB, 32 entries
 *   S=1 → 8 KB,  64 entries   S=3 → 32 KB, 16 entries
 */

/** Physical RAM base address (matches SystemBus PHYS_RAM_BASE) */
const PHYS_RAM_BASE = 0x0200_0000;

/** Maximum CAM entries (4 KB page mode) */
const MAX_CAM_ENTRIES = 128;

interface CamEntry {
  valid: boolean;
  ppn:   number;  // physical page number
  ppl:   number;  // protection level 0–3
}

export class MEMC {
  control = 0;

  /** Video DMA start address (physical) */
  videoDMAStart = 0x0200_0000;
  /** Video DMA end address (physical) */
  videoDMAEnd   = 0x0200_0000;

  /** Sound DMA start address (physical) */
  soundDMAStart = 0x0200_0000;

  /** CAM: indexed by logical page number */
  private cam: CamEntry[] = [];

  constructor() {
    this.initCam();
    this.resetIdentityMap();
  }

  private initCam(): void {
    this.cam = Array.from({ length: MAX_CAM_ENTRIES }, () => ({
      valid: false, ppn: 0, ppl: 0,
    }));
  }

  /** Page size index: 0=4KB, 1=8KB, 2=16KB, 3=32KB */
  get pageSizeIndex(): number {
    return (this.control >>> 2) & 0x3;
  }

  get pageSize(): number {
    return 4096 << this.pageSizeIndex;
  }

  /** Number of active CAM entries for the current page size */
  get maxCamEntries(): number {
    return MAX_CAM_ENTRIES >>> this.pageSizeIndex;
  }

  get videoDMAEnabled(): boolean {
    return (this.control & 0x1) !== 0;
  }

  get soundDMAEnabled(): boolean {
    return (this.control & 0x2) !== 0;
  }

  readControl(_offset: number): number {
    // MEMC is write-only in hardware; reads return open-bus
    return 0xFFFF_FFFF;
  }

  writeControl(offset: number, value: number): void {
    // Legacy path: data-value-based register writes (offset from MEMC_CTL_BASE).
    // On real hardware MEMC is address-encoded; this handles any remaining cases.
    switch (offset & 0xFF) {
      case 0x00: this.control        = value; break;
      case 0x04: this.videoDMAStart  = value & 0x03FF_FFFC; break;
      case 0x08: this.videoDMAEnd    = value & 0x03FF_FFFC; break;
      case 0x0C: this.soundDMAStart  = value & 0x03FF_FFFC; break;
    }
  }

  /**
   * Handle a write to the DMA control range (0x3600000–0x37FFFFF).
   * Only the write address encodes the DMA register — data is ignored.
   * The sub-ranges within the DMA space program video/sound buffer addresses.
   */
  writeDma(offset: number): void {
    // DMA address generation — address-encoded, data ignored (matches ArcEm DMA_PutVal).
    // Region number = bits[19:17] of offset (each region is 128 KB).
    // RegVal       = bits[16:2] of offset (used to set the address register).
    //
    // Region map (from Acorn MEMC datasheet / ArcEm):
    //   0: Vinit   (video init pointer)
    //   1: Vstart  (video DMA start)
    //   2: Vend    (video DMA end)
    //   3: Cinit   (cursor init — not used in emulation)
    //   4: Sstart  (sound DMA start)
    //   5: SendN   (sound DMA next end — not used)
    //   6: Sptr    (sound pointer — not used)
    //   7: MEMC control register (page size, OS mode, etc.)
    const region = (offset >>> 17) & 7;
    const regVal  = (offset >>> 2) & 0x7FFF; // 15-bit value
    switch (region) {
      case 1: this.videoDMAStart = regVal << 2; break;
      case 2: this.videoDMAEnd   = regVal << 2; break;
      case 4: this.soundDMAStart = regVal << 2; break;
      case 7: // MEMC control register (bits[3:2] = page size index)
        this.control = offset & 0x1FFF;
        break;
    }
  }

  /**
   * Decode a CAM entry from a write-address offset (relative to ROM_HIGH_BASE = 0x3800000).
   * The data value is ignored per hardware spec — only the address matters.
   *
   * Address layout (4 KB pages, S=0):
   *   offset[20:14] = LPN[6:0]
   *   offset[13:12] = PPL[1:0]
   *   offset[11:2]  = PPN[9:0]
   */
  writeCam(offset: number): void {
    const s         = this.pageSizeIndex;
    const pageShift = 12 + s;
    const lpnBits   = 7 - s;   // 7, 6, 5, or 4
    const ppnBits   = 10 - s;  // 10, 9, 8, or 7
    const ppnShift  = pageShift - 10;  // 2, 3, 4, or 5

    const lpn = (offset >>> 14) & ((1 << lpnBits) - 1);
    const ppl = (offset >>> 12) & 0x3;
    const ppn = (offset >>> ppnShift) & ((1 << ppnBits) - 1);

    if (lpn < this.cam.length) {
      this.cam[lpn] = { valid: true, ppn, ppl };
      console.debug(`[MEMC] CAM write S=${s} LPN=${lpn} PPL=${ppl} PPN=${ppn} log=0x${(lpn << pageShift).toString(16)} phys=0x${((0x2000000 + ppn * (1 << pageShift)) >>> 0).toString(16)}`);
    }
  }

  /**
   * Translate a logical address to a physical bus address using the CAM.
   * Returns null if no valid mapping exists (triggers an address abort).
   */
  translateAddress(logical: number): number | null {
    const s         = this.pageSizeIndex;
    const pageShift = 12 + s;
    const pageMask  = (1 << pageShift) - 1;
    const lpn       = logical >>> pageShift;

    if (lpn >= this.maxCamEntries) {
      // Above the MEMC logical window — abort (no CAM entry possible).
      return null;
    }

    const entry = this.cam[lpn];
    if (!entry?.valid) return null;

    return PHYS_RAM_BASE + (entry.ppn << pageShift) + (logical & pageMask);
  }

  /**
   * Ensure every logical page in [logicalBase, logicalBase+size) has a valid
   * CAM entry.  Any currently-unmapped logical page is assigned the next
   * available physical page number above all currently-used PPNs.
   *
   * Call from startApp() after the ROM boot to guarantee the application slot
   * is accessible.  If the ROM already mapped all required pages this is a
   * no-op.
   */
  forceMapRange(logicalBase: number, size: number, maxPPN: number): void {
    const s         = this.pageSizeIndex;
    const pageShift = 12 + s;
    const pageSize  = 1 << pageShift;

    // Find the highest PPN currently in any CAM entry.
    let nextPPN = 0;
    for (const entry of this.cam) {
      if (entry.valid && entry.ppn >= nextPPN) nextPPN = entry.ppn + 1;
    }

    const firstLPN = logicalBase >>> pageShift;
    const numPages = Math.ceil(size / pageSize);

    for (let i = 0; i < numPages; i++) {
      const lpn = firstLPN + i;
      if (lpn >= this.maxCamEntries) break;
      const entry = this.cam[lpn];
      if (!entry?.valid) {
        if (nextPPN < maxPPN) {
          this.cam[lpn] = { valid: true, ppn: nextPPN++, ppl: 0 };
        }
      }
    }
  }

  reset(): void {
    this.control       = 0;
    this.videoDMAStart = 0x0200_0000;
    this.videoDMAEnd   = 0x0200_0000;
    this.soundDMAStart = 0x0200_0000;
    this.initCam();
    this.resetIdentityMap();
  }

  /**
   * Populate the CAM with an identity mapping (logical page N → physical page N)
   * for all available slots.  This preserves flat-memory behaviour before a real
   * ROM reprograms the page tables.
   */
  private resetIdentityMap(): void {
    const count = this.maxCamEntries;
    for (let lpn = 0; lpn < count; lpn++) {
      this.cam[lpn] = { valid: true, ppn: lpn, ppl: 0 };
    }
  }
}
