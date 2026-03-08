/**
 * OS_SpriteOp and Wimp_SpriteOp handler
 *
 * R0 encodes the reason code plus an area selector:
 *   R0 & 0xFF   = reason code
 *   R0 & 0x100  = 0 → OS system sprite area
 *                 1 → user sprite area (R1 = ARM memory pointer to area)
 *   R0 & 0x200  = 0 → R2 is sprite name ptr; 1 → R2 is direct sprite pointer
 *
 * Wimp_SpriteOp always targets the Wimp sprite area (distinct from the OS
 * system area).  The caller's R0 contains only the reason code (no area bits);
 * we route directly to registry.wimp.
 *
 * User sprite areas live in ARM memory at R1.  The first word (R1+0) is the
 * allocated area size.  On load (reasons 10/11) the file data is written into
 * that memory.  On every subsequent operation the area bytes are hashed and
 * re-parsed if they have changed since the last call.
 *
 * Reason codes implemented:
 *   2   Save sprite area to file  (stub — pool is decode-only)
 *   10  Load sprite file          (R2=filename → write to area / replace pool)
 *   11  Merge sprite file         (R2=filename → same as 10; pool is name-keyed)
 *   13  Return name of nth sprite (R2=buf, R3=buflen, R4=index → R3=len)
 *   24  Select sprite by name     (R2=name → R2=fake handle; C clear if found)
 *   28  Put sprite at current coords  (console log — see issue #20)
 *   34  Put sprite at x,y OS units   (console log — see issue #20)
 *   36  Put sprite scaled             (console log — see issue #20)
 *   37  Put sprite, grey table        (console log — see issue #20)
 *   40  Read sprite info  (R2=name → R3=width, R4=height, R5=hasMask, R6=mode)
 */

import type { SpritePool, SpriteAreaRegistry } from './sprite-pool.js';
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
    private readonly registry: SpriteAreaRegistry,
    private readonly fs?: FileSystemHost,
  ) {}

  /** Handle OS_SpriteOp — selects pool based on R0 area bits and R1. */
  handleOS(regs: Regs, bus: Bus): void {
    const r0   = regs.read(0);
    const pool = this.registry.forOS(r0, regs.read(1), bus);
    this.dispatchWithPool(pool, r0, regs, bus);
  }

  /**
   * Handle Wimp_SpriteOp — always targets the Wimp sprite area.
   * The caller sets R0 = reason code only (the Wimp would add 0x100 before
   * forwarding to OS_SpriteOp, but we intercept here directly).
   */
  handleWimp(regs: Regs, bus: Bus): void {
    // Wimp sprite area is separate from the OS system area
    this.dispatchWithPool(this.registry.wimp, regs.read(0), regs, bus);
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private dispatchWithPool(pool: SpritePool, r0: number, regs: Regs, bus: Bus): void {
    const reason   = r0 & 0xFF;
    // When bit 9 is set, R2 is a direct sprite pointer rather than a name.
    // We cannot dereference real ARM sprite pointers, so stub these.
    const nameInR2 = (r0 & 0x200) === 0;

    switch (reason) {
      case  2: /* save — pool is decode-only, cannot re-encode */ break;
      case 10:
      case 11: this.loadFile(pool, r0, regs, bus); break;
      case 13: this.nameByNumber(pool, regs, bus); break;
      case 24: this.selectSprite(pool, regs, bus, nameInR2); break;
      case 28:
      case 34:
      case 36:
      case 37:
        // Sprite rendering not yet implemented — see GitHub issue #20
        console.log(`[SpriteOp] put-sprite reason ${reason} ignored (rendering not implemented)`);
        break;
      case 40: this.readInfo(pool, regs, bus, nameInR2); break;
      // All other reason codes: silently ignore
    }
  }

  /**
   * Reasons 10/11: load or merge a sprite file.
   *
   * System/Wimp area: parse file data directly into the pool.
   * User area (R0 & 0x100): write file bytes into ARM memory at R1+4
   * (after the preserved area-size word); fail with C=1 if the area is too
   * small to hold the file.  The registry cache is invalidated automatically.
   */
  private loadFile(pool: SpritePool, r0: number, regs: Regs, bus: Bus): void {
    if (!this.fs) return;
    const path = readCString(bus, regs.read(2));
    let fileData: Uint8Array;
    try {
      fileData = this.fs.readFile(path);
    } catch {
      regs.C = true;
      return;
    }

    if (r0 & 0x100) {
      // User area: write into ARM memory; registry invalidates its cache
      if (!this.registry.loadFileIntoUser(regs.read(1), fileData, bus)) {
        regs.C = true;  // area too small
        return;
      }
    } else {
      // System or Wimp area: load directly into the in-memory pool
      pool.loadArea(fileData);
    }

    regs.C = false;
  }

  /** Reason 13: return name of nth sprite (R2=buf, R3=buflen, R4=index → R3=len). */
  private nameByNumber(pool: SpritePool, regs: Regs, bus: Bus): void {
    const bufAddr = regs.read(2);
    const bufLen  = regs.read(3);
    const index   = regs.read(4);

    const names = pool.names();
    const entry = names[index];
    if (entry === undefined) { regs.C = true; return; }

    const sprite = pool.get(entry);
    const name   = sprite?.name ?? entry;
    const bytes  = new TextEncoder().encode(name + '\0');
    const n      = Math.min(bytes.length, bufLen);
    for (let i = 0; i < n; i++) bus.write8(bufAddr + i, bytes[i]!);
    regs.write(3, name.length);
    regs.C = false;
  }

  /**
   * Reason 24: select sprite by name.
   * User area: returns R2 = fake handle (1-based pool index).
   * System area: conceptually "selects" for OS_Plot — acknowledged only.
   */
  private selectSprite(pool: SpritePool, regs: Regs, bus: Bus, nameInR2: boolean): void {
    if (!nameInR2) { regs.C = false; return; }
    const name   = readCString(bus, regs.read(2));
    const sprite = pool.get(name);
    if (!sprite) { regs.C = true; return; }
    const handle = pool.names().indexOf(name.toLowerCase()) + 1;
    regs.write(2, handle > 0 ? handle : 1);
    regs.C = false;
  }

  /**
   * Reason 40: read sprite info.
   * Exit: R3=width px, R4=height px, R5=hasMask (0|1), R6=mode.
   */
  private readInfo(pool: SpritePool, regs: Regs, bus: Bus, nameInR2: boolean): void {
    if (!nameInR2) { regs.C = true; return; }
    const name   = readCString(bus, regs.read(2));
    const sprite = pool.get(name);
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
