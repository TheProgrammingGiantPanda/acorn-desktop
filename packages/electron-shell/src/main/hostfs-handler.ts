/**
 * HostFS SWI Handler
 *
 * Intercepts OS_File, OS_Find, OS_Args, OS_GBPB, OS_FSControl for paths that
 * begin with "HostFS::" and maps them onto the host filesystem via Node.js fs.
 * All other paths return 'passthrough' so the real ROM FileSwitch handles them.
 *
 * File handles 200–254 are reserved for HostFS to avoid colliding with the
 * ROM's own handle allocation (typically 1–127).
 *
 * RISC OS path format:  HostFS::$.dir.subdir.file
 * Host path format:     {rootDir}/dir/subdir/file
 */

import fs from "fs";
import path from "path";
import type { RegisterFile, ArchimedesMachine } from "@theprogramminggiantpanda/arm-emulator";
import type { SystemBus } from "@theprogramminggiantpanda/arm-emulator";

const SWI_OS_FILE      = 0x08;
const SWI_OS_ARGS      = 0x09;
const SWI_OS_GBPB      = 0x0C;
const SWI_OS_FIND      = 0x0D;
const SWI_OS_FSCONTROL = 0x19;

// RISC OS file attributes: public-read | owner-read | owner-write
const ATTR_DEFAULT = 0x03;

// ---------------------------------------------------------------------------
// File type helpers
// ---------------------------------------------------------------------------

/**
 * Parse a RISC OS `,xyz` filetype suffix from a host filename.
 * e.g. "Document,ffc" → { baseName: "Document", fileType: 0xFFC }
 *      "!Run"         → { baseName: "!Run",      fileType: null }
 */
function parseTypeSuffix(hostName: string): { baseName: string; fileType: number | null } {
  const match = /^(.+),([0-9a-fA-F]{3})$/.exec(hostName);
  if (match) return { baseName: match[1]!, fileType: parseInt(match[2]!, 16) };
  return { baseName: hostName, fileType: null };
}

/**
 * Convert a host file's mtime (ms since 1970 Unix epoch) to the pair of
 * words used in a RISC OS typed-file load/exec encoding:
 *
 *   load = 0xFFFtttHH  (ttt = 12-bit type, HH = top byte of 5-byte timestamp)
 *   exec = LLLLLLLL    (low 4 bytes of the 5-byte centisecond timestamp)
 *
 * The RISC OS epoch is 1 January 1900; the timestamp is centiseconds.
 */
function makeLoadExec(fileType: number, mtimeMs: number): { load: number; exec: number } {
  // Centiseconds from 1900-01-01 to 1970-01-01 (70 years + 17 leap days)
  const EPOCH_OFFSET_CS = 220_898_880_000n;
  const cs    = BigInt(Math.floor(mtimeMs / 10)) + EPOCH_OFFSET_CS;
  const csHi  = Number((cs >> 32n) & 0xFFn);   // top byte of 5-byte stamp
  const csLo  = Number(cs & 0xFFFF_FFFFn);       // lower 4 bytes
  const load  = (0xFFF00000 | ((fileType & 0xFFF) << 8) | csHi) >>> 0;
  return { load, exec: csLo >>> 0 };
}

/** Default load/exec for a file with no known type (untyped, no timestamp). */
const UNTYPED_LOAD = 0xFFFFFFFF;
const UNTYPED_EXEC = 0x00000000;

/**
 * Extract the 12-bit RISC OS file type from a typed load address
 * (bits [23:20] = 0xF → typed file; bits [19:8] = type).
 * Returns null for untyped load addresses.
 */
function extractFileType(loadAddr: number): number | null {
  return ((loadAddr >>> 20) & 0xFFF) === 0xFFF
    ? (loadAddr >>> 8) & 0xFFF
    : null;
}

interface HandleEntry {
  type:       "file" | "dir";
  nativePath: string;
  offset:     number;
  size:       number;
  /** Set for writable handles; accumulated in memory and flushed on close. */
  writeBuf?:  number[];
}

