/**
 * MEMC (Memory Controller) - Acorn Archimedes
 *
 * The MEMC handles:
 *  - Logical-to-physical address translation (page tables)
 *  - DMA for VIDC (video and sound)
 *  - OS/application memory protection
 *  - ROM alias control (bit 0 of CAM / control register)
 *
 * Control register bits (written to address 0x36E0_0000+):
 *   bits 11:8  – DMA sound buffer (half-page select)
 *   bits 7:2   – Operating system mode / video DMA page size
 *   bit 1      – Sound DMA enable
 *   bit 0      – Video DMA enable
 *
 * CAM (Content Addressable Memory) entries are written by ARM page-table
 * accesses.  We simplify to a flat mapping here.
 */

export class MEMC {
  control = 0;

  /** Video DMA start address (physical) */
  videoDMAStart = 0x0200_0000;
  /** Video DMA end address (physical) */
  videoDMAEnd   = 0x0200_0000;

  /** Sound DMA start address (physical) */
  soundDMAStart = 0x0200_0000;

  /** Page size index: 0=4KB, 1=8KB, 2=16KB, 3=32KB */
  get pageSize(): number {
    return 4096 << ((this.control >>> 2) & 0x3);
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
    switch (offset & 0xFF) {
      case 0x00:
        this.control = value;
        break;
      case 0x04:
        this.videoDMAStart = value & 0x01FF_FFFC;
        break;
      case 0x08:
        this.videoDMAEnd = value & 0x01FF_FFFC;
        break;
      case 0x0C:
        this.soundDMAStart = value & 0x01FF_FFFC;
        break;
    }
  }

  reset(): void {
    this.control       = 0;
    this.videoDMAStart = 0x0200_0000;
    this.videoDMAEnd   = 0x0200_0000;
    this.soundDMAStart = 0x0200_0000;
  }
}
