import { describe, it, expect, beforeEach, vi } from "vitest";
import { ObeyInterpreter } from "../obey/obey.js";
import { SystemVariables } from "../sysvar/sysvar.js";
import type { FileSystemHost, DirEntry, ObjectType } from "../fs/fs-host.js";

// ── Minimal FileSystemHost stub ──────────────────────────────────────────────

function makeFs(files: Record<string, string>): FileSystemHost {
  const encode = (s: string) => new TextEncoder().encode(s);
  return {
    resolvePath:    (p) => p,
    getCurrentDir:  () => "$",
    setCurrentDir:  () => {},
    readFile:       (p) => {
      const content = files[p];
      if (content === undefined) throw new Error(`Not found: ${p}`);
      return encode(content);
    },
    writeFile:      () => {},
    stat:           (p) => files[p] !== undefined ? { type: 1 as ObjectType, size: files[p]!.length, attrs: 3 } : null,
    deleteObject:   () => {},
    readDir:        () => ({ entries: [] as DirEntry[], nextOffset: -1 }),
    openFile:       () => 0,
    closeFile:      () => {},
    closeAll:       () => {},
    readByte:       () => ({ byte: 0, eof: true }),
    writeByte:      () => {},
    readBytes:      () => ({ data: new Uint8Array(0), remaining: 0 }),
    writeBytes:     () => {},
    getPointer:     () => 0,
    setPointer:     () => {},
    getExtent:      () => 0,
    setExtent:      () => {},
    flush:          () => {},
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ObeyInterpreter — system variables", () => {
  let sv:   SystemVariables;
  let obey: ObeyInterpreter;

  beforeEach(() => {
    sv   = new SystemVariables();
    obey = new ObeyInterpreter(undefined, sv);
  });

  it("Set stores a string variable", () => {
    obey.executeLine("Set Foo$Bar hello");
    expect(sv.get("Foo$Bar")).toBe("hello");
  });

  it("Set value can contain spaces", () => {
    obey.executeLine("Set My$Var hello world");
    expect(sv.get("My$Var")).toBe("hello world");
  });

  it("SetMacro stores a macro variable", () => {
    sv.set("Base$Dir", "$.Apps");
    obey.executeLine("SetMacro Paint$Dir <Base$Dir>.!Paint");
    // macro is expanded on read
    expect(sv.get("Paint$Dir")).toBe("$.Apps.!Paint");
  });

  it("Unset removes a variable", () => {
    sv.set("Foo$Bar", "x");
    obey.executeLine("Unset Foo$Bar");
    expect(sv.has("Foo$Bar")).toBe(false);
  });

  it("substitutes variables in the line before parsing", () => {
    sv.set("Obey$Dir", "$.Apps.!Paint");
    // After substitution: "Set Paint$Msg $.Apps.!Paint is running"
    obey.executeLine("Set Paint$Msg <Obey$Dir> is running");
    expect(sv.get("Paint$Msg")).toBe("$.Apps.!Paint is running");
  });

  it("comment lines are ignored", () => {
    obey.executeLine("| This is a comment");
    obey.executeLine("   | Indented comment");
    // No side effects expected — just no crash
  });

  it("empty lines are ignored", () => {
    obey.executeLine("");
    obey.executeLine("   ");
  });
});

describe("ObeyInterpreter — If/Then/Else", () => {
  let sv:   SystemVariables;
  let obey: ObeyInterpreter;

  beforeEach(() => {
    sv   = new SystemVariables();
    obey = new ObeyInterpreter(undefined, sv);
  });

  it("executes Then branch when condition is non-empty string", () => {
    sv.set("X", "yes");
    obey.executeLine('If "<X>" Then Set Result$Got then');
    expect(sv.get("Result$Got")).toBe("then");
  });

  it("executes Else branch when condition is empty string", () => {
    sv.set("X", "");
    obey.executeLine('If "<X>" Then Set R got-then Else Set R got-else');
    expect(sv.get("R")).toBe("got-else");
  });

  it("evaluates string equality", () => {
    obey.executeLine('If "hello" = "hello" Then Set Eq yes');
    expect(sv.get("Eq")).toBe("yes");
  });

  it("does not execute Then when equality is false", () => {
    obey.executeLine('If "hello" = "world" Then Set Eq yes');
    expect(sv.has("Eq")).toBe(false);
  });
});