export class HostFsHandler {
  private readonly root: string;
  private readonly handles = new Map<number, HandleEntry>();
  private nextHandle = 200;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  // ---------------------------------------------------------------------------
  // Path translation
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private allocHandle(): number {
    const start = this.nextHandle;
    // Find the next free handle in the 200–254 range
    while (this.handles.has(this.nextHandle)) {
      this.nextHandle = this.nextHandle >= 254 ? 200 : this.nextHandle + 1;
      if (this.nextHandle === start) throw new Error("HostFS: out of file handles");
    }
    const h = this.nextHandle;
    this.nextHandle = this.nextHandle >= 254 ? 200 : this.nextHandle + 1;
    return h;
  }

  private readString(bus: SystemBus, addr: number, maxLen = 512): string {
    let s = "";
    for (let i = 0; i < maxLen; i++) {
      const ch = bus.read8(addr + i);
      if (ch === 0 || ch === 13) break; // null or CR terminates
      s += String.fromCharCode(ch);
    }
    return s;
  }

  private writeString(bus: SystemBus, addr: number, s: string): number {
    for (let i = 0; i < s.length; i++) bus.write8(addr + i, s.charCodeAt(i));
    bus.write8(addr + s.length, 0);
    return s.length + 1;
  }

  private statToType(stat: fs.Stats): 1 | 2 {
    return stat.isDirectory() ? 2 : 1;
  }

  /**
   * Return the host path to write to for a given RISC OS leaf name + file type.
   * Appends `,xyz` when fileType is known, and removes any existing file in the
   * same directory that has the same base name with a *different* `,xyz` suffix
   * (RISC OS re-typing a file should not leave an orphaned copy behind).
   */
  private saveNativePath(dir: string, riscosLeaf: string, fileType: number | null): string {
    const suffix  = fileType !== null ? `,${fileType.toString(16).padStart(3, "0")}` : "";
    const newName = riscosLeaf + suffix;

    // Remove stale ,xyz copies with a different suffix
    try {
      for (const entry of fs.readdirSync(dir)) {
        const { baseName } = parseTypeSuffix(entry);
        if (baseName.toLowerCase() === riscosLeaf.toLowerCase() && entry !== newName) {
          try { fs.unlinkSync(path.join(dir, entry)); } catch { /* ignore */ }
        }
      }
    } catch { /* dir unreadable — ignore */ }

    return path.join(dir, newName);
  }

  /**
   * Resolve a RISC OS leaf name (no `,xyz` suffix) to the actual host filename
   * inside `dir`.  If a file exists with a `,xyz` suffix it takes precedence;
   * otherwise the bare name is returned (which may or may not exist).
   */
  private resolveLeaf(dir: string, riscosLeaf: string): string {
    // Try exact match first (covers directories and untyped files)
    const exact = path.join(dir, riscosLeaf);
    try { fs.statSync(exact); return exact; } catch { /* try typed suffix */ }

    // Scan directory for a file with the same base name + ,xyz suffix
    try {
      const entries = fs.readdirSync(dir);
      const lowerLeaf = riscosLeaf.toLowerCase();
      for (const entry of entries) {
        const { baseName } = parseTypeSuffix(entry);
        if (baseName.toLowerCase() === lowerLeaf) return path.join(dir, entry);
      }
    } catch { /* fall through */ }

    return exact; // not found either way — return bare path (caller handles error)
  }

  /**
   * Translate a RISC OS HostFS path to the actual native path, resolving each
   * component through `resolveLeaf` so that `,xyz`-suffixed files are found
   * transparently.
   */
  private toNativeResolved(riscosPath: string): string | null {
    if (!riscosPath.toLowerCase().startsWith("hostfs::")) return null;
    const inner = riscosPath.slice(8);
    let components: string[];
    if (inner === "$" || inner === "$.") {
      return this.root;
    } else if (inner.startsWith("$.")) {
      components = inner.slice(2).split(".");
    } else {
      components = inner.split(".");
    }

    let current = this.root;
    for (const comp of components) {
      current = this.resolveLeaf(current, comp);
    }
    return current;
  }

  // ---------------------------------------------------------------------------
  // OS_File (SWI 0x08)
  // ---------------------------------------------------------------------------

