/**
 * ARM instruction encoding helpers for tests.
 *
 * ARM32 instruction format (simplified):
 *   bits 31:28 = condition
 *   bits 27:26 = instruction class
 *   ...
 *
 * All helpers default to AL (always) condition = 0xE.
 */

import { ARM2CPU } from "../cpu/arm2.js";
import type { SystemBus } from "../memory/bus.js";

// ---------------------------------------------------------------------------
// Condition codes
// ---------------------------------------------------------------------------
export const AL = 0xE000_0000; // always
export const EQ = 0x0000_0000; // equal (Z=1)
export const NE = 0x1000_0000; // not equal (Z=0)
export const CS = 0x2000_0000; // carry set
export const CC = 0x3000_0000; // carry clear
export const MI = 0x4000_0000; // minus (N=1)
export const PL = 0x5000_0000; // plus (N=0)
export const VS = 0x6000_0000; // overflow
export const VC = 0x7000_0000; // no overflow
export const HI = 0x8000_0000; // unsigned higher
export const LS = 0x9000_0000; // unsigned lower or same
export const GE = 0xA000_0000; // signed >=
export const LT = 0xB000_0000; // signed <
export const GT = 0xC000_0000; // signed >
export const LE = 0xD000_0000; // signed <=
export const NV = 0xF000_0000; // never

// ---------------------------------------------------------------------------
// Data processing instructions
// ---------------------------------------------------------------------------
const DP = (cond: number, I: number, op: number, S: number, Rn: number, Rd: number, op2: number) =>
  (cond | (I << 25) | (op << 21) | (S << 20) | (Rn << 16) | (Rd << 12) | op2) >>> 0;

export const AND  = (Rd: number, Rn: number, Rm: number, cond = AL) => DP(cond, 0, 0x0, 0, Rn, Rd, Rm);
export const ANDS = (Rd: number, Rn: number, Rm: number, cond = AL) => DP(cond, 0, 0x0, 1, Rn, Rd, Rm);
export const EOR  = (Rd: number, Rn: number, Rm: number, cond = AL) => DP(cond, 0, 0x1, 0, Rn, Rd, Rm);
export const SUB  = (Rd: number, Rn: number, Rm: number, cond = AL) => DP(cond, 0, 0x2, 0, Rn, Rd, Rm);
export const ADD  = (Rd: number, Rn: number, Rm: number, cond = AL) => DP(cond, 0, 0x4, 0, Rn, Rd, Rm);
export const ADDS = (Rd: number, Rn: number, Rm: number, cond = AL) => DP(cond, 0, 0x4, 1, Rn, Rd, Rm);
export const ORR  = (Rd: number, Rn: number, Rm: number, cond = AL) => DP(cond, 0, 0xC, 0, Rn, Rd, Rm);
export const MOV  = (Rd: number, Rm: number,             cond = AL) => DP(cond, 0, 0xD, 0,  0, Rd, Rm);
export const MOVS = (Rd: number, Rm: number,             cond = AL) => DP(cond, 0, 0xD, 1,  0, Rd, Rm);
export const BIC  = (Rd: number, Rn: number, Rm: number, cond = AL) => DP(cond, 0, 0xE, 0, Rn, Rd, Rm);
export const MVN  = (Rd: number, Rm: number,             cond = AL) => DP(cond, 0, 0xF, 0,  0, Rd, Rm);

