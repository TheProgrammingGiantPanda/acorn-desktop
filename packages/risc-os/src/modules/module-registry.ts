/**
 * RISC OS Module Registry
 *
 * Tracks relocatable modules that are currently "loaded" in the OS.
 * RMLoad registers a module; RMEnsure queries whether a module satisfying
 * a minimum version is present.
 *
 * Built-in stubs are pre-registered to represent ROM modules and common
 * modules that the emulator provides natively without executing ARM code.
 */

export interface ModuleEntry {
  /** Official module name used in RMEnsure queries (e.g. "SharedCLibrary"). */
  name: string;
  /** Version as a floating-point number (e.g. 3.60). */
  version: number;
  /**
   * Alternative names / filenames that RMLoad can use to identify this module
   * (e.g. "CLib" → SharedCLibrary).
   */
  aliases: readonly string[];
}

/** Built-in modules that are always available (ROM or native stubs). */
const BUILTIN_MODULES: ModuleEntry[] = [
  { name: 'UtilityModule',   version: 3.71,  aliases: ['UtilityModule'] },
  { name: 'SharedCLibrary',  version: 5.17,  aliases: ['CLib', 'CLib2', 'SharedCLibrary'] },
  { name: 'MessageTrans',    version: 0.31,  aliases: ['MsgTrans', 'MessageTrans'] },
  { name: 'Squash',          version: 0.29,  aliases: ['Squash'] },
  { name: 'ColourTrans',     version: 0.57,  aliases: ['ColourTran', 'ColourTrans'] },
  { name: 'WindowManager',   version: 3.98,  aliases: ['Wimp', 'WindowManager'] },
  { name: 'FileCore',        version: 3.23,  aliases: ['FileCore'] },
  { name: 'ADFS',            version: 3.24,  aliases: ['ADFS', 'ADFSFiler'] },
  { name: 'FPEmulator',      version: 4.06,  aliases: ['FPEmulator'] },
  { name: 'TaskManager',     version: 1.12,  aliases: ['TaskManager'] },
  { name: 'SpriteExtend',    version: 0.99,  aliases: ['SpriteExtend'] },
  { name: 'DrawMod',         version: 1.35,  aliases: ['Draw', 'DrawMod'] },
  { name: 'FontManager',     version: 3.31,  aliases: ['Font', 'FontManager'] },
];

export class ModuleRegistry {
  /** Canonical name (upper-cased) → entry */
  private byName = new Map<string, ModuleEntry>();
  /** Alias/filename (upper-cased) → entry */
  private byAlias = new Map<string, ModuleEntry>();

  constructor() {
    for (const m of BUILTIN_MODULES) {
      this.register(m);
    }
  }

  /**
   * Register a module entry.  Overwrites any previously registered entry with
   * the same canonical name, and updates all alias lookups.
   */
  register(entry: ModuleEntry): void {
    this.byName.set(entry.name.toUpperCase(), entry);
    for (const alias of entry.aliases) {
      this.byAlias.set(alias.toUpperCase(), entry);
    }
  }

  /**
   * Find a module by the leaf filename from an RMLoad path.
   * Returns the entry if a built-in stub matches, otherwise null.
   */
  findByFilename(filename: string): ModuleEntry | null {
    return this.byAlias.get(filename.toUpperCase()) ?? null;
  }

  /**
   * RMEnsure check: returns true if a module with the given name is loaded at
   * a version >= minVersion.
   */
  ensure(name: string, minVersionStr: string): boolean {
    const entry = this.byName.get(name.toUpperCase())
                ?? this.byAlias.get(name.toUpperCase());
    if (!entry) return false;
    const required = parseVersion(minVersionStr);
    return entry.version >= required;
  }

  /** List all currently loaded module names (for diagnostics). */
  list(): string[] {
    return [...new Set([...this.byName.values()].map(e => e.name))];
  }
}

/** Parse a RISC OS version string ("3.60", "0.21") to a float for comparison. */
function parseVersion(v: string): number {
  return parseFloat(v) || 0;
}

/** Extract the leaf filename from a RISC OS path ("System:Modules.CLib" → "CLib"). */
export function moduleLeafName(path: string): string {
  // "Prefix:Rest.Of.Path.Leaf" or "$.Dir.Leaf"
  const colon = path.indexOf(':');
  const rest  = colon >= 0 ? path.slice(colon + 1) : path;
  const dot   = rest.lastIndexOf('.');
  return dot >= 0 ? rest.slice(dot + 1) : rest;
}
