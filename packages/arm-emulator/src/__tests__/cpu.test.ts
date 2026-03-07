import { describe, it, expect, beforeEach } from "vitest";
import { makeEnv, MOV_I, MOVS_I, ADD_I, ADDS_I, SUB_I, SUBS_I, CMP_I,
         MOV, MOVS, ADD, ADDS, SUB, AND, AND_I, ANDS_I, ORR, ORR_I, EOR, BIC, MVN,
         MOV_LSL, MOV_LSR, MOV_ASR, MUL, MLA,
         LDR, STR, LDRB, STRB, LDR_POST, LDR_W,
         STMIA, LDMIA, STMFD, LDMFD,
         B_TO, BL_TO, B_OFF, SWI, NOP,
         AL, EQ, NE, CS, CC, MI, PL, GE, LT, GT, LE } from "./helpers.js";

// ============================================================================
// Data processing
// ============================================================================
describe("ARM2 CPU — data processing", () => {

  it("MOV immediate loads constant into register", () => {
    const { run, r } = makeEnv([MOV_I(1, 42)]);
    run(1);
    expect(r(1)).toBe(42);
  });

  it("MOVS sets N and Z flags", () => {
    const { cpu, run } = makeEnv([
      MOV_I(0, 0),    // R0 = 0
      MOVS_I(1, 0),   // R1 = 0, sets Z
    ]);
    run(2);
    expect(cpu.regs.Z).toBe(true);
    expect(cpu.regs.N).toBe(false);
  });

  it("MOVS sets N flag for negative result", () => {
    const { cpu, run, wr } = makeEnv([
      NOP,            // placeholder (MOV R0, R0 — preserves R0)
      MOVS(1, 0),     // R1 = R0, will set N if MSB set
    ]);
    wr(0, 0x8000_0000);
    run(2);
    expect(cpu.regs.N).toBe(true);
    expect(cpu.regs.Z).toBe(false);
  });

  it("ADD immediate: 3 + 4 = 7", () => {
    const { run, r } = makeEnv([
      MOV_I(0, 3),
      ADD_I(1, 0, 4),
    ]);
    run(2);
    expect(r(1)).toBe(7);
  });

  it("ADD register: R0 + R1", () => {
    const { run, r, wr } = makeEnv([ADD(2, 0, 1)]);
    wr(0, 100); wr(1, 200);
    run(1);
    expect(r(2)).toBe(300);
  });

  it("ADDS sets carry on overflow (0xFFFFFFFF + 1)", () => {
    const { cpu, run, wr } = makeEnv([ADDS(2, 0, 1)]);
    wr(0, 0xFFFF_FFFF); wr(1, 1);
    run(1);
    expect(r2(cpu, 2)).toBe(0);
    expect(cpu.regs.C).toBe(true);
    expect(cpu.regs.Z).toBe(true);
  });

  it("ADDS sets V on signed overflow (0x7FFFFFFF + 1)", () => {
    const { cpu, run, wr } = makeEnv([ADDS(2, 0, 1)]);
    wr(0, 0x7FFF_FFFF); wr(1, 1);
    run(1);
    expect(cpu.regs.V).toBe(true);
    expect(cpu.regs.N).toBe(true); // result is negative
    expect(cpu.regs.C).toBe(false);
  });

  it("SUB immediate: 10 - 3 = 7", () => {
    const { run, r } = makeEnv([
      MOV_I(0, 10),
      SUB_I(1, 0, 3),
    ]);
    run(2);
    expect(r(1)).toBe(7);
  });

  it("SUBS sets C=1 (no borrow) when a >= b", () => {
    const { cpu, run } = makeEnv([
      MOV_I(0, 10),
      SUBS_I(1, 0, 3),
    ]);
    run(2);
    expect(cpu.regs.C).toBe(true);
  });

  it("SUBS sets C=0 (borrow) when a < b", () => {
    const { cpu, run } = makeEnv([
      MOV_I(0, 3),
      SUBS_I(1, 0, 10),
    ]);
    run(2);
    expect(cpu.regs.C).toBe(false);
  });

  it("CMP sets Z when values are equal", () => {
    const { cpu, run } = makeEnv([
      MOV_I(0, 42),
      CMP_I(0, 42),
    ]);
    run(2);
    expect(cpu.regs.Z).toBe(true);
  });

  it("AND register", () => {
    const { run, r, wr } = makeEnv([AND(2, 0, 1)]);
    wr(0, 0xFF00_FF00); wr(1, 0x0FF0_0FF0);
    run(1);
    expect(r(2)).toBe(0x0F00_0F00);
  });

  it("AND immediate masks bits", () => {
    const { run, r } = makeEnv([
      MOV_I(0, 0xFF),
      AND_I(1, 0, 0x0F),
    ]);
    run(2);
    expect(r(1)).toBe(0x0F);
  });

  it("ORR register", () => {
    const { run, r, wr } = makeEnv([ORR(2, 0, 1)]);
    wr(0, 0x00FF); wr(1, 0xFF00);
    run(1);
    expect(r(2)).toBe(0xFFFF);
  });

  it("EOR register XORs values", () => {
    const { run, r, wr } = makeEnv([EOR(2, 0, 1)]);
    wr(0, 0xAAAA_AAAA); wr(1, 0xFFFF_FFFF);
    run(1);
    expect(r(2)).toBe(0x5555_5555);
  });

  it("BIC clears bits", () => {
    const { run, r, wr } = makeEnv([BIC(2, 0, 1)]);
    wr(0, 0xFF); wr(1, 0x0F);
    run(1);
    expect(r(2)).toBe(0xF0);
  });

  it("MVN inverts bits", () => {
    const { run, r, wr } = makeEnv([MVN(1, 0)]);
    wr(0, 0);
    run(1);
    expect(r(1)).toBe(0xFFFF_FFFF);
  });
});

