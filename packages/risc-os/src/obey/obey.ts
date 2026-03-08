/**
 * RISC OS Obey script interpreter
 *
 * Obey files are simple line-by-line CLI scripts used in !Run and !Boot.
 * Each line is a CLI command; '|' begins a comment.
 *
 * Commands handled:
 *   Set / SetMacro / Unset     — system variable management
 *   Run <path>                 — run an Obey file or ARM binary
 *   RMLoad <path>              — load a relocatable module (stub)
 *   RMEnsure <n> <v> [<cmd>]  — ensure module version present (stub)
 *   WimpSlot [-min n] [-max n] — set Wimp slot size (stub)
 *   If <cond> Then <c> [Else <c>] — conditional
 *   Error [<n>] <msg>          — report error
 *   Echo <text>                — print text
 *   IconSprites <path>         — load app sprites into the sprite pool
 *   | <comment>                — ignored
 */

import type { FileSystemHost } from '../fs/fs-host.js';
import type { SystemVariables } from '../sysvar/sysvar.js';
import type { SpritePool } from '../sprite/sprite-pool.js';
import { ModuleRegistry, moduleLeafName } from '../modules/module-registry.js';

export interface ObeyOptions {
  onOutput?:    (text: string) => void;
  /** Called when Run targets an ARM binary (not an Obey file). */
  onRunBinary?: (riscosPath: string) => void;
  /** Sprite pool to load sprites into when IconSprites is executed. */
  spritePool?:  SpritePool;
  /** Module registry shared with the SWI dispatcher. */
  modules?:     ModuleRegistry;
}

export class ObeyInterpreter {
  private readonly output:    (text: string) => void;
  private readonly runBinary: (path: string) => void;
  private readonly spritePool: SpritePool | undefined;
  private readonly modules:    ModuleRegistry;