describe("ObeyInterpreter — runFile", () => {
  let sv:      SystemVariables;
  let output:  string[];

  beforeEach(() => {
    sv     = new SystemVariables();
    output = [];
  });

  it("sets Obey$Dir to the directory of the file", () => {
    const fs = makeFs({
      "$.Apps.!Paint.!Run": "| !Run\nSet Paint$Dir <Obey$Dir>\n",
    });
    const obey = new ObeyInterpreter(fs, sv, { onOutput: (t) => output.push(t) });
    obey.runFile("$.Apps.!Paint.!Run");
    expect(sv.get("Paint$Dir")).toBe("$.Apps.!Paint");
  });

  it("restores Obey$Dir after the file finishes", () => {
    sv.set("Obey$Dir", "$.Previous");
    const fs = makeFs({
      "$.Apps.!Paint.!Run": "| !Run\n",
    });
    const obey = new ObeyInterpreter(fs, sv);
    obey.runFile("$.Apps.!Paint.!Run");
    expect(sv.get("Obey$Dir")).toBe("$.Previous");
  });

  it("executes Set commands in a file", () => {
    const fs = makeFs({
      "$.Foo.!Run": "| !Run\nSet App$Name MyApp\nSet App$Version 1.0\n",
    });
    const obey = new ObeyInterpreter(fs, sv);
    obey.runFile("$.Foo.!Run");
    expect(sv.get("App$Name")).toBe("MyApp");
    expect(sv.get("App$Version")).toBe("1.0");
  });

  it("calls onRunBinary when Run targets a non-Obey file", () => {
    const runBinary = vi.fn();
    const fs = makeFs({
      "$.Foo.!Run":      "| !Run\nRun <Obey$Dir>.!RunImage\n",
      // binary: starts with ARM instruction word (not '|' or known command)
      "$.Foo.!RunImage": "\xE3\xA0\x00\x00",
    });
    const obey = new ObeyInterpreter(fs, sv, { onRunBinary: runBinary });
    obey.runFile("$.Foo.!Run");
    expect(runBinary).toHaveBeenCalledWith("$.Foo.!RunImage");
  });

  it("recursively runs nested Obey files", () => {
    const fs = makeFs({
      "$.Main": "| main\nRun $.Sub\n",
      "$.Sub":  "| sub\nSet Ran$Sub yes\n",
    });
    const obey = new ObeyInterpreter(fs, sv);
    obey.runFile("$.Main");
    expect(sv.get("Ran$Sub")).toBe("yes");
  });

  it("outputs a message when the file cannot be read", () => {
    const fs = makeFs({});
    const obey = new ObeyInterpreter(fs, sv, { onOutput: (t) => output.push(t) });
    obey.runFile("$.Missing.!Run");
    expect(output.some(l => l.includes("cannot read"))).toBe(true);
  });
});

describe("ObeyInterpreter — RMEnsure fallback", () => {
  it("runs the fallback command when module is not loaded", () => {
    const sv   = new SystemVariables();
    const obey = new ObeyInterpreter(undefined, sv);
    obey.executeLine("RMEnsure SharedCLib 5.17 Set NeedSharedCLib yes");
    expect(sv.get("NeedSharedCLib")).toBe("yes");
  });
});

describe("ObeyInterpreter — Echo and Error", () => {
  it("Echo writes text to output", () => {
    const sv     = new SystemVariables();
    const output: string[] = [];
    const obey   = new ObeyInterpreter(undefined, sv, { onOutput: (t) => output.push(t) });
    obey.executeLine("Echo Hello from Obey");
    expect(output).toContain("Hello from Obey\r\n");
  });

  it("Error writes an error message to output", () => {
    const sv     = new SystemVariables();
    const output: string[] = [];
    const obey   = new ObeyInterpreter(undefined, sv, { onOutput: (t) => output.push(t) });
    obey.executeLine("Error 1 Something went wrong");
    expect(output.some(l => l.includes("Something went wrong"))).toBe(true);
  });
});