  private handleOsFile(regs: RegisterFile, bus: SystemBus): "passthrough" | void {
    const reason   = regs.read(0);
    const pathAddr = regs.read(1) >>> 0;
    const riscPath = this.readString(bus, pathAddr);
    const native   = this.toNativeResolved(riscPath);
    if (native === null) return "passthrough";

    regs.V = false;

    switch (reason) {
      case 0: { // Save memory block to file
        // R1=name, R2=load addr (may encode type), R3=exec addr, R4=start, R5=end
        const loadAddr = regs.read(2) >>> 0;
        const start    = regs.read(4) >>> 0;
        const end      = regs.read(5) >>> 0;
        const fileType = extractFileType(loadAddr);
        const leaf     = path.basename(native);
        const dir      = path.dirname(native);
        const savePath = this.saveNativePath(dir, leaf, fileType);
        const len      = end > start ? end - start : 0;
        const data     = new Uint8Array(len);
        for (let i = 0; i < len; i++) data[i] = bus.read8(start + i);
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(savePath, data);
          regs.write(0, 1); // type = file
          regs.write(2, loadAddr);
          regs.write(3, regs.read(3)); // preserve exec addr
          regs.write(4, len);
          regs.write(5, ATTR_DEFAULT);
        } catch {
          regs.write(0, 0);
        }
        break;
      }

      case 5: { // Read catalogue info
        try {
          const stat = fs.statSync(native);
          const { baseName: _, fileType } = parseTypeSuffix(path.basename(native));
          let load: number, exec: number;
          if (fileType !== null) {
            ({ load, exec } = makeLoadExec(fileType, stat.mtimeMs));
          } else {
            load = UNTYPED_LOAD; exec = UNTYPED_EXEC;
          }
          regs.write(0, this.statToType(stat)); // 1=file, 2=dir
          regs.write(2, load);
          regs.write(3, exec);
          regs.write(4, stat.isFile() ? stat.size : 0);
          regs.write(5, ATTR_DEFAULT);
        } catch {
          regs.write(0, 0); // not found
        }
        break;
      }

      case 8: // Create directory
        try { fs.mkdirSync(native, { recursive: true }); } catch { /* ignore */ }
        regs.write(0, 2);
        break;

      case 255: { // Load file to address in R2
        const destAddr = regs.read(2) >>> 0;
        try {
          const stat = fs.statSync(native);
          const { fileType } = parseTypeSuffix(path.basename(native));
          let load: number, exec: number;
          if (fileType !== null) {
            ({ load, exec } = makeLoadExec(fileType, stat.mtimeMs));
          } else {
            load = UNTYPED_LOAD; exec = UNTYPED_EXEC;
          }
          const data = fs.readFileSync(native);
          bus.dmaWrite(destAddr, data);
          regs.write(0, 1);
          regs.write(2, load);
          regs.write(3, exec);
          regs.write(4, data.length);
          regs.write(5, ATTR_DEFAULT);
        } catch {
          regs.write(0, 0);
        }
        break;
      }

      default:
        regs.write(0, 0);
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // OS_Find (SWI 0x0D)
  // ---------------------------------------------------------------------------

  private handleOsFind(regs: RegisterFile, bus: SystemBus): "passthrough" | void {
    const reason = regs.read(0) & 0xFF;
    regs.V = false;

    if (reason === 0) {
      // Close: R1 = handle (0 = close all HostFS handles)
      const handle = regs.read(1);
      if (handle === 0) {
        for (const entry of this.handles.values()) this.flushHandle(entry);
        this.handles.clear();
        return "passthrough"; // also let ROM close its own handles
      }
      if (this.handles.has(handle)) {
        const entry = this.handles.get(handle)!;
        this.flushHandle(entry);
        this.handles.delete(handle);
        return; // handled — don't touch ROM
      }
      return "passthrough"; // not our handle
    }

    // Open: R0 bits[7:4]=mode (0x40=read, 0x80=write, 0xC0=update), R1=path
    const mode     = reason & 0xF0;
    const pathAddr = regs.read(1) >>> 0;
    const riscPath = this.readString(bus, pathAddr);
    const native   = this.toNativeResolved(riscPath);
    if (native === null) return "passthrough";

    try {
      const writable = mode === 0x80 || mode === 0xC0;
      let existingData: number[] = [];
      let size = 0;
      try {
        const buf  = fs.readFileSync(native);
        existingData = Array.from(buf);
        size = buf.length;
      } catch {
        // New file — start empty (write mode)
        if (!writable) { regs.write(0, 0); return; }
      }
      const h = this.allocHandle();
      this.handles.set(h, {
        type:      "file",
        nativePath: native,
        offset:    0,
        size,
        writeBuf:  writable ? existingData : undefined,
      });
      regs.write(0, h);
    } catch {
      regs.write(0, 0); // file not found
    }
  }

  /** Flush a writable handle's write buffer to disk. */
  private flushHandle(entry: HandleEntry): void {
    if (!entry.writeBuf) return;
    try { fs.writeFileSync(entry.nativePath, Buffer.from(entry.writeBuf)); }
    catch { /* best-effort */ }
  }

  // ---------------------------------------------------------------------------
  // OS_Args (SWI 0x09)
  // ---------------------------------------------------------------------------

  private handleOsArgs(regs: RegisterFile, bus: SystemBus): "passthrough" | void {
    const reason = regs.read(0);
    const handle = regs.read(1);
    const entry  = this.handles.get(handle);
    if (!entry) return "passthrough";

    regs.V = false;
    switch (reason) {
      case 0: regs.write(2, entry.offset); break;             // read ptr
      case 1: entry.offset = regs.read(2) >>> 0; break;       // set ptr
      case 2: regs.write(2, entry.size);   break;             // read extent
      case 255: this.flushHandle(entry); break;
      default: regs.write(2, 0); break;
    }
  }

  // ---------------------------------------------------------------------------
  // OS_GBPB (SWI 0x0C)
  // ---------------------------------------------------------------------------

  private handleOsGBPB(regs: RegisterFile, bus: SystemBus): "passthrough" | void {
    const reason = regs.read(0);
    regs.V = false;

    // ── Directory enumeration (reasons 9, 10, 11, 12) ────────────────────────
    // R1 = path ptr, R2 = buf addr, R3 = max entries, R4 = start index, R5 = buf len
    if (reason >= 9 && reason <= 12) {
      const pathAddr = regs.read(1) >>> 0;
      const riscPath = this.readString(bus, pathAddr);
      const native   = this.toNativeResolved(riscPath);
      if (native === null) return "passthrough";

      const bufAddr  = regs.read(2) >>> 0;
      const maxCount = regs.read(3) >>> 0;
      const startIdx = regs.read(4) >>> 0;
      const bufLen   = regs.read(5) >>> 0;

      let allEntries: string[];
      try { allEntries = fs.readdirSync(native).sort(); }
      catch { regs.write(3, 0); regs.write(4, 0xFFFFFFFF); return; }

      let ptr     = bufAddr;
      let written = 0;
      let idx     = startIdx;

      while (written < maxCount && idx < allEntries.length) {
        const hostName  = allEntries[idx]!;
        const entryPath = path.join(native, hostName);
        let stat: fs.Stats;
        try { stat = fs.statSync(entryPath); } catch { idx++; continue; }

        // Strip ,xyz suffix — present the bare name to RISC OS
        const { baseName, fileType } = parseTypeSuffix(hostName);

        // Calculate entry size before writing to check buffer bounds
        const nameBytes = baseName.length + 1; // with null terminator
        const namePad   = (nameBytes + 3) & ~3;
        const infoSize  = reason >= 10 ? 20 : 0; // 5 words of info for reasons 10+
        const entrySize = infoSize + namePad;

        if (ptr + entrySize > bufAddr + bufLen) break;

        if (reason >= 10) {
          // Load addr, exec addr, size, attrs, type (5 words)
          let load: number, exec: number;
          if (fileType !== null) {
            ({ load, exec } = makeLoadExec(fileType, stat.mtimeMs));
          } else {
            load = UNTYPED_LOAD; exec = UNTYPED_EXEC;
          }
          bus.write32(ptr,      load);
          bus.write32(ptr + 4,  exec);
          bus.write32(ptr + 8,  stat.isFile() ? stat.size : 0);
          bus.write32(ptr + 12, ATTR_DEFAULT);
          bus.write32(ptr + 16, stat.isDirectory() ? 2 : 1); // object type
          ptr += 20;
        }

        // Write bare name + null, padded to word
        const len = this.writeString(bus, ptr, baseName);
        for (let p = len; p < namePad; p++) bus.write8(ptr + p, 0);
        ptr += namePad;

        written++;
        idx++;
      }

      regs.write(3, written);
      regs.write(4, idx >= allEntries.length ? 0xFFFFFFFF : idx);
      return;
    }

    // ── Sequential file write (reasons 1, 2) ─────────────────────────────────
    if (reason === 1 || reason === 2) {
      const handle  = regs.read(1);
      const bufAddr = regs.read(2) >>> 0;
      const count   = regs.read(3) >>> 0;
      const entry   = this.handles.get(handle);
      if (!entry || !entry.writeBuf) return "passthrough";

      const writeAt = reason === 1 ? regs.read(4) >>> 0 : entry.offset;

      // Extend the write buffer if needed
      const needed = writeAt + count;
      while (entry.writeBuf.length < needed) entry.writeBuf.push(0);
      for (let i = 0; i < count; i++) {
        entry.writeBuf[writeAt + i] = bus.read8(bufAddr + i);
      }
      entry.offset = writeAt + count;
      entry.size   = Math.max(entry.size, entry.offset);

      regs.write(2, bufAddr + count);
      regs.write(3, 0); // zero bytes remaining
      if (reason === 1) regs.write(4, entry.offset);
      return;
    }

    // ── Sequential file read (reasons 3, 4) ──────────────────────────────────
    if (reason === 3 || reason === 4) {
      const handle  = regs.read(1);
      const bufAddr = regs.read(2) >>> 0;
      let   count   = regs.read(3) >>> 0;
      const entry   = this.handles.get(handle);
      if (!entry || entry.type !== "file") return "passthrough";

      let readAt: number;
      if (reason === 3) {
        readAt = regs.read(4) >>> 0;
      } else {
        readAt = entry.offset;
      }

      let data: Buffer;
      try { data = fs.readFileSync(entry.nativePath); }
      catch { regs.write(3, count); return; }

      const avail  = Math.max(0, data.length - readAt);
      const toRead = Math.min(count, avail);
      bus.dmaWrite(bufAddr, new Uint8Array(data.buffer, readAt, toRead));

      entry.offset = readAt + toRead;
      count -= toRead;
      regs.write(3, count);
      if (reason === 3) regs.write(4, readAt + toRead);
      return;
    }

    return "passthrough";
  }

  // ---------------------------------------------------------------------------
  // OS_FSControl (SWI 0x19)
  // ---------------------------------------------------------------------------

  private handleOsFsControl(regs: RegisterFile, bus: SystemBus): "passthrough" | void {
    const reason = regs.read(0);
    regs.V = false;

    switch (reason) {
      case 0: { // Select filing system — if "HostFS" is selected, acknowledge
        const nameAddr = regs.read(1) >>> 0;
        if (nameAddr) {
          const name = this.readString(bus, nameAddr);
          if (name.toLowerCase() === "hostfs") return; // handled
        }
        return "passthrough";
      }
      case 36: { // Canonicalise path
        const srcAddr  = regs.read(1) >>> 0;
        const dstAddr  = regs.read(2) >>> 0;
        const dstLen   = regs.read(5) >>> 0;
        const src      = this.readString(bus, srcAddr);
        if (this.toNativeResolved(src) === null) return "passthrough";
        if (dstAddr && dstLen) {
          this.writeString(bus, dstAddr, src.slice(0, dstLen - 1));
        }
        regs.write(5, Math.max(0, src.length + 1 - (dstLen || 0)));
        break;
      }
      default:
        return "passthrough";
    }
  }

  // ---------------------------------------------------------------------------
  // Register all handlers on the machine
  // ---------------------------------------------------------------------------

  register(machine: ArchimedesMachine): void {
    machine.registerSWI(SWI_OS_FILE,      (r, b) => this.handleOsFile(r, b));
    machine.registerSWI(SWI_OS_FIND,      (r, b) => this.handleOsFind(r, b));
    machine.registerSWI(SWI_OS_ARGS,      (r, b) => this.handleOsArgs(r, b));
    machine.registerSWI(SWI_OS_GBPB,      (r, b) => this.handleOsGBPB(r, b));
    machine.registerSWI(SWI_OS_FSCONTROL, (r, b) => this.handleOsFsControl(r, b));
  }
}
