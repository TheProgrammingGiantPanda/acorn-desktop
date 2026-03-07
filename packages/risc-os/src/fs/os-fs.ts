/**
 * RISC OS file-system SWI handlers.
 *
 * Implements:
 *   OS_File     (0x08)  – catalogue / load / save
 *   OS_Args     (0x09)  – sequential file pointer / extent
 *   OS_BGet     (0x0A)  – read one byte
 *   OS_BPut     (0x0B)  – write one byte
 *   OS_GBPB     (0x0C)  – block get/put and directory listing
 *   OS_Find     (0x0D)  – open / close file
 *   OS_FSControl(0x19)  – filing-system control (CSD, canonicalise…)
 */

import type { RegisterFile } from "@theprogramminggiantpanda/arm-emulator";
import type { SystemBus }    from "@theprogramminggiantpanda/arm-emulator";
import type { FileSystemHost } from "./fs-host.js";

// Scratch area in ARM RAM for RISC OS error blocks.
const ERROR_BLOCK_ADDR = 0x8200;

/** Write a RISC OS error block into ARM RAM and signal error via V flag. */
function riscosError(
  regs: RegisterFile,
  bus: SystemBus,
  errNum: number,
  message: string,
): void {
  bus.write32(ERROR_BLOCK_ADDR, errNum >>> 0);
  let off = ERROR_BLOCK_ADDR + 4;
  for (let i = 0; i < message.length; i++) {
    bus.write8(off++, message.charCodeAt(i));
  }
  bus.write8(off, 0);
  regs.write(0, ERROR_BLOCK_ADDR);
  regs.V = true;
}

/** Read a null-terminated string from ARM RAM. */
function readString(bus: SystemBus, addr: number, maxLen = 256): string {
  let s = "";
  for (let i = 0; i < maxLen; i++) {
    const ch = bus.read8(addr + i);
    if (ch === 0) break;
    s += String.fromCharCode(ch);
  }
  return s;
}

/** Write a null-terminated string into ARM RAM. */
function writeString(bus: SystemBus, addr: number, s: string): void {
  for (let i = 0; i < s.length; i++) bus.write8(addr + i, s.charCodeAt(i));
  bus.write8(addr + s.length, 0);
}

export class OSFileHandler {
  constructor(private readonly host: FileSystemHost) {}

  // ── OS_File (SWI 0x08) ────────────────────────────────────────────────────

  file(regs: RegisterFile, bus: SystemBus): void {
    const reason = regs.read(0);
    regs.V = false;

    try {
      switch (reason) {
        case 0: this.fileSave(regs, bus); break;
        case 5: this.fileReadInfo(regs, bus); break;
        case 6: this.fileDelete(regs, bus); break;
        case 7: this.fileCreate(regs, bus); break;
        case 255: this.fileLoad(regs, bus); break;
        default:
          // Unimplemented reason — return "not found" type so apps can cope.
          regs.write(0, 0);
          break;
      }
    } catch (e) {
      riscosError(regs, bus, 0xD6, (e instanceof Error ? e.message : String(e)).slice(0, 252));
    }
  }

  /** R0=0: save memory block as a file. R1=name, R4=start addr, R5=end addr */
  private fileSave(regs: RegisterFile, bus: SystemBus): void {
    const nameAddr = regs.read(1);
    const start    = regs.read(4) >>> 0;
    const end      = regs.read(5) >>> 0;
    const name     = readString(bus, nameAddr);

    const len = end > start ? end - start : 0;
    const data = new Uint8Array(len);
    for (let i = 0; i < len; i++) data[i] = bus.read8(start + i);

    this.host.writeFile(name, data);
    regs.write(0, 1); // type = file
  }

  /** R0=5: read catalogue info. R1=name → R0=type, R2=load, R3=exec, R4=size, R5=attrs */
  private fileReadInfo(regs: RegisterFile, bus: SystemBus): void {
    const name = readString(bus, regs.read(1));
    const info = this.host.stat(name);
    if (!info) {
      regs.write(0, 0); // not found
      return;
    }
    regs.write(0, info.type);
    regs.write(2, 0);         // load addr (not used in native mode)
    regs.write(3, 0);         // exec addr
    regs.write(4, info.size);
    regs.write(5, info.attrs);
  }

