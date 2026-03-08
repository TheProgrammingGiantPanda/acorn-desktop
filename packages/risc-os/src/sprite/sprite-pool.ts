/**
 * SpritePool — parses RISC OS sprite area files and stores decoded sprites.
 *
 * Sprite area file format (RISC OS PRM, Chapter 23):
 *   Files omit the first "area size" word present in memory, so all stored
 *   offsets are 4 bytes larger than file-relative positions.
 *
 * Area header in file (3 words = 12 bytes):
 *   +0  Number of sprites
 *   +4  Byte offset to first sprite from memory base  (subtract 4 for file offset)
 *   +8  Byte offset to first free word from memory base
 *
 * Per-sprite header (44 bytes):
 *   +0   Offset to next sprite (bytes from start of this sprite)
 *   +4   Name (12 bytes, null-padded)
 *   +16  Width in words, minus 1
 *   +20  Height in scan lines, minus 1
 *   +24  First bit used on left (lbit)
 *   +28  Last bit used on right (rbit)
 *   +32  Byte offset to image data from start of sprite
 *   +36  Byte offset to mask data from start of sprite (= image offset if no mask)
 *   +40  Screen mode number
 *   +44  Palette data (optional; present when image offset > 44)
 *
 * Palette: each entry is 8 bytes (two flash-colour words).
 * Colour word: bits 8-15 = red, 16-23 = green, 24-31 = blue.
 *
 * Pixel data: packed LSB-first within each word, lbit leading bits are waste.
 * Mask: 1 bit per pixel, same row width (in words) as image; 1 = opaque.
 */

export interface SpriteData {
  name:    string;
  width:   number;              // pixels
  height:  number;              // pixels
  mode:    number;              // RISC OS screen mode number
  hasMask: boolean;
  rgba:    Uint8ClampedArray;   // width × height × 4 (RGBA)
}

export class SpritePool {
  private readonly sprites = new Map<string, SpriteData>();

  /**
   * Parse a RISC OS sprite area from a file.
   * File format omits the area-size word, so stored offsets are 4 bytes larger
   * than file-relative positions.
   * Sprites with duplicate names replace earlier ones.
   */
  loadArea(data: Uint8Array): void {
    if (data.length < 12) return;
    const view           = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const numSprites     = view.getUint32(0, true);
    const firstSpriteOff = view.getUint32(4, true) - 4;  // convert to file-relative
    this._parse(view, data, numSprites, firstSpriteOff);
  }

  /**
   * Parse a RISC OS sprite area from ARM memory.
   * Memory format includes the area-size word at +0, so the layout is:
   *   +0  area size  +4  num sprites  +8  first sprite offset  +12  free offset
   * Offsets are area-relative (no adjustment needed).
   */
  loadAreaFromMemory(data: Uint8Array): void {
    if (data.length < 16) return;
    const view           = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const numSprites     = view.getUint32(4, true);
    const firstSpriteOff = view.getUint32(8, true);  // area-relative, no adjustment
    this._parse(view, data, numSprites, firstSpriteOff);
  }

  private _parse(view: DataView, data: Uint8Array, numSprites: number, firstOff: number): void {
    let off = firstOff;
    for (let i = 0; i < numSprites; i++) {
      if (off + 44 > data.length) break;

      const nextOff    = view.getUint32(off,      true);  // bytes from this sprite's start
      const name       = parseName(data, off + 4);
      const widthWords = view.getUint32(off + 16, true) + 1; // words per row
      const height     = view.getUint32(off + 20, true) + 1; // scan lines
      const lbit       = view.getUint32(off + 24, true);
      const rbit       = view.getUint32(off + 28, true);
      const imgOff     = view.getUint32(off + 32, true);  // from this sprite's start
      const maskOff    = view.getUint32(off + 36, true);  // from this sprite's start
      const mode       = view.getUint32(off + 40, true);

      const bpp    = modeToBpp(mode);
      const width  = Math.round(((widthWords * 32) - lbit - (31 - rbit)) / bpp);

      const paletteBytes = imgOff > 44 ? imgOff - 44 : 0;
      const palette      = readPalette(data, off + 44, paletteBytes / 8, mode);

      const imageStart = off + imgOff;
      const hasMask    = maskOff !== imgOff;
      const maskStart  = hasMask ? off + maskOff : -1;

      const rgba = decodePixels(
        data, imageStart, maskStart, width, height, widthWords, lbit, bpp, palette,
      );

      if (name) this.sprites.set(name.toLowerCase(), { name, width, height, mode, hasMask, rgba });

      off += nextOff;
    }
  }