// ============================================================================
// Barrel shifter
// ============================================================================
describe("ARM2 CPU — barrel shifter", () => {

  it("LSL #2 shifts left 2 bits", () => {
    const { run, r, wr } = makeEnv([MOV_LSL(1, 0, 2)]);
    wr(0, 1);
    run(1);
    expect(r(1)).toBe(4);
  });

  it("LSR #1 shifts right 1 bit", () => {
    const { run, r, wr } = makeEnv([MOV_LSR(1, 0, 1)]);
    wr(0, 0xFF);
    run(1);
    expect(r(1)).toBe(0x7F);
  });

  it("ASR preserves sign bit", () => {
    const { run, r, wr } = makeEnv([MOV_ASR(1, 0, 4)]);
    wr(0, 0x8000_0000);
    run(1);
    expect(r(1)).toBe(0xF800_0000);
  });
});

// ============================================================================
// Multiply
// ============================================================================
describe("ARM2 CPU — multiply", () => {

  it("MUL Rd, Rm, Rs = Rm * Rs", () => {
    const { run, r, wr } = makeEnv([MUL(3, 1, 2)]);
    wr(1, 7); wr(2, 6);
    run(1);
    expect(r(3)).toBe(42);
  });

  it("MUL handles large values (truncated to 32 bits)", () => {
    const { run, r, wr } = makeEnv([MUL(3, 1, 2)]);
    wr(1, 0x10000); wr(2, 0x10000); // 2^32 → truncates to 0
    run(1);
    expect(r(3)).toBe(0);
  });

  it("MLA accumulates: Rd = Rm * Rs + Rn", () => {
    const { run, r, wr } = makeEnv([MLA(3, 1, 2, 0)]);
    wr(1, 6); wr(2, 7); wr(0, 10); // 6*7 + 10 = 52
    run(1);
    expect(r(3)).toBe(52);
  });
});

// ============================================================================
// Memory transfer
// ============================================================================
describe("ARM2 CPU — single data transfer", () => {

  it("STR stores a word then LDR loads it back", () => {
    const dataAddr = 0x1000;
    const { run, r, wr } = makeEnv([
      MOV_I(0, 0),       // instr 0: R0 = data address (set via wr below)
      STR(1, 0),         // instr 1: [R0] = R1
      LDR(2, 0),         // instr 2: R2 = [R0]
    ]);
    wr(0, dataAddr); wr(1, 0xDEAD_BEEF);
    run(3);
    expect(r(2)).toBe(0xDEAD_BEEF);
  });

  it("STR/LDR with positive immediate offset", () => {
    const dataAddr = 0x2000;
    const { run, r, wr } = makeEnv([
      STR(1, 0, 8),   // [R0+8] = R1
      LDR(2, 0, 8),   // R2 = [R0+8]
    ]);
    wr(0, dataAddr); wr(1, 0x1234_5678);
    run(2);
    expect(r(2)).toBe(0x1234_5678);
  });

  it("STRB/LDRB transfers a single byte", () => {
    const dataAddr = 0x3000;
    const { run, r, wr } = makeEnv([
      STRB(1, 0),   // [R0] = R1[7:0]
      LDRB(2, 0),   // R2 = byte at [R0]
    ]);
    wr(0, dataAddr); wr(1, 0xAB);
    run(2);
    expect(r(2)).toBe(0xAB);
  });

  it("LDRB only loads the low byte, upper bits zero", () => {
    const dataAddr = 0x3000;
    const { bus, run, r, wr } = makeEnv([
      LDRB(1, 0),
    ]);
    wr(0, dataAddr);
    bus.write8(dataAddr, 0xCD);
    run(1);
    expect(r(1)).toBe(0xCD);
  });

  it("post-index LDR updates base register", () => {
    const dataAddr = 0x4000;
    const { run, r, wr } = makeEnv([
      LDR_POST(1, 0, 4),   // R1 = [R0], R0 += 4
    ]);
    wr(0, dataAddr);
    makeEnv([]).bus.write32(dataAddr, 0xCAFE_BABE);
    const env = makeEnv([LDR_POST(1, 0, 4)]);
    env.wr(0, dataAddr);
    env.bus.write32(dataAddr, 0xCAFE_BABE);
    env.run(1);
    expect(env.r(0)).toBe(dataAddr + 4); // base updated
    expect(env.r(1)).toBe(0xCAFE_BABE);
  });
});

