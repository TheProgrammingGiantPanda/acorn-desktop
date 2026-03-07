/**
 * FileSystemHost — interface between the RISC OS FS SWI layer and the
 * host operating system.
 *
 * Implementations translate RISC OS paths ($.Dir.File) to host paths and
 * perform actual I/O.  All operations are synchronous — this mirrors the
 * behaviour of a real Archimedes where the CPU blocks during disc access.
 */

/** Object type as returned by OS_File R0=5 / readDir */
export type ObjectType = 0 | 1 | 2; // 0=not found, 1=file, 2=directory

export interface DirEntry {
  name:  string;
  type:  ObjectType;
  size:  number;
  /** RISC OS attribute byte (bit0=read, bit1=write, bit3=exec, etc.) */
  attrs: number;
}

export interface FileSystemHost {
  // ── Path / directory ─────────────────────────────────────────────────────

  /** Translate a RISC OS path string to an absolute host path. */
  resolvePath(riscosPath: string): string;
  /** Current selected directory as a RISC OS path (e.g. "$.Apps"). */
  getCurrentDir(): string;
  setCurrentDir(riscosPath: string): void;

  // ── File handle operations ────────────────────────────────────────────────

  /**
   * Open a file and return a RISC OS handle (>0).
   * mode 'r'  = read-only (file must exist)
   * mode 'w'  = write (create / truncate)
   * mode 'rw' = read+write (create if absent)
   * Returns 0 if `noError` is true and the file doesn't exist.
   */
  openFile(riscosPath: string, mode: 'r' | 'w' | 'rw', noError?: boolean): number;
  closeFile(handle: number): void;
  closeAll(): void;

  readByte(handle: number): { byte: number; eof: boolean };
  writeByte(handle: number, byte: number): void;

  /**
   * Read up to `count` bytes.
   * If `atPos` is given, seek there first (also updates sequential ptr).
   * Returns the data read and the number of bytes that could NOT be read
   * (i.e. 0 means all bytes were returned).
   */
  readBytes(handle: number, count: number, atPos?: number): { data: Uint8Array; remaining: number };

  /**
   * Write bytes.
   * If `atPos` is given, write starting there (also updates sequential ptr).
   */
  writeBytes(handle: number, data: Uint8Array, atPos?: number): void;

  getPointer(handle: number): number;
  setPointer(handle: number, ptr: number): void;
  getExtent(handle: number): number;
  setExtent(handle: number, size: number): void;
  flush(handle: number): void;

  // ── Catalogue operations ──────────────────────────────────────────────────

  /** Returns null if the object does not exist. */
  stat(riscosPath: string): { type: ObjectType; size: number; attrs: number } | null;
  deleteObject(riscosPath: string): void;
  /** Read entire file into a buffer. */
  readFile(riscosPath: string): Uint8Array;
  /** Write (create/replace) entire file. */
  writeFile(riscosPath: string, data: Uint8Array): void;

  /**
   * Read directory entries starting at `offset`.
   * Returns up to `maxEntries` entries and the next offset
   * (-1 when the listing is exhausted).
   */
  readDir(riscosPath: string, offset: number, maxEntries: number, pattern?: string): {
    entries: DirEntry[];
    nextOffset: number;
  };
}