  /** R0=6: delete object. R1=name */
  private fileDelete(regs: RegisterFile, bus: SystemBus): void {
    const name = readString(bus, regs.read(1));
    const info = this.host.stat(name);
    if (!info) { regs.write(0, 0); return; }
    this.host.deleteObject(name);
    regs.write(0, info.type);
    regs.write(4, info.size);
  }

  /** R0=7: create empty file. R1=name, R4=size */
  private fileCreate(regs: RegisterFile, bus: SystemBus): void {
    const name = readString(bus, regs.read(1));
    const size = regs.read(4) >>> 0;
    this.host.writeFile(name, new Uint8Array(size));
    regs.write(0, 1);
  }

  /** R0=255: load file. R1=name, R2=load address, R3 bit0: use file's load addr (ignored) */
  private fileLoad(regs: RegisterFile, bus: SystemBus): void {
    const name    = readString(bus, regs.read(1));
    const loadAddr = regs.read(2) >>> 0;

    const data = this.host.readFile(name);
    bus.dmaWrite(loadAddr, data);

    regs.write(0, 1);           // type = file
    regs.write(2, loadAddr);    // actual load address
    regs.write(4, data.length);
    regs.write(5, 0x03);        // attrs
  }

  // ── OS_Find (SWI 0x0D) ───────────────────────────────────────────────────

  find(regs: RegisterFile, bus: SystemBus): void {
    regs.V = false;
    const reason = regs.read(0);
    try {
      if (reason === 0) {
        // Close
        const handle = regs.read(1);
        if (handle === 0) this.host.closeAll();
        else              this.host.closeFile(handle);
        return;
      }

      const noError = !!(reason & 0x08);
      const name    = readString(bus, regs.read(1));

      let mode: 'r' | 'w' | 'rw';
      switch (reason & 0xF0) {
        case 0x40: mode = 'r';  break;
        case 0x80: mode = 'w';  break;
        case 0xC0: mode = 'rw'; break;
        default:   mode = 'r';  break;
      }

      const handle = this.host.openFile(name, mode, noError);
      regs.write(0, handle);
    } catch (e) {
      riscosError(regs, bus, 0xD6, (e instanceof Error ? e.message : String(e)).slice(0, 252));
    }
  }

  // ── OS_Args (SWI 0x09) ───────────────────────────────────────────────────

  args(regs: RegisterFile, bus: SystemBus): void {
    regs.V = false;
    const reason = regs.read(0);
    const handle = regs.read(1);
    try {
      switch (reason) {
        case 0:   regs.write(2, this.host.getPointer(handle)); break;
        case 1:   this.host.setPointer(handle, regs.read(2) >>> 0); break;
        case 2:   regs.write(2, this.host.getExtent(handle)); break;
        case 3:   this.host.setExtent(handle, regs.read(2) >>> 0); break;
        case 255: this.host.flush(handle); break;
        default:  regs.write(2, 0); break;
      }
    } catch (e) {
      riscosError(regs, bus, 0xD6, (e instanceof Error ? e.message : String(e)).slice(0, 252));
    }
  }

  // ── OS_BGet (SWI 0x0A) ───────────────────────────────────────────────────

  bget(regs: RegisterFile, bus: SystemBus): void {
    regs.V = false;
    try {
      const { byte, eof } = this.host.readByte(regs.read(1));
      regs.write(0, byte);
      regs.C = eof;
    } catch (e) {
      riscosError(regs, bus, 0xD6, (e instanceof Error ? e.message : String(e)).slice(0, 252));
    }
  }

  // ── OS_BPut (SWI 0x0B) ───────────────────────────────────────────────────

  bput(regs: RegisterFile, _bus: SystemBus): void {
    regs.V = false;
    try {
      this.host.writeByte(regs.read(1), regs.read(0) & 0xFF);
    } catch (e) {
      // swallow — keep CPU running
    }
  }

  // ── OS_GBPB (SWI 0x0C) ───────────────────────────────────────────────────

  gbpb(regs: RegisterFile, bus: SystemBus): void {
    regs.V = false;
    const reason = regs.read(0);
    try {
      switch (reason) {
        case 1: this.gbpbWrite(regs, bus, true);  break; // write at R4
        case 2: this.gbpbWrite(regs, bus, false); break; // write at ptr
        case 3: this.gbpbRead (regs, bus, true);  break; // read  at R4
        case 4: this.gbpbRead (regs, bus, false); break; // read  at ptr
        case 8: this.gbpbReadDir(regs, bus);      break; // read dir
        default: break;
      }
    } catch (e) {
      riscosError(regs, bus, 0xD6, (e instanceof Error ? e.message : String(e)).slice(0, 252));
    }
  }