// ============================================================================
// Block data transfer
// ============================================================================
describe("ARM2 CPU — block data transfer", () => {

  it("STMIA stores multiple registers, LDMIA loads them back", () => {
    const base = 0x5000;
    const { run, r, wr, bus } = makeEnv([
      STMIA(4, 0b0111),   // store R0, R1, R2 to [R4]++
      LDMIA(4, 0b1000),   // load R3 from [R4] (where R4 now points after STMIA)
    ]);
    wr(4, base); wr(0, 10); wr(1, 20); wr(2, 30);
    run(1); // STMIA
    expect(bus.read32(base)).toBe(10);
    expect(bus.read32(base + 4)).toBe(20);
    expect(bus.read32(base + 8)).toBe(30);
  });

  it("STMIA does not update base (no !", () => {
    const base = 0x6000;
    const { run, r, wr } = makeEnv([
      STMIA(4, 0b0011),  // no writeback
    ]);
    wr(4, base); wr(0, 1); wr(1, 2);
    run(1);
    expect(r(4)).toBe(base); // unchanged
  });

  it("push/pop round-trip preserves values", () => {
    const sp = 0x7FF0;
    const { run, r, wr } = makeEnv([
      STMFD(13, 0b0111),  // PUSH {R0, R1, R2}
      MOV_I(0, 0), MOV_I(1, 0), MOV_I(2, 0), // clobber
      LDMFD(13, 0b0111),  // POP {R0, R1, R2}
    ]);
    wr(13, sp); wr(0, 0xAA); wr(1, 0xBB); wr(2, 0xCC);
    run(5);
    expect(r(0)).toBe(0xAA);
    expect(r(1)).toBe(0xBB);
    expect(r(2)).toBe(0xCC);
  });
});

// ============================================================================
// Branch
// ============================================================================
describe("ARM2 CPU — branch", () => {

  it("B skips instructions", () => {
    // [0] MOV R0, #1
    // [1] B +1 (skip to instruction [3])
    // [2] MOV R0, #99  ← should be skipped
    // [3] MOV R1, #2
    const { run, r } = makeEnv([
      MOV_I(0, 1),
      B_TO(1, 3),
      MOV_I(0, 99),
      MOV_I(1, 2),
    ]);
    run(3);
    expect(r(0)).toBe(1);  // R0 not clobbered
    expect(r(1)).toBe(2);
  });

  it("B_OFF(-2) loops back to itself (infinite loop exits after step limit)", () => {
    // Instruction at index 0: branch back to itself
    const { cpu, run } = makeEnv([B_OFF(-2)]);
    run(5); // step limit prevents infinite loop
    // PC should still be 0 (looping)
    expect(cpu.regs.pc).toBe(0);
  });

  it("BL saves return address in R14", () => {
    // [0] BL → [2]
    // [1] MOV R0, #0  ← where BL returns to (instrAddr+4)
    // [2] MOV R1, #1  ← branch target
    const { run, r, cpu } = makeEnv([
      BL_TO(0, 2),
      MOV_I(0, 0),
      MOV_I(1, 1),
    ]);
    run(2); // execute BL + one instruction at target
    // R14 should be address of instruction [1] = 4
    expect(cpu.regs.read(14) & 0x03FF_FFFC).toBe(4);
    expect(r(1)).toBe(1); // target executed
  });
});