  /** Remove all sprites from the pool (used by OS_SpriteOp 10 load-replace). */
  clear(): void {
    this.sprites.clear();
  }

  get(name: string): SpriteData | undefined {
    return this.sprites.get(name.toLowerCase());
  }

  has(name: string): boolean {
    return this.sprites.has(name.toLowerCase());
  }

  names(): string[] {
    return [...this.sprites.keys()];
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseName(data: Uint8Array, offset: number): string {
  let name = '';
  for (let i = 0; i < 12; i++) {
    const c = data[offset + i];
    if (c === undefined || c === 0) break;
    name += String.fromCharCode(c);
  }
  return name;
}

/** Map RISC OS screen mode number to bits-per-pixel. */
function modeToBpp(mode: number): number {
  const table: Record<number, number> = {
    0: 1, 1: 2,  2: 4,  3: 4,
    4: 1, 5: 2,  6: 4,  7: 4,
    8: 2, 9: 4, 10: 8, 11: 4,
    12: 4, 13: 8, 14: 4, 15: 8,
    16: 4, 17: 8, 18: 1, 19: 2,
    20: 4, 21: 8, 22: 4, 23: 1,
    24: 8, 25: 1, 26: 2, 27: 4,
    28: 8,
  };
  return table[mode] ?? 4;
}

/**
 * Read palette entries from the sprite data.
 * Each entry is 8 bytes: two flash-colour words (we use the first).
 * Colour word: bits 8-15 R, 16-23 G, 24-31 B.
 * Returns an array of packed RGBA values (R in low byte).
 */
function readPalette(
  data: Uint8Array, offset: number, numColors: number, mode: number,
): number[] {
  if (numColors > 0) {
    const palette: number[] = [];
    for (let i = 0; i < numColors; i++) {
      const base = offset + i * 8;
      if (base + 4 > data.length) break;
      const r = data[base + 1]!;
      const g = data[base + 2]!;
      const b = data[base + 3]!;
      palette.push(packRgba(r, g, b, 0xFF));
    }
    return palette;
  }
  return defaultPalette(mode);
}

// Standard RISC OS 16-colour desktop palette (modes 2, 9, 12, 20, …)
const RISCOS_16: readonly [number, number, number][] = [
  [0xFF, 0xFF, 0xFF], // 0  White
  [0xDD, 0xDD, 0xDD], // 1  Light grey
  [0xBB, 0xBB, 0xBB], // 2  Mid grey
  [0x99, 0x99, 0x99], // 3  Dark grey
  [0x77, 0x77, 0x77], // 4  Very dark grey
  [0x55, 0x55, 0x55], // 5  Darker grey
  [0x33, 0x33, 0x33], // 6  Near black
  [0x00, 0x00, 0x00], // 7  Black
  [0x00, 0x44, 0x99], // 8  Dark blue
  [0xFF, 0xFF, 0x00], // 9  Yellow
  [0x00, 0xCC, 0x00], // 10 Green
  [0xDD, 0x00, 0x00], // 11 Red
  [0xEE, 0xEE, 0xBB], // 12 Cream
  [0x00, 0x66, 0x00], // 13 Dark green
  [0xFF, 0x77, 0x00], // 14 Orange
  [0x99, 0xDD, 0xFF], // 15 Light blue
];

// Standard 4-colour palette (modes 1, 5, 8)
const RISCOS_4: readonly [number, number, number][] = [
  [0xFF, 0xFF, 0xFF],
  [0xBB, 0xBB, 0xBB],
  [0x77, 0x77, 0x77],
  [0x00, 0x00, 0x00],
];

// Standard 2-colour palette (modes 0, 4, 18, 23, 25)
const RISCOS_2: readonly [number, number, number][] = [
  [0xFF, 0xFF, 0xFF],
  [0x00, 0x00, 0x00],
];

function defaultPalette(mode: number): number[] {
  const bpp = modeToBpp(mode);
  if (bpp === 1) return RISCOS_2.map(([r, g, b]) => packRgba(r, g, b, 0xFF));
  if (bpp === 2) return RISCOS_4.map(([r, g, b]) => packRgba(r, g, b, 0xFF));
  if (bpp <= 4)  return RISCOS_16.map(([r, g, b]) => packRgba(r, g, b, 0xFF));
  return generate256Palette();
}

/** Generate the RISC OS standard 256-colour palette (simplified 3-3-2 RGB). */
function generate256Palette(): number[] {
  const p: number[] = [];
  for (let i = 0; i < 256; i++) {
    const r = Math.round(((i >> 5) & 0x07) * 255 / 7);
    const g = Math.round(((i >> 2) & 0x07) * 255 / 7);
    const b = Math.round( (i       & 0x03) * 255 / 3);
    p.push(packRgba(r, g, b, 0xFF));
  }
  return p;
}

function packRgba(r: number, g: number, b: number, a: number): number {
  // Store as little-endian word: R in byte 0, G in byte 1, B in byte 2, A in byte 3
  return (a << 24) | (b << 16) | (g << 8) | r;
}

/**
 * Decode packed RISC OS pixel data into an RGBA Uint8ClampedArray.
 * Pixels are packed LSB-first; `lbit` leading bits in each row are discarded.
 */
function decodePixels(
  data:       Uint8Array,
  imageStart: number,
  maskStart:  number,   // -1 if no mask
  width:      number,
  height:     number,
  widthWords: number,   // words per row (for both image and mask)
  lbit:       number,
  bpp:        number,
  palette:    number[],
): Uint8ClampedArray {
  const rgba     = new Uint8ClampedArray(width * height * 4);
  const rowBytes = widthWords * 4;
  const pixMask  = (1 << bpp) - 1;

  for (let y = 0; y < height; y++) {
    const rowBase = imageStart + y * rowBytes;

    for (let x = 0; x < width; x++) {
      const bitPos    = lbit + x * bpp;
      const byteIndex = bitPos >> 3;
      const bitOffset = bitPos & 7;

      // Read two bytes to handle bpp values that straddle a byte boundary
      const lo    = data[rowBase + byteIndex]     ?? 0;
      const hi    = data[rowBase + byteIndex + 1] ?? 0;
      const pixel = ((lo | (hi << 8)) >>> bitOffset) & pixMask;

      const color = palette[pixel] ?? 0xFF000000;
      const dst   = (y * width + x) * 4;
      rgba[dst]     =  color        & 0xFF;  // R
      rgba[dst + 1] = (color >>  8) & 0xFF;  // G
      rgba[dst + 2] = (color >> 16) & 0xFF;  // B
      rgba[dst + 3] = 0xFF;                  // A (overridden by mask below)
    }

    // Apply mask: 1 bit per pixel, same word-aligned rows as image; 1 = opaque
    if (maskStart >= 0) {
      const maskRowBase = maskStart + y * rowBytes;
      for (let x = 0; x < width; x++) {
        const bitPos    = lbit + x;
        const byteIndex = bitPos >> 3;
        const bitOffset = bitPos & 7;
        const opaque    = (data[maskRowBase + byteIndex] ?? 0) >>> bitOffset & 1;
        rgba[(y * width + x) * 4 + 3] = opaque ? 0xFF : 0x00;
      }
    }
  }

  return rgba;
}

// ── SpriteAreaRegistry ────────────────────────────────────────────────────────

/** Minimal bus interface needed for reading/writing ARM memory. */
export interface SpriteBus {
  read8(addr: number): number;
  write8(addr: number, val: number): void;
}

interface UserEntry {
  hash: number;
  pool: SpritePool;
}

/**
 * Manages separate sprite pools for each RISC OS sprite area.
 *
 *   system — OS system sprite area; used by OS_SpriteOp without area flag.
 *            IconSprites does NOT use this — it targets the Wimp area.
 *   wimp   — Wimp's own sprite area; target of Wimp_SpriteOp and IconSprites.
 *            Separate from the OS system area.
 *   user   — Per-application areas in ARM memory, identified by R1 (the
 *            address of the allocated sprite area block).  The first word of
 *            that block is the area size; subsequent words are the standard
 *            in-memory sprite area header (num_sprites, first_off, free_off).
 *
 * OS_SpriteOp R0 area bits:
 *   R0 & 0x100 = 0 → system area
 *   R0 & 0x100 = 1 → user area (R1 = ARM memory pointer)
 */
export class SpriteAreaRegistry {
  /**
   * The system sprite area.
   * Per the RISC OS PRM, Wimp_SpriteOp sets R1 to the system sprite area
   * pointer before forwarding to OS_SpriteOp, so the Wimp area and the OS
   * system area are the same pool.  IconSprites, Wimp_SpriteOp, and
   * OS_SpriteOp (without area flag) all read/write here.
   */
  readonly system = new SpritePool();

  /** Alias for system — Wimp_SpriteOp targets the same pool. */
  get wimp(): SpritePool { return this.system; }

  private readonly userCache = new Map<number, UserEntry>();

  /**
   * Get the decoded pool for a user sprite area at the given ARM memory pointer.
   *
   * Reads the area size from ptr+0, snapshots the full area, computes a hash,
   * and re-parses only when the content has changed since last call.
   */
  getUserPool(ptr: number, bus: SpriteBus): SpritePool {
    const size = readWord(bus, ptr);
    if (size < 16) return new SpritePool();  // area not yet initialised

    // Cap at 4 MB to guard against uninitialised memory with a huge size word
    const safeSize = Math.min(size, 4 * 1024 * 1024);
    const data     = readBytesFromBus(bus, ptr, safeSize);
    const hash     = hashBytes(data);

    const cached = this.userCache.get(ptr);
    if (cached && cached.hash === hash) return cached.pool;

    const pool = new SpritePool();
    pool.loadAreaFromMemory(data);
    this.userCache.set(ptr, { hash, pool });
    return pool;
  }

  /**
   * Load a sprite file into a user area in ARM memory.
   *
   * The area's size word (ptr+0) must be large enough to hold 4 header bytes
   * plus the file data.  File data is written starting at ptr+4 (after the
   * preserved size word).  The user-area cache is invalidated so the next
   * call to getUserPool re-parses from the updated memory.
   *
   * Returns true on success, false if the area is too small.
   */
  loadFileIntoUser(ptr: number, fileData: Uint8Array, bus: SpriteBus): boolean {
    const areaSize = readWord(bus, ptr);
    if (fileData.length + 4 > areaSize) return false;

    for (let i = 0; i < fileData.length; i++) bus.write8(ptr + 4 + i, fileData[i]!);
    this.userCache.delete(ptr);  // force re-parse on next access
    return true;
  }

  /**
   * Select the pool for an OS_SpriteOp call from R0 and R1.
   * R0 bit 8 set → user area at R1 in ARM memory; clear → system area.
   */
  forOS(r0: number, r1: number, bus: SpriteBus): SpritePool {
    return (r0 & 0x100) ? this.getUserPool(r1, bus) : this.system;
  }
}

// ── ARM memory helpers ────────────────────────────────────────────────────────

function readWord(bus: SpriteBus, addr: number): number {
  return (  bus.read8(addr)
          | bus.read8(addr + 1) << 8
          | bus.read8(addr + 2) << 16
          | bus.read8(addr + 3) << 24) >>> 0;
}

function readBytesFromBus(bus: SpriteBus, addr: number, size: number): Uint8Array {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = bus.read8(addr + i);
  return data;
}

/** Simple polynomial hash — fast enough to detect area mutations between calls. */
function hashBytes(data: Uint8Array): number {
  let h = 0;
  for (const b of data) h = (Math.imul(h, 31) + b) | 0;
  return h;
}
