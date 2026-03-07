/**
 * RISC OS system variable store
 *
 * Variables are global key/value pairs accessible to programs and Obey scripts.
 * Names are case-insensitive. Three types are supported:
 *   string  — plain text value
 *   number  — stored as a decimal string
 *   macro   — value is expanded on read (contains <VarName> references)
 */

export type VarType = 'string' | 'number' | 'macro';

interface VarEntry {
  value: string;
  type:  VarType;
}

export class SystemVariables {
  private readonly store = new Map<string, VarEntry>();

  get(name: string): string | undefined {
    const entry = this.store.get(name.toUpperCase());
    if (!entry) return undefined;
    return entry.type === 'macro' ? this.substitute(entry.value) : entry.value;
  }

  set(name: string, value: string, type: VarType = 'string'): void {
    this.store.set(name.toUpperCase(), { value, type });
  }

  unset(name: string): void {
    this.store.delete(name.toUpperCase());
  }

  has(name: string): boolean {
    return this.store.has(name.toUpperCase());
  }

  /** Replace every <VarName> in str with the variable's current value. */
  substitute(str: string): string {
    return str.replace(/<([A-Za-z][A-Za-z0-9$_.]*?)>/g, (_match, name: string) => {
      return this.get(name) ?? '';
    });
  }
}
