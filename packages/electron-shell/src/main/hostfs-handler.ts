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

interface HandleEntry {
  type:       "file" | "dir";
  nativePath: string;
  offset:     number;
  size:       number;
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

  /** Returns the native path for a "HostFS::" RISC OS path, or null if not ours. */
  private toNative(riscosPath: string): string | null {
    if (!riscosPath.toLowerCase().startsWith("hostfs::")) return null;
    const inner = riscosPath.slice(8); // strip "HostFS::"
    let relative: string;
    if (inner === "$" || inner === "$.") {
      relative = "";
    } else if (inner.startsWith("$.")) {
      // Replace RISC OS "." separator with native separator
      relative = inner.slice(2).split(".").join(path.sep);
    } else {
      // No $ prefix — treat as relative to root
      relative = inner.split(".").join(path.sep);
    }
    return path.join(this.root, relative);
  }

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

  // ---------------------------------------------------------------------------
  // OS_File (SWI 0x08)
  // ---------------------------------------------------------------------------

  private handleOsFile(regs: RegisterFile, bus: SystemBus): "passthrough" | void {
    const reason   = regs.read(0);
    const pathAddr = regs.read(1) >>> 0;
    const riscPath = this.readString(bus, pathAddr);
    const native   = this.toNative(riscPath);
    if (native === null) return "passthrough";

    regs.V = false;

    switch (reason) {
      case 5: { // Read catalogue info
        try {
          const stat = fs.statSync(native);
          regs.write(0, this.statToType(stat)); // 1=file, 2=dir
          regs.write(2, 0xFFFFFFFF);            // load addr (untyped)
          regs.write(3, 0x00000000);            // exec addr
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
          const data = fs.readFileSync(native);
          bus.dmaWrite(destAddr, data);
          regs.write(0, 1);           // type = file
          regs.write(2, destAddr);
          regs.write(3, 0);
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
        this.handles.clear();
        return "passthrough"; // also let ROM close its own handles
      }
      if (this.handles.has(handle)) {
        this.handles.delete(handle);
        return; // handled — don't touch ROM
      }
      return "passthrough"; // not our handle
    }

    // Open: R0 bits[7:4]=mode (0x40=read, 0x80=write, 0xC0=update), R1=path
    const pathAddr = regs.read(1) >>> 0;
    const riscPath = this.readString(bus, pathAddr);
    const native   = this.toNative(riscPath);
    if (native === null) return "passthrough";

    try {
      const stat = fs.statSync(native);
      const h    = this.allocHandle();
      this.handles.set(h, {
        type:       this.statToType(stat) === 2 ? "dir" : "file",
        nativePath: native,
        offset:     0,
        size:       stat.isFile() ? stat.size : 0,
      });
      regs.write(0, h);
    } catch {
      regs.write(0, 0); // file not found
    }
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
      case 255: /* flush — no-op for read-only */ break;
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
      const native   = this.toNative(riscPath);
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
        const name      = allEntries[idx]!;
        const entryPath = path.join(native, name);
        let stat: fs.Stats;
        try { stat = fs.statSync(entryPath); } catch { idx++; continue; }

        // Calculate entry size before writing to check buffer bounds
        const nameBytes = name.length + 1; // with null terminator
        const namePad   = (nameBytes + 3) & ~3;
        const infoSize  = reason >= 10 ? 20 : 0; // 5 words of info for reasons 10+
        const entrySize = infoSize + namePad;

        if (ptr + entrySize > bufAddr + bufLen) break;

        if (reason >= 10) {
          // Load addr, exec addr, size, attrs, type (5 words)
          bus.write32(ptr,      0xFFFFFFFF);  // load addr (untyped)
          bus.write32(ptr + 4,  0x00000000);  // exec addr
          bus.write32(ptr + 8,  stat.isFile() ? stat.size : 0);
          bus.write32(ptr + 12, ATTR_DEFAULT);
          bus.write32(ptr + 16, stat.isDirectory() ? 2 : 1); // object type
          ptr += 20;
        }

        // Write name + null, padded to word
        const len = this.writeString(bus, ptr, name);
        for (let p = len; p < namePad; p++) bus.write8(ptr + p, 0);
        ptr += namePad;

        written++;
        idx++;
      }

      regs.write(3, written);
      regs.write(4, idx >= allEntries.length ? 0xFFFFFFFF : idx);
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
        if (this.toNative(src) === null) return "passthrough";
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
