/**
 * NodeFsHost — Node.js implementation of FileSystemHost.
 *
 * Maps the RISC OS filing system root ($) to a configurable directory on the
 * host.  All I/O uses synchronous Node.js fs APIs so the emulated CPU blocks
 * exactly as it would on real hardware.
 */

import fs   from "fs";
import path from "path";
import type { FileSystemHost, ObjectType, DirEntry } from "@theprogramminggiantpanda/risc-os";

interface OpenFile {
  fd:     number;
  ptr:    number;
  mode:   'r' | 'w' | 'rw';
}

export class NodeFsHost implements FileSystemHost {
  /** RISC OS path of the current selected directory ("$" = root) */
  private csd = "$";

  /** Open file handles: RISC OS handle → descriptor */
  private handles = new Map<number, OpenFile>();
  private nextHandle = 1;

  constructor(private readonly rootDir: string) {
    fs.mkdirSync(rootDir, { recursive: true });
  }

  // ── Path translation ──────────────────────────────────────────────────────

  resolvePath(riscosPath: string): string {
    let p = riscosPath.trim();

    // Strip volume prefix  :VolumeName.$...
    if (p.startsWith(":")) {
      const dot = p.indexOf(".");
      p = dot !== -1 ? p.slice(dot + 1) : "$";
    }

    let base: string;
    let rest: string;

    if (p === "$" || p.startsWith("$.") || p === "") {
      base = this.rootDir;
      rest = p.startsWith("$.") ? p.slice(2) : "";
    } else if (p.startsWith("@.") || p === "@") {
      base = this.resolveToHost(this.csd);
      rest = p.startsWith("@.") ? p.slice(2) : "";
    } else if (p.startsWith("^")) {
      // Parent of CSD
      base = path.dirname(this.resolveToHost(this.csd));
      rest = p.startsWith("^.") ? p.slice(2) : "";
    } else {
      // Relative to CSD
      base = this.resolveToHost(this.csd);
      rest = p;
    }

    if (!rest) return base;

    // Walk path components, treating ^ as parent
    const parts = rest.split(".");
    const segs  = base.split(path.sep);
    for (const part of parts) {
      if (part === "^") segs.pop();
      else if (part)    segs.push(part);
    }
    return segs.join(path.sep);
  }

  /** Internal: resolve without the CSD-relative fallback loop */
  private resolveToHost(riscosPath: string): string {
    if (riscosPath === "$") return this.rootDir;
    if (riscosPath.startsWith("$.")) {
      const rest = riscosPath.slice(2).split(".").filter(Boolean);
      return path.join(this.rootDir, ...rest);
    }
    return this.rootDir;
  }

  getCurrentDir(): string { return this.csd; }

  setCurrentDir(riscosPath: string): void {
    // Validate the path exists
    const host = this.resolvePath(riscosPath);
    if (!fs.existsSync(host)) throw new Error(`Directory not found: ${riscosPath}`);
    this.csd = riscosPath;
  }

  // ── File handle operations ────────────────────────────────────────────────

  openFile(riscosPath: string, mode: 'r' | 'w' | 'rw', noError = false): number {
    const hostPath = this.resolvePath(riscosPath);

    let flags: string;
    switch (mode) {
      case 'r':  flags = "r";  break;
      case 'w':  flags = "w";  break;
      case 'rw': flags = "a+"; break;
    }

    let fd: number;
    try {
      fd = fs.openSync(hostPath, flags);
    } catch {
      if (noError) return 0;
      throw new Error(`Cannot open: ${riscosPath}`);
    }

    const handle = this.nextHandle++;
    if (this.nextHandle > 255) this.nextHandle = 1;

    // For 'rw' (update), start at position 0
    const ptr = 0;
    this.handles.set(handle, { fd, ptr, mode });
    return handle;
  }

  closeFile(handle: number): void {
    const f = this.handles.get(handle);
    if (!f) return;
    try { fs.closeSync(f.fd); } catch { /* ignore */ }
    this.handles.delete(handle);
  }

  closeAll(): void {
    for (const [handle] of this.handles) this.closeFile(handle);
  }

  readByte(handle: number): { byte: number; eof: boolean } {
    const f = this.getHandle(handle);
    const buf = Buffer.alloc(1);
    const n = fs.readSync(f.fd, buf, 0, 1, f.ptr);
    if (n === 0) return { byte: 0, eof: true };
    f.ptr++;
    return { byte: buf[0]!, eof: false };
  }

