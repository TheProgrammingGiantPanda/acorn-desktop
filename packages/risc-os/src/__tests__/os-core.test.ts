import { describe, it, expect, vi } from "vitest";
import { makeOSHandlers } from "../swi/os-core.js";
import { RegisterFile } from "@theprogramminggiantpanda/arm-emulator";
import type { ArchimedesMachine } from "@theprogramminggiantpanda/arm-emulator";

/** Minimal SystemBus for testing */
class MockBus {
  private mem = new Uint8Array(64 * 1024);
  read32(a: number) { return (this.mem[a]! | this.mem[a+1]! << 8 | this.mem[a+2]! << 16 | this.mem[a+3]! << 24) >>> 0; }
  write32(a: number, v: number) { this.mem[a]=v&0xFF; this.mem[a+1]=(v>>8)&0xFF; this.mem[a+2]=(v>>16)&0xFF; this.mem[a+3]=(v>>24)&0xFF; }
  read8(a: number) { return this.mem[a] ?? 0; }
  write8(a: number, v: number) { this.mem[a] = v & 0xFF; }
  writeString(a: number, s: string) { for (let i=0;i<s.length;i++) this.write8(a+i, s.charCodeAt(i)); this.write8(a+s.length, 0); }
}

function makeTestHandlers() {
  const output: string[] = [];
  const machine = { stop: vi.fn() } as unknown as ArchimedesMachine;
  const handlers = makeOSHandlers(machine, (text) => output.push(text));
  const regs = new RegisterFile();
  regs.reset();
  const bus = new MockBus();
  return { handlers, regs, bus, output, machine };
}

describe("OS_WriteC", () => {
  it("outputs the character in R0", () => {
    const { handlers, regs, bus, output } = makeTestHandlers();
    regs.write(0, 65); // 'A'
    handlers.OS_WriteC(regs, bus as never);
    expect(output).toEqual(["A"]);
  });

  it("only uses lower 8 bits of R0", () => {
    const { handlers, regs, bus, output } = makeTestHandlers();
    regs.write(0, 0xFFFF_0041); // low byte = 'A'
    handlers.OS_WriteC(regs, bus as never);
    expect(output).toEqual(["A"]);
  });
});

describe("OS_Write0", () => {
  it("outputs a null-terminated string from R0", () => {
    const { handlers, regs, bus, output } = makeTestHandlers();
    bus.writeString(0x100, "Hello");
    regs.write(0, 0x100);
    handlers.OS_Write0(regs, bus as never);
    expect(output).toEqual(["Hello"]);
  });

  it("outputs empty string for immediate null", () => {
    const { handlers, regs, bus, output } = makeTestHandlers();
    bus.write8(0x200, 0); // null terminator immediately
    regs.write(0, 0x200);
    handlers.OS_Write0(regs, bus as never);
    expect(output).toEqual([""]);
  });
});

describe("OS_NewLine", () => {
  it("outputs CR+LF", () => {
    const { handlers, regs, bus, output } = makeTestHandlers();
    handlers.OS_NewLine(regs, bus as never);
    expect(output).toEqual(["\r\n"]);
  });
});

describe("OS_Exit", () => {
  it("calls machine.stop()", () => {
    const { handlers, regs, bus, machine } = makeTestHandlers();
    handlers.OS_Exit(regs, bus as never);
    expect(machine.stop).toHaveBeenCalledOnce();
  });
});

describe("OS_GetEnv", () => {
  it("returns a RAM address in R0", () => {
    const { handlers, regs, bus } = makeTestHandlers();
    handlers.OS_GetEnv(regs, bus as never);
    expect(regs.read(0)).toBeGreaterThan(0); // some RAM address
  });

  it("returns a memory limit in R1 above 4MB", () => {
    const { handlers, regs, bus } = makeTestHandlers();
    handlers.OS_GetEnv(regs, bus as never);
    expect(regs.read(1)).toBeGreaterThan(4 * 1024 * 1024);
  });
});

describe("OS_Byte", () => {
  it("reason 0 returns RISC OS version (1)", () => {
    const { handlers, regs, bus } = makeTestHandlers();
    regs.write(0, 0);
    handlers.OS_Byte(regs, bus as never);
    expect(regs.read(0)).toBe(1);
  });

  it("reason 129 (read keyboard) sets no-key response", () => {
    const { handlers, regs, bus } = makeTestHandlers();
    regs.write(0, 129);
    handlers.OS_Byte(regs, bus as never);
    expect(regs.read(2)).toBe(1); // timeout
  });
});

describe("OS_ReadModeVar", () => {
  it("returns screen width (var 11) as 640", () => {
    const { handlers, regs, bus } = makeTestHandlers();
    regs.write(0, 27); regs.write(1, 11);
    handlers.OS_ReadModeVar(regs, bus as never);
    expect(regs.read(2)).toBe(640);
  });

  it("returns screen height (var 12) as 512", () => {
    const { handlers, regs, bus } = makeTestHandlers();
    regs.write(0, 27); regs.write(1, 12);
    handlers.OS_ReadModeVar(regs, bus as never);
    expect(regs.read(2)).toBe(512);
  });

  it("clears carry flag on valid variable", () => {
    const { handlers, regs, bus } = makeTestHandlers();
    regs.C = true;
    regs.write(0, 27); regs.write(1, 11);
    handlers.OS_ReadModeVar(regs, bus as never);
    expect(regs.C).toBe(false);
  });
});

describe("OS_Heap", () => {
  it("reason 0 initialises heap magic word", () => {
    const { handlers, regs, bus } = makeTestHandlers();
    const heapBase = 0x1000;
    regs.write(0, 0);       // initialise
    regs.write(1, heapBase);
    regs.write(3, 512);     // size
    handlers.OS_Heap(regs, bus as never);
    // 'Heap' magic = 0x70616548 ('H','e','a','p' in little-endian)
    expect(bus.read32(heapBase)).toBe(0x7061_6548);
  });

  it("reason 2 allocates a block and returns pointer", () => {
    const { handlers, regs, bus } = makeTestHandlers();
    const heapBase = 0x2000;
    // Initialise heap with 512 bytes
    regs.write(0, 0); regs.write(1, heapBase); regs.write(3, 512);
    handlers.OS_Heap(regs, bus as never);

    // Allocate 64 bytes
    regs.write(0, 2); regs.write(1, heapBase); regs.write(3, 64);
    handlers.OS_Heap(regs, bus as never);
    expect(regs.C).toBe(false); // success
    expect(regs.read(2)).toBeGreaterThan(heapBase); // pointer inside heap
  });
});