// Immediate variants (I=1, op2 = rotate:4 | imm8:8)
export const MOV_I  = (Rd: number, imm: number, rot = 0, cond = AL) => DP(cond, 1, 0xD, 0,  0, Rd, ((rot/2) << 8) | (imm & 0xFF));
export const MOVS_I = (Rd: number, imm: number, rot = 0, cond = AL) => DP(cond, 1, 0xD, 1,  0, Rd, ((rot/2) << 8) | (imm & 0xFF));
export const ADD_I  = (Rd: number, Rn: number, imm: number, cond = AL) => DP(cond, 1, 0x4, 0, Rn, Rd, imm & 0xFF);
export const ADDS_I = (Rd: number, Rn: number, imm: number, cond = AL) => DP(cond, 1, 0x4, 1, Rn, Rd, imm & 0xFF);
export const SUB_I  = (Rd: number, Rn: number, imm: number, cond = AL) => DP(cond, 1, 0x2, 0, Rn, Rd, imm & 0xFF);
export const SUBS_I = (Rd: number, Rn: number, imm: number, cond = AL) => DP(cond, 1, 0x2, 1, Rn, Rd, imm & 0xFF);
export const CMP_I  = (Rn: number, imm: number,             cond = AL) => DP(cond, 1, 0xA, 1, Rn,  0, imm & 0xFF);
export const AND_I  = (Rd: number, Rn: number, imm: number, cond = AL) => DP(cond, 1, 0x0, 0, Rn, Rd, imm & 0xFF);
export const ORR_I  = (Rd: number, Rn: number, imm: number, cond = AL) => DP(cond, 1, 0xC, 0, Rn, Rd, imm & 0xFF);
export const ANDS_I = (Rd: number, Rn: number, imm: number, cond = AL) => DP(cond, 1, 0x0, 1, Rn, Rd, imm & 0xFF);

// LSL immediate: MOV Rd, Rm, LSL #amt
export const MOV_LSL = (Rd: number, Rm: number, amt: number, cond = AL) =>
  DP(cond, 0, 0xD, 0, 0, Rd, (amt << 7) | (0 << 5) | Rm);

// LSR immediate: MOV Rd, Rm, LSR #amt
export const MOV_LSR = (Rd: number, Rm: number, amt: number, cond = AL) =>
  DP(cond, 0, 0xD, 0, 0, Rd, (amt << 7) | (1 << 5) | Rm);

// ASR immediate
export const MOV_ASR = (Rd: number, Rm: number, amt: number, cond = AL) =>
  DP(cond, 0, 0xD, 0, 0, Rd, (amt << 7) | (2 << 5) | Rm);

// ---------------------------------------------------------------------------
// Multiply: MUL Rd, Rm, Rs
// ---------------------------------------------------------------------------
export const MUL = (Rd: number, Rm: number, Rs: number) =>
  (0xE000_0090 | (Rd << 16) | (Rs << 8) | Rm) >>> 0;

export const MLA = (Rd: number, Rm: number, Rs: number, Rn: number) =>
  (0xE020_0090 | (Rd << 16) | (Rn << 12) | (Rs << 8) | Rm) >>> 0;

// ---------------------------------------------------------------------------
// Memory: LDR / STR / LDRB / STRB
// ---------------------------------------------------------------------------
export const LDR   = (Rd: number, Rn: number, imm = 0) => (0xE590_0000 | (Rn << 16) | (Rd << 12) | (imm & 0xFFF)) >>> 0;
export const STR   = (Rd: number, Rn: number, imm = 0) => (0xE580_0000 | (Rn << 16) | (Rd << 12) | (imm & 0xFFF)) >>> 0;
export const LDRB  = (Rd: number, Rn: number, imm = 0) => (0xE5D0_0000 | (Rn << 16) | (Rd << 12) | (imm & 0xFFF)) >>> 0;
export const STRB  = (Rd: number, Rn: number, imm = 0) => (0xE5C0_0000 | (Rn << 16) | (Rd << 12) | (imm & 0xFFF)) >>> 0;
// Pre-index with writeback: LDR Rd, [Rn, #imm]!
export const LDR_W = (Rd: number, Rn: number, imm = 0) => (0xE5B0_0000 | (Rn << 16) | (Rd << 12) | (imm & 0xFFF)) >>> 0;
// Post-index: LDR Rd, [Rn], #imm
export const LDR_POST = (Rd: number, Rn: number, imm = 0) => (0xE490_0000 | (Rn << 16) | (Rd << 12) | (imm & 0xFFF)) >>> 0;