  writeByte(handle: number, byte: number): void {
    const f = this.getHandle(handle);
    const buf = Buffer.from([byte & 0xFF]);
    fs.writeSync(f.fd, buf, 0, 1, f.ptr);
    f.ptr++;
  }

  readBytes(handle: number, count: number, atPos?: number): { data: Uint8Array; remaining: number } {
    const f = this.getHandle(handle);
    const pos = atPos !== undefined ? atPos : f.ptr;
    const buf = Buffer.alloc(count);
    const n = fs.readSync(f.fd, buf, 0, count, pos);
    f.ptr = pos + n;
    return {
      data:      new Uint8Array(buf.buffer, 0, n),
      remaining: count - n,
    };
  }

  writeBytes(handle: number, data: Uint8Array, atPos?: number): void {
    const f = this.getHandle(handle);
    const pos = atPos !== undefined ? atPos : f.ptr;
    const buf = Buffer.from(data);
    fs.writeSync(f.fd, buf, 0, buf.length, pos);
    f.ptr = pos + buf.length;
  }

  getPointer(handle: number): number { return this.getHandle(handle).ptr; }

  setPointer(handle: number, ptr: number): void { this.getHandle(handle).ptr = ptr; }

  getExtent(handle: number): number {
    const f = this.getHandle(handle);
    return fs.fstatSync(f.fd).size;
  }

  setExtent(handle: number, size: number): void {
    const f = this.getHandle(handle);
    fs.ftruncateSync(f.fd, size);
  }

  flush(handle: number): void {
    const f = this.handles.get(handle);
    if (f) try { fs.fsyncSync(f.fd); } catch { /* ignore */ }
  }

  // ── Catalogue operations ──────────────────────────────────────────────────

  stat(riscosPath: string): { type: ObjectType; size: number; attrs: number } | null {
    const hostPath = this.resolvePath(riscosPath);
    try {
      const st = fs.statSync(hostPath);
      const type: ObjectType = st.isDirectory() ? 2 : 1;
      return { type, size: st.size, attrs: st.isDirectory() ? 0x08 : 0x03 };
    } catch {
      return null;
    }
  }

  deleteObject(riscosPath: string): void {
    const hostPath = this.resolvePath(riscosPath);
    const st = fs.statSync(hostPath);
    if (st.isDirectory()) fs.rmdirSync(hostPath);
    else                  fs.unlinkSync(hostPath);
  }

  readFile(riscosPath: string): Uint8Array {
    const hostPath = this.resolvePath(riscosPath);
    const buf = fs.readFileSync(hostPath);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  writeFile(riscosPath: string, data: Uint8Array): void {
    const hostPath = this.resolvePath(riscosPath);
    fs.mkdirSync(path.dirname(hostPath), { recursive: true });
    fs.writeFileSync(hostPath, data);
  }

  readDir(riscosPath: string, offset: number, maxEntries: number, pattern?: string): {
    entries: DirEntry[];
    nextOffset: number;
  } {
    const hostPath = this.resolvePath(riscosPath);
    let names: string[];
    try {
      names = fs.readdirSync(hostPath).sort();
    } catch {
      return { entries: [], nextOffset: -1 };
    }

    // Apply wildcard pattern (RISC OS uses * and # as wildcards)
    if (pattern && pattern !== "*") {
      const re = new RegExp(
        "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
                     .replace(/\*/g, ".*")
                     .replace(/#/g, ".") + "$",
        "i"
      );
      names = names.filter(n => re.test(n));
    }

    const slice = names.slice(offset, offset + maxEntries);
    const entries: DirEntry[] = slice.map(name => {
      try {
        const st = fs.statSync(path.join(hostPath, name));
        const type: ObjectType = st.isDirectory() ? 2 : 1;
        return { name, type, size: st.size, attrs: type === 2 ? 0x08 : 0x03 };
      } catch {
        return { name, type: 1 as ObjectType, size: 0, attrs: 0x03 };
      }
    });

    const nextOffset = offset + slice.length >= names.length ? -1 : offset + slice.length;
    return { entries, nextOffset };
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private getHandle(handle: number): OpenFile {
    const f = this.handles.get(handle);
    if (!f) throw new Error(`Invalid file handle: ${handle}`);
    return f;
  }
}