  constructor(
    private readonly fs:     FileSystemHost | undefined,
    private readonly sysvar: SystemVariables,
    options: ObeyOptions = {},
  ) {
    this.output     = options.onOutput    ?? (() => {});
    this.runBinary  = options.onRunBinary ?? (() => {});
    this.spritePool = options.spritePool;
    this.modules    = options.modules ?? new ModuleRegistry();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Read an Obey file from the RISC OS filesystem and execute it. */
  runFile(riscosPath: string): void {
    if (!this.fs) {
      this.output(`Obey: no filesystem — cannot read ${riscosPath}\r\n`);
      return;
    }

    let content: Uint8Array;
    try {
      content = this.fs.readFile(riscosPath);
    } catch {
      this.output(`Obey: cannot read ${riscosPath}\r\n`);
      return;
    }

    const dir = parentDir(riscosPath);
    const saved = this.sysvar.get('Obey$Dir');
    this.sysvar.set('Obey$Dir', dir);
    try {
      const text = new TextDecoder().decode(content);
      for (const rawLine of text.split(/\r?\n/)) {
        this.executeLine(rawLine.trimEnd());
      }
    } finally {
      if (saved !== undefined) this.sysvar.set('Obey$Dir', saved);
      else                      this.sysvar.unset('Obey$Dir');
    }
  }

  /** Execute a single CLI command string (e.g. from OS_CLI or a line of !Run). */
  executeLine(raw: string): void {
    // Expand system variable references first
    const line = this.sysvar.substitute(raw).trimStart();
    if (!line || line.startsWith('|')) return;

    const [cmd, rest] = splitFirst(line);
    switch (cmd.toUpperCase()) {
      case 'SET':         this.cmdSet(rest, 'string'); break;
      case 'SETMACRO':    this.cmdSet(rest, 'macro');  break;
      case 'UNSET':       this.sysvar.unset(rest.trim()); break;
      case 'RUN':         this.cmdRun(rest.trim()); break;
      case 'RMLOAD':      this.cmdRMLoad(rest.trim()); break;
      case 'RMENSURE':    this.cmdRMEnsure(rest.trim()); break;
      case 'WIMPSLOT':    /* stub — slot sizing handled by Wimp */ break;
      case 'IF':          this.cmdIf(rest); break;
      case 'ERROR':       this.cmdError(rest.trim()); break;
      case 'ECHO':        this.output(rest.trim() + '\r\n'); break;
      case 'ICONSPRITES': this.cmdIconSprites(rest.trim()); break;
      default:
        // Bare path or unrecognised command: treat as Run
        this.cmdRun(line);
        break;
    }
  }

  // ── Command implementations ─────────────────────────────────────────────────

  private cmdSet(args: string, type: 'string' | 'macro'): void {
    // Set <name> <value>
    const m = args.trimStart().match(/^(\S+)\s*(.*)/s);
    if (!m) return;
    this.sysvar.set(m[1]!, m[2]?.trimEnd() ?? '', type);
  }

  private cmdRun(path: string): void {
    // Strip any trailing arguments (e.g. "%*0" Obey parameter substitution).
    // RISC OS paths never contain spaces, so the first whitespace-delimited
    // token is always the file path.
    path = path.split(/\s+/)[0] ?? '';
    if (!path) return;

    if (!this.fs) {
      this.runBinary(path);
      return;
    }

    let content: Uint8Array | null = null;
    try { content = this.fs.readFile(path); } catch { /* not found or binary */ }

    if (content && looksLikeObey(content)) {
      this.runFile(path);
    } else {
      this.runBinary(path);
    }
  }

  private cmdIconSprites(rawPath: string): void {
    if (!this.spritePool || !this.fs) return;
    const riscosPath = this.resolvePathVar(rawPath);
    let data: Uint8Array;
    try {
      data = this.fs.readFile(riscosPath);
    } catch {
      // Sprite file missing — silently skip (e.g. !Sprites22 on wrong hardware)
      return;
    }
    this.spritePool.loadArea(data);
  }

  /**
   * Resolve RISC OS path-variable syntax: "AppName:rest" → value of AppName$Path + rest.
   * This is distinct from <VarName> substitution (handled by sysvar.substitute earlier).
   */
  private resolvePathVar(rawPath: string): string {
    const colon = rawPath.indexOf(':');
    if (colon > 0) {
      const appName = rawPath.slice(0, colon);
      const rest    = rawPath.slice(colon + 1);
      const pathVar = this.sysvar.get(`${appName}$Path`);
      if (pathVar !== undefined) return pathVar + rest;
    }
    return rawPath;
  }

  private cmdRMLoad(path: string): void {
    const leaf = moduleLeafName(path);
    const entry = this.modules.findByFilename(leaf);
    if (entry) {
      // Built-in stub — already registered, nothing else needed.
      return;
    }
    // Future: attempt to load from filesystem and parse module header.
    this.output(`RMLoad: ${path} (no stub available)\r\n`);
  }

  private cmdRMEnsure(args: string): void {
    // RMEnsure <ModuleName> <MinVersion> [<FallbackCommand>]
    const m = args.match(/^(\S+)\s+(\S+)(?:\s+(.*))?$/s);
    if (!m) return;
    const [, name, version, fallback] = m as [string, string, string, string | undefined];
    if (!this.modules.ensure(name, version)) {
      if (fallback?.trim()) this.executeLine(fallback.trim());
    }
  }

  private cmdIf(args: string): void {
    // If <cond> Then <thenCmd> [Else <elseCmd>]
    const m = args.match(/^(.*?)\s+Then\s+(.*?)(?:\s+Else\s+(.*))?$/is);
    if (!m) return;
    const cond    = m[1]!.trim();
    const thenCmd = m[2]!.trim();
    const elseCmd = m[3]?.trim();

    if (evalCond(cond)) {
      this.executeLine(thenCmd);
    } else if (elseCmd) {
      this.executeLine(elseCmd);
    }
  }

  private cmdError(args: string): void {
    // Error [<num>] <message>
    const m = args.match(/^(\d+)\s+(.*)$/s);
    const msg = m ? m[2]! : args;
    this.output(`Error: ${msg}\r\n`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Split "WORD rest" on the first whitespace boundary. */
function splitFirst(line: string): [string, string] {
  const i = line.search(/\s/);
  if (i === -1) return [line, ''];
  return [line.slice(0, i), line.slice(i)];
}

/** Parent directory of a RISC OS path (e.g. "$.Apps.!Paint.!Run" → "$.Apps.!Paint"). */
function parentDir(riscosPath: string): string {
  const i = riscosPath.lastIndexOf('.');
  return i > 0 ? riscosPath.slice(0, i) : '$';
}

/**
 * Heuristic: does the file content look like an Obey script rather than an ARM binary?
 * Obey scripts are plain ASCII text; ARM binaries will contain non-printable bytes.
 */
function looksLikeObey(data: Uint8Array): boolean {
  if (data.length === 0) return false;
  const limit = Math.min(data.length, 512);
  for (let i = 0; i < limit; i++) {
    const b = data[i]!;
    // Allow printable ASCII, tab, LF, CR
    if (b !== 0x09 && b !== 0x0A && b !== 0x0D && (b < 0x20 || b > 0x7E)) return false;
  }
  return true;
}

/** Evaluate a simple Obey If condition. */
function evalCond(cond: string): boolean {
  // "val1" = "val2"
  const eqMatch = cond.match(/^"(.*)"\s*=\s*"(.*)"$/s);
  if (eqMatch) return eqMatch[1] === eqMatch[2];

  // Single quoted string: true if non-empty
  const strMatch = cond.match(/^"(.*)"$/s);
  if (strMatch) return strMatch[1]!.length > 0;

  // Bare value: true if non-empty and not "0"
  return cond.length > 0 && cond !== '0';
}
