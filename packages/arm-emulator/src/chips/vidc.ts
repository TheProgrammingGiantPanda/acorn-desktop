/**
 * VIDC1 / VIDC20 - Video & Sound Controller
 *
 * The VIDC is a write-only chip.  Writes are 32-bit words where bits 31:28
 * select the register:
 *
 *   0x0  – Border colour
 *   0x1  – Cursor palette entry 1
 *   0x2  – Cursor palette entry 2
 *   0x3  – Cursor palette entry 3
 *   0x10–0x1F – Logical palette entries 0–15 (4-bpp mode)
 *   0x40 – Video horizontal cycle (Hcr)
 *   0x41 – Video horizontal sync width (Hswr)
 *   0x42 – Video horizontal border start (Hbsr)
 *   0x43 – Video horizontal display start (Hdsr)
 *   0x44 – Video horizontal display end (Hder)
 *   0x45 – Video horizontal border end (Hber)
 *   0x46 – Video horizontal cursor start (Hcsr)
 *   0x47 – Video horizontal interlace (Hicr)
 *   0x50–0x57 – Vertical equivalents
 *   0x60 – Control register (bits per pixel, etc.)
 *   0x70–0x77 – Sound frequency registers
 *
 * This implementation produces RGBA pixel data for the renderer.
 */

/** 12-bit Archimedes palette entry → RGBA */
function palToRGBA(entry: number): [number, number, number, number] {
  // Bits 11:8 = intensity, 7:4 = blue, 3:0 = green+red (simplified)
  // Real VIDC: bits 3:0 = red, 7:4 = green, 11:8 = blue (4 bits each)
  const r = ((entry)       & 0xF) * 17;
  const g = ((entry >>> 4) & 0xF) * 17;
  const b = ((entry >>> 8) & 0xF) * 17;
  return [r, g, b, 255];
}

export class VIDC {
  /** Logical palette: 16 entries of packed 12-bit colour */
  readonly palette = new Uint16Array(16);
  /** Cursor palette entries 1–3 */
  readonly cursorPalette = new Uint16Array(3);
  /** Border colour */
  borderColour = 0;

  // Timing registers (pixel counts)
  hcr  = 1279; // horizontal cycle
  hswr = 95;   // h-sync width
  hbsr = 110;  // h-border start
  hdsr = 136;  // h-display start
  hder = 1096; // h-display end
  hber = 1110; // h-border end

  vcr  = 624;  // vertical cycle
  vswr = 3;    // v-sync width
  vbsr = 18;   // v-border start
  vdsr = 35;   // v-display start
  vder = 515;  // v-display end
  vber = 560;  // v-border end

  /** Control register */
  control = 0;

  /** Bits per pixel: 1, 2, 4 or 8 */
  get bpp(): 1 | 2 | 4 | 8 {
    switch ((this.control >>> 2) & 0x3) {
      case 0: return 1;
      case 1: return 2;
      case 2: return 4;
      case 3: return 8;
    }
    return 8;
  }

  get displayWidth():  number { return Math.max(1, (this.hder - this.hdsr) * 2); }
  get displayHeight(): number { return Math.max(1, this.vder - this.vdsr); }

  /** Process one VIDC write word */
  write(value: number): void {
    const reg = (value >>> 26) & 0x3F;

    if (reg <= 0x0F) {
      // Palette entries 0–15
      this.palette[reg] = (value >>> 2) & 0xFFF;
    } else if (reg === 0x10) {
      this.borderColour = (value >>> 2) & 0xFFF;
    } else if (reg === 0x11) {
      this.cursorPalette[0] = (value >>> 2) & 0xFFF;
    } else if (reg === 0x12) {
      this.cursorPalette[1] = (value >>> 2) & 0xFFF;
    } else if (reg === 0x13) {
      this.cursorPalette[2] = (value >>> 2) & 0xFFF;
    } else if (reg >= 0x20 && reg <= 0x27) {
      // Horizontal timing
      const v = (value >>> 14) & 0x3FF;
      switch (reg - 0x20) {
        case 0: this.hcr  = v; break;
        case 1: this.hswr = v; break;
        case 2: this.hbsr = v; break;
        case 3: this.hdsr = v; break;
        case 4: this.hder = v; break;
        case 5: this.hber = v; break;
      }
    } else if (reg >= 0x28 && reg <= 0x2F) {
      // Vertical timing
      const v = (value >>> 14) & 0x3FF;
      switch (reg - 0x28) {
        case 0: this.vcr  = v; break;
        case 1: this.vswr = v; break;
        case 2: this.vbsr = v; break;
        case 3: this.vdsr = v; break;
        case 4: this.vder = v; break;
        case 5: this.vber = v; break;
      }
    } else if (reg === 0x30) {
      this.control = value & 0x3FFF;
    }
  }

  /**
   * Render one frame into an RGBA Uint8ClampedArray.
   * @param screenRAM  Raw bytes from physical RAM at the video DMA address
   */
  renderFrame(screenRAM: Uint8Array, output: Uint8ClampedArray): void {
    const w = this.displayWidth;
    const h = this.displayHeight;
    const bpp = this.bpp;
    const pixPerByte = 8 / bpp;
    const mask = (1 << bpp) - 1;

    let srcByte = 0;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const pixelIdx = y * w + x;
        const byteIdx  = Math.floor(pixelIdx / pixPerByte);
        const bitShift = (pixelIdx % pixPerByte) * bpp;
        const palIdx   = (srcByte < screenRAM.length)
          ? ((screenRAM[byteIdx] ?? 0) >>> bitShift) & mask
          : 0;

        const [r, g, b, a] = palToRGBA(this.palette[palIdx] ?? 0);
        const out = pixelIdx * 4;
        output[out]     = r;
        output[out + 1] = g;
        output[out + 2] = b;
        output[out + 3] = a;
      }
      srcByte += Math.ceil(w / pixPerByte);
    }
  }
}