// ---------------------------------------------------------------------------
// Block transfer: STMIA / LDMIA / STMFD / LDMFD
// ---------------------------------------------------------------------------
export const STMIA = (Rn: number, reglist: number) => (0xE880_0000 | (Rn << 16) | reglist) >>> 0;
export const LDMIA = (Rn: number, reglist: number) => (0xE890_0000 | (Rn << 16) | reglist) >>> 0;
export const STMFD = (Rn: number, reglist: number) => (0xE920_0000 | (Rn << 16) | reglist) >>> 0; // push
export const LDMFD = (Rn: number, reglist: number) => (0xE8B0_0000 | (Rn << 16) | reglist) >>> 0; // pop

// ---------------------------------------------------------------------------
// Branch: B / BL
// Offset is in words, relative to the instruction (encoded as instrAddr+8 based)
// encOffset = (target - instrAddr - 8) / 4
// ---------------------------------------------------------------------------
export const B_OFF  = (encOffset: number) => (0xEA00_0000 | (encOffset & 0x00FF_FFFF)) >>> 0;
export const BL_OFF = (encOffset: number) => (0xEB00_0000 | (encOffset & 0x00FF_FFFF)) >>> 0;

/** B to instruction at `targetIdx` from instruction at `fromIdx` (0-based indices) */
export const B_TO = (fromIdx: number, targetIdx: number) =>
  B_OFF(targetIdx - fromIdx - 2);

export const BL_TO = (fromIdx: number, targetIdx: number) =>
  BL_OFF(targetIdx - fromIdx - 2);

// ---------------------------------------------------------------------------
// SWI
// ---------------------------------------------------------------------------
export const SWI = (num: number) => (0xEF00_0000 | (num & 0x00FF_FFFF)) >>> 0;

// NOP = MOV R0, R0
export const NOP = MOV(0, 0);

// ---------------------------------------------------------------------------
// Minimal bus implementation for tests
// ---------------------------------------------------------------------------
export class TestBus {
  readonly mem: Uint8Array;

  constructor(sizeBytes = 256 * 1024) {
    this.mem = new Uint8Array(sizeBytes);
  }

  read32(addr: number): number {
    const a = (addr & ~3) >>> 0;
    if (a + 3 >= this.mem.length) return 0;
    return (this.mem[a]! | (this.mem[a+1]! << 8) | (this.mem[a+2]! << 16) | (this.mem[a+3]! << 24)) >>> 0;
  }

  write32(addr: number, val: number): void {
    const a = (addr & ~3) >>> 0;
    if (a + 3 >= this.mem.length) return;
    this.mem[a]   =  val        & 0xFF;
    this.mem[a+1] = (val >>> 8) & 0xFF;
    this.mem[a+2] = (val >>> 16) & 0xFF;
    this.mem[a+3] = (val >>> 24) & 0xFF;
  }

  read8(addr: number): number {
    return addr < this.mem.length ? (this.mem[addr] ?? 0) : 0;
  }

  write8(addr: number, val: number): void {
    if (addr < this.mem.length) this.mem[addr] = val & 0xFF;
  }

  /** Load an instruction array at a byte address */
  load(instructions: number[], atAddr = 0): void {
    for (let i = 0; i < instructions.length; i++) {
      this.write32(atAddr + i * 4, instructions[i]!);
    }
  }
}

// ---------------------------------------------------------------------------
// Test CPU factory
// ---------------------------------------------------------------------------
export interface TestEnv {
  cpu: ARM2CPU;
  bus: TestBus;
  /** Run `n` instructions, return final PC */
  run: (n: number) => number;
  /** Read register */
  r: (n: number) => number;
  /** Write register */
  wr: (n: number, v: number) => void;
}

export function makeEnv(program: number[], startAddr = 0): TestEnv {
  const bus = new TestBus();
  bus.load(program, startAddr);
  const cpu = new ARM2CPU(bus as unknown as import("../memory/bus.js").SystemBus);
  cpu.regs.reset();
  cpu.regs.pc = startAddr;
  return {
    cpu, bus,
    run:  (n) => { cpu.step(n); return cpu.regs.pc; },
    r:    (n) => cpu.regs.read(n) >>> 0,
    wr:   (n, v) => cpu.regs.write(n, v),
  };
}