  private gbpbWrite(regs: RegisterFile, bus: SystemBus, usePos: boolean): void {
    const handle  = regs.read(1);
    const bufAddr = regs.read(2) >>> 0;
    const count   = regs.read(3) >>> 0;
    const atPos   = usePos ? (regs.read(4) >>> 0) : undefined;

    const data = new Uint8Array(count);
    for (let i = 0; i < count; i++) data[i] = bus.read8(bufAddr + i);

    this.host.writeBytes(handle, data, atPos);

    regs.write(2, bufAddr + count);
    regs.write(3, 0);
    if (usePos) regs.write(4, (atPos! + count) >>> 0);
    regs.C = false;
  }

  private gbpbRead(regs: RegisterFile, bus: SystemBus, usePos: boolean): void {
    const handle  = regs.read(1);
    const bufAddr = regs.read(2) >>> 0;
    const count   = regs.read(3) >>> 0;
    const atPos   = usePos ? (regs.read(4) >>> 0) : undefined;

    const { data, remaining } = this.host.readBytes(handle, count, atPos);

    bus.dmaWrite(bufAddr, data);

    regs.write(2, bufAddr + data.length);
    regs.write(3, remaining);
    if (usePos) regs.write(4, (atPos! + data.length) >>> 0);
    regs.C = remaining > 0;
  }

  private gbpbReadDir(regs: RegisterFile, bus: SystemBus): void {
    const nameAddr = regs.read(1) >>> 0;
    const bufAddr  = regs.read(2) >>> 0;
    const maxCount = regs.read(3) >>> 0;
    const offset   = regs.read(4) >>> 0;
    const bufLen   = regs.read(5) >>> 0;
    const patAddr  = regs.read(6) >>> 0;

    const name    = readString(bus, nameAddr);
    const pattern = patAddr ? readString(bus, patAddr) : undefined;

    const { entries, nextOffset } = this.host.readDir(name, offset, maxCount, pattern);

    // Write entries into the buffer
    let ptr = bufAddr;
    let written = 0;
    for (const entry of entries) {
      // Each entry: load(4) exec(4) size(4) attrs(4) type(4) name(n+1) pad-to-word
      const nameLen   = entry.name.length + 1; // +1 for null
      const entrySize = 20 + ((nameLen + 3) & ~3);
      if (ptr + entrySize > bufAddr + bufLen) break;

      bus.write32(ptr,      0);          // load addr
      bus.write32(ptr + 4,  0);          // exec addr
      bus.write32(ptr + 8,  entry.size);
      bus.write32(ptr + 12, entry.attrs);
      bus.write32(ptr + 16, entry.type);
      writeString(bus, ptr + 20, entry.name);

      ptr += entrySize;
      written++;
    }

    regs.write(3, written);
    regs.write(4, nextOffset >>> 0);
    regs.C = nextOffset === -1;
  }

  // ── OS_FSControl (SWI 0x19) ──────────────────────────────────────────────

  fsControl(regs: RegisterFile, bus: SystemBus): void {
    regs.V = false;
    const reason = regs.read(0);
    try {
      switch (reason) {
        case 0:  /* select filing system — ignore */ break;
        case 26: { // set CSD
          const dir = readString(bus, regs.read(1) >>> 0);
          this.host.setCurrentDir(dir);
          break;
        }
        case 36: { // canonicalise path — return as-is
          const src    = readString(bus, regs.read(1) >>> 0);
          const dstAddr = regs.read(2) >>> 0;
          const dstLen  = regs.read(5) >>> 0;
          if (dstAddr && dstLen) {
            writeString(bus, dstAddr, src.slice(0, dstLen - 1));
          }
          regs.write(5, Math.max(0, src.length + 1 - (dstLen || 0)));
          break;
        }
        default: break;
      }
    } catch (e) {
      riscosError(regs, bus, 0xD6, (e instanceof Error ? e.message : String(e)).slice(0, 252));
    }
  }
}