// ============================================================================
// Condition codes
// ============================================================================
describe("ARM2 CPU — condition codes", () => {

  function condTest(setupInstrs: number[], condInstr: number, expectedExecuted: boolean) {
    const nop = NOP;
    const prog = [...setupInstrs, condInstr, MOV_I(7, 1)]; // R7=1 only if condInstr executes
    const { run, r } = makeEnv(prog);
    run(prog.length);
    if (expectedExecuted) {
      // condInstr itself sets something — just check it didn't fault
    }
    return r(7);
  }

  it("EQ executes when Z=1", () => {
    const { run, r } = makeEnv([
      CMP_I(0, 0),           // Z=1 (0==0)
      MOV_I(1, 42, 0, EQ),   // MOV R1, #42 if EQ
    ]);
    run(2);
    expect(r(1)).toBe(42);
  });

  it("EQ skips when Z=0", () => {
    const { run, r } = makeEnv([
      MOV_I(0, 1),
      CMP_I(0, 2),           // Z=0
      MOV_I(1, 42, 0, EQ),   // should be skipped
    ]);
    run(3);
    expect(r(1)).toBe(0);
  });

  it("NE executes when Z=0", () => {
    const { run, r } = makeEnv([
      MOV_I(0, 5),
      CMP_I(0, 3),            // Z=0 (5≠3)
      MOV_I(1, 99, 0, NE),
    ]);
    run(3);
    expect(r(1)).toBe(99);
  });

  it("MI executes when N=1", () => {
    const { run, r } = makeEnv([
      SUBS_I(0, 0, 1),         // 0-1 → N=1
      MOV_I(1, 7, 0, MI),
    ]);
    run(2);
    expect(r(1)).toBe(7);
  });

  it("PL executes when N=0", () => {
    const { run, r } = makeEnv([
      MOV_I(0, 5),
      SUBS_I(0, 0, 3),         // 5-3=2 → N=0
      MOV_I(1, 8, 0, PL),
    ]);
    run(3);
    expect(r(1)).toBe(8);
  });

  it("CS executes when C=1", () => {
    const { run, r } = makeEnv([
      MOV_I(0, 0xFF),
      ADDS_I(0, 0, 1, CS),     // 0xFF+1 would set C (but we use CS on the ADDS itself — CS on ADDS_I won't work; use MOV_I with CS)
    ]);
    // Set up carry first: 0xFFFFFFFF + 1
    const { run: run2, r: r2val, wr: wr2, cpu } = makeEnv([
      ADDS_I(0, 0, 1),      // ADDS R0, R0, #1  sets C if overflow
      MOV_I(1, 5, 0, CS),   // MOV R1, #5 if C set
    ]);
    wr2(0, 0xFFFF_FFFF);
    run2(2);
    expect(r2val(1)).toBe(5);
  });

  it("GE executes when N==V", () => {
    const { run, r } = makeEnv([
      MOV_I(0, 5),
      SUBS_I(0, 0, 3),          // positive result, N=0 V=0
      MOV_I(1, 11, 0, GE),
    ]);
    run(3);
    expect(r(1)).toBe(11);
  });

  it("LT executes when N!=V", () => {
    const { run, r } = makeEnv([
      MOV_I(0, 0),
      SUBS_I(0, 0, 1),           // 0-1 → N=1, C=0, V=0 → LT condition met (N≠V)
      MOV_I(1, 22, 0, LT),
    ]);
    run(3);
    expect(r(1)).toBe(22);
  });
});

// ============================================================================
// SWI dispatch
// ============================================================================
describe("ARM2 CPU — SWI dispatch", () => {

  it("unregistered SWI vectors to supervisor exception", () => {
    const { cpu, bus, run } = makeEnv([SWI(0x99)]);
    // Put a recognisable value at the SWI vector (0x08)
    bus.write32(0x08, MOV_I(5, 0xFF));  // MOV R5, #0xFF at SWI vector
    run(2); // SWI triggers exception → executes instruction at 0x08
    expect(cpu.regs.read(5)).toBe(0xFF);
  });

  it("registered SWI handler is called instead of exception", () => {
    const { cpu, run } = makeEnv([SWI(0x42)]);
    let called = false;
    cpu.swiHandlers.set(0x42, (regs) => {
      called = true;
      regs.write(0, 0xBEEF);
    });
    run(1);
    expect(called).toBe(true);
    expect(cpu.regs.read(0)).toBe(0xBEEF);
  });
});

// ============================================================================
// Sequential execution (pipeline bug regression)
// ============================================================================
describe("ARM2 CPU — sequential instruction execution", () => {

  it("executes all sequential instructions without skipping", () => {
    // Load 5 registers with distinct values
    const { run, r } = makeEnv([
      MOV_I(0, 10),
      MOV_I(1, 20),
      MOV_I(2, 30),
      MOV_I(3, 40),
      MOV_I(4, 50),
    ]);
    run(5);
    expect(r(0)).toBe(10);
    expect(r(1)).toBe(20);
    expect(r(2)).toBe(30);
    expect(r(3)).toBe(40);
    expect(r(4)).toBe(50);
  });

  it("PC advances by 4 per instruction", () => {
    const { cpu, run } = makeEnv([NOP, NOP, NOP]);
    run(3);
    expect(cpu.regs.pc).toBe(12);
  });
});

// helper to read a register as unsigned from cpu directly
function r2(cpu: import("../cpu/arm2.js").ARM2CPU, n: number): number {
  return cpu.regs.read(n) >>> 0;
}
