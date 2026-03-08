/**
 * OS_SpriteOp and Wimp_SpriteOp handler
 *
 * R0 encodes the reason code plus an area selector:
 *   R0 & 0xFF   = reason code
 *   R0 & 0x100  = 0 → system sprite area; 1 → user sprite area (R1 = area ptr)
 *   R0 & 0x200  = 0 → R2 is sprite name ptr; 1 → R2 is direct sprite pointer
 *
 * Wimp_SpriteOp automatically adds 0x100 before forwarding to OS_SpriteOp, so
 * when intercepted directly the caller's R0 holds just the reason code (no area
 * bits); we treat R2 as a sprite name pointer in all cases where the 0x200 bit
 * is clear.
 *
 * Reason codes implemented:
 *   2   Save sprite area to file  (R2=filename — stub; pool is decode-only)
 *   10  Load sprite file          (R2=filename → replaces pool contents from file)
 *   11  Merge sprite file         (R2=filename → adds/replaces sprites from file)
 *   13  Return name of nth sprite (R2=buf, R3=buflen, R4=index → R3=len)
 *   24  Select sprite by name    (R2=name → R2=sprite handle if user area; C clear if found)
 *   28  Put sprite at current coords (stub — no canvas pipeline yet)
 *   34  Put sprite at x,y OS units  (stub)
 *   36  Put sprite scaled            (stub)
 *   37  Put sprite, grey table       (stub)
 *   40  Read sprite info (R2=name → R3=width, R4=height, R5=hasMask, R6=mode)
 */

import type { SpritePool } from './sprite-pool.js';
import type { FileSystemHost } from '../fs/fs-host.js';

interface Regs {
  read(n: number): number;
  write(n: number, v: number): void;
  C: boolean;
}

interface Bus {
  read8(addr: number): number;
  write8(addr: number, val: number): void;
}

export class OSSpriteHandler {
  constructor(
    private readonly pool: SpritePool,
    private readonly fs?: FileSystemHost,
  ) {}

  /** Handle OS_SpriteOp (any reason code). */
  handleOS(regs: Regs, bus: Bus): void {
    this.dispatch(regs, bus, regs.read(0));
  }

  /**
   * Handle Wimp_SpriteOp.
   * The Wimp adds 0x100 to R0 before forwarding to OS_SpriteOp, so the caller
   * sets R0 = reason code only.  We reconstruct the full R0 value here.
   */
  handleWimp(regs: Regs, bus: Bus): void {
    this.dispatch(regs, bus, regs.read(0) | 0x100);
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private dispatch(regs: Regs, bus: Bus, r0: number): void {
    const reason    = r0 & 0xFF;
    // When bit 9 is set, R2 is a direct sprite pointer rather than a name.
    // We cannot dereference real ARM sprite pointers, so fall through to stub.
    const nameInR2  = (r0 & 0x200) === 0;

    switch (reason) {
      case  2: /* save — pool is decode-only, cannot re-encode */ break;
      case 10: this.loadFile(regs, bus, /* merge */ false); break;
      case 11: this.loadFile(regs, bus, /* merge */ true);  break;
      case 13: this.nameByNumber(regs, bus); break;
      case 24: this.selectSprite(regs, bus, nameInR2); break;
      case 28:
      case 34:
      case 36:
      case 37: /* put sprite — stub; return with registers preserved */ break;
      case 40: this.readInfo(regs, bus, nameInR2); break;
      // All other reason codes: silently ignore
    }
  }

  /**
   * Reasons 10 (load) and 11 (merge): load a sprite file into the pool.
   * R2 = RISC OS path to sprite file.
   * For reason 10 the real OS clears the area first; since our pool is
   * name-keyed, both operations effectively merge (same-name sprites replaced).
   */
  private loadFile(regs: Regs, bus: Bus, _merge: boolean): void {
    if (!this.fs) return;
    const path = readCString(bus, regs.read(2));
    let data: Uint8Array;
    try {
      data = this.fs.readFile(path);
    } catch {
      regs.C = true;
      return;
    }
    this.pool.loadArea(data);
    regs.C = false;
  }

  /** Reason 13: return name of nth sprite (R2=buf, R3=buflen, R4=sprite index → R3=len). */
  private nameByNumber(regs: Regs, bus: Bus): void {
    const bufAddr = regs.read(2);
    const bufLen  = regs.read(3);
    const index   = regs.read(4);

    const names = this.pool.names();
    const entry = names[index];
    if (entry === undefined) {
      regs.C = true;
      return;
    }

    const sprite = this.pool.get(entry);
    const name   = sprite?.name ?? entry;
    const bytes  = new TextEncoder().encode(name + '\0');
    const n      = Math.min(bytes.length, bufLen);
    for (let i = 0; i < n; i++) bus.write8(bufAddr + i, bytes[i]!);
    regs.write(3, name.length);
    regs.C = false;
  }

  /**
   * Reason 24: select sprite by name.
   * System area: selects sprite for subsequent OS_Plot operations (conceptually).
   * User area: returns R2 = pointer to sprite in area.
   * We use a fake handle (1-based index into pool) as the "pointer".
   */
  private selectSprite(regs: Regs, bus: Bus, nameInR2: boolean): void {
    if (!nameInR2) { regs.C = false; return; } // sprite-pointer mode — assume valid
    const name   = readCString(bus, regs.read(2));
    const sprite = this.pool.get(name);
    if (!sprite) { regs.C = true; return; }
    // Return a non-zero fake handle in R2 for user-area callers
    const handle = this.pool.names().indexOf(name.toLowerCase()) + 1;
    regs.write(2, handle > 0 ? handle : 1);
    regs.C = false;
  }

  /**
   * Reason 40: read sprite info.
   * Exit: R3=width px, R4=height px, R5=hasMask (0|1), R6=mode.
   */
  private readInfo(regs: Regs, bus: Bus, nameInR2: boolean): void {
    if (!nameInR2) { regs.C = true; return; } // sprite-pointer mode not supported
    const name   = readCString(bus, regs.read(2));
    const sprite = this.pool.get(name);
    if (!sprite) { regs.C = true; return; }
    regs.write(3, sprite.width);
    regs.write(4, sprite.height);
    regs.write(5, sprite.hasMask ? 1 : 0);
    regs.write(6, sprite.mode);
    regs.C = false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readCString(bus: Bus, addr: number): string {
  let s = '';
  for (let i = 0; i < 256; i++) {
    const c = bus.read8(addr + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}
