/**
 * ARM2 / ARM3 CPU core
 *
 * Implements the ARMv2 instruction set as used in the Acorn Archimedes A-series.
 * ARM3 support adds a simple cache-flush coprocessor (CP15) but is otherwise
 * instruction-set compatible.
 *
 * Instruction classes (bits 27:26):
 *   00 – Data processing / PSR transfer / Multiply
 *   01 – Single data transfer (LDR/STR)
 *   10 – Block data transfer / Branch
 *   11 – Coprocessor / SWI
 */

import { RegisterFile, Mode, PC_MASK, IRQ_MASK_BIT, FIQ_MASK_BIT } from "./registers.js";
import type { SystemBus } from "../memory/bus.js";

/** Exception vector addresses (ARM2 standard) */
const VECTOR_RESET   = 0x00000000;
const VECTOR_UNDEF   = 0x00000004;
const VECTOR_SWI     = 0x00000008;
const VECTOR_PABORT  = 0x0000000C;
const VECTOR_DABORT  = 0x00000010;
const VECTOR_IRQ     = 0x00000018;
const VECTOR_FIQ     = 0x0000001C;

/** Condition code evaluation (bits 31:28 of instruction) */
function conditionMet(cond: number, regs: RegisterFile): boolean {
  const N = regs.N, Z = regs.Z, C = regs.C, V = regs.V;
  switch (cond) {
    case 0x0: return Z;                      // EQ
    case 0x1: return !Z;                     // NE
    case 0x2: return C;                      // CS/HS
    case 0x3: return !C;                     // CC/LO
    case 0x4: return N;                      // MI
    case 0x5: return !N;                     // PL
    case 0x6: return V;                      // VS
    case 0x7: return !V;                     // VC
    case 0x8: return C && !Z;               // HI
    case 0x9: return !C || Z;               // LS
    case 0xA: return N === V;               // GE
    case 0xB: return N !== V;               // LT
    case 0xC: return !Z && (N === V);       // GT
    case 0xD: return Z || (N !== V);        // LE
    case 0xE: return true;                  // AL
    default:  return false;                  // NV (never)
  }
}

/** Barrel-shifter output: [result, carryOut] */
function barrelShift(
  value: number,
  shiftType: number,
  shiftAmount: number,
  oldCarry: boolean
): [number, boolean] {
  if (shiftAmount === 0) return [value >>> 0, oldCarry];
  const v = value >>> 0;
  switch (shiftType) {
    case 0: { // LSL
      if (shiftAmount >= 32) return [0, shiftAmount === 32 ? !!(v & 1) : false];
      return [(v << shiftAmount) >>> 0, !!(v & (1 << (32 - shiftAmount)))];
    }
    case 1: { // LSR
      if (shiftAmount >= 32) return [0, shiftAmount === 32 ? !!(v & 0x8000_0000) : false];
      return [(v >>> shiftAmount) >>> 0, !!(v & (1 << (shiftAmount - 1)))];
    }
    case 2: { // ASR
      const s = Math.min(shiftAmount, 31);
      return [((v | 0) >> s) >>> 0, !!((v | 0) & (1 << (s - 1)))];
    }
    case 3: { // ROR
      const s = ((shiftAmount - 1) & 31) + 1;
      const result = ((v >>> s) | (v << (32 - s))) >>> 0;
      return [result, !!(v & (1 << (s - 1)))];
    }
    default: return [v, oldCarry];
  }
}

export type CpuVariant = "ARM2" | "ARM3";

export class ARM2CPU {
  readonly regs = new RegisterFile();
  private halted = false;
  /** Total executed instruction count */
  cycleCount = 0;

  constructor(
    private readonly bus: SystemBus,
    readonly variant: CpuVariant = "ARM2"
  ) {}

  reset(): void {
    this.regs.reset();
    this.halted = false;
    this.cycleCount = 0;
    // Jump through reset vector
    const vec = this.bus.read32(VECTOR_RESET);
    this.regs.pc = vec & PC_MASK;
  }

  /** Execute up to `count` instructions. Returns actual count executed. */
  step(count: number): number {
    let executed = 0;
    while (executed < count && !this.halted) {
      this.executeOne();
      executed++;
      this.cycleCount++;
    }
    return executed;
  }

  private executeOne(): void {
    const pc = this.regs.pc;
    const instr = this.bus.read32(pc);

    // Advance PC before execution (ARM pipeline: fetch+decode+execute)
    this.regs.advancePC();
    this.regs.advancePC(); // +8 total (two stages ahead)

    const cond = (instr >>> 28) & 0xF;
    if (!conditionMet(cond, this.regs)) {
      // Condition not met — back up the extra advance
      this.regs.pc = (pc + 4) & PC_MASK;
      return;
    }

    const bits27_26 = (instr >>> 26) & 0x3;
    const bits27_25 = (instr >>> 25) & 0x7;

    if (bits27_25 === 0b101) {
      this.execBranch(instr);
    } else if (bits27_26 === 0b11) {
      this.execSWI(instr);
    } else if (bits27_26 === 0b00) {
      const bit25 = (instr >>> 25) & 1;
      const bit4  = (instr >>> 4) & 1;
      const bit7  = (instr >>> 7) & 1;
      if (!bit25 && bit7 && bit4 && ((instr >>> 22) & 0xF) === 0) {
        // Multiply / Multiply-Accumulate
        this.execMultiply(instr);
      } else {
        this.execDataProcessing(instr);
      }
    } else if (bits27_26 === 0b01) {
      this.execSingleTransfer(instr);
    } else if (bits27_26 === 0b10) {
      if ((instr >>> 25) & 1) {
        this.execBranch(instr);
      } else {
        this.execBlockTransfer(instr);
      }
    } else {
      // Coprocessor / undefined
      this.takeException(VECTOR_UNDEF, Mode.Supervisor);
    }

    // Restore correct PC (we advanced by 8 for pipeline simulation; real PC tracks fetch)
    // The PC visible to instructions should be pc+8, which is what we set; correct to pc+4
    // after execution unless the instruction modified PC itself.
    // (Handled by each exec method writing r15 directly when needed)
  }

  // ---------------------------------------------------------------------------
  // Data processing
  // ---------------------------------------------------------------------------
  private execDataProcessing(instr: number): void {
    const opcode  = (instr >>> 21) & 0xF;
    const S       = (instr >>> 20) & 1;
    const Rn      = (instr >>> 16) & 0xF;
    const Rd      = (instr >>> 12) & 0xF;
    const bit25   = (instr >>> 25) & 1;

    const rnVal = this.regs.read(Rn);
    let op2: number;
    let shiftCarry = this.regs.C;

    if (bit25) {
      // Immediate operand with rotate
      const imm8  = instr & 0xFF;
      const rot   = ((instr >>> 8) & 0xF) * 2;
      op2 = ((imm8 >>> rot) | (imm8 << (32 - rot))) >>> 0;
    } else {
      // Register operand with shift
      const Rm       = instr & 0xF;
      const rmVal    = this.regs.read(Rm);
      const shiftType = (instr >>> 5) & 0x3;
      let shiftAmt: number;

      if ((instr >>> 4) & 1) {
        // Shift by register
        const Rs = (instr >>> 8) & 0xF;
        shiftAmt = this.regs.read(Rs) & 0xFF;
      } else {
        shiftAmt = (instr >>> 7) & 0x1F;
      }
      [op2, shiftCarry] = barrelShift(rmVal, shiftType, shiftAmt, this.regs.C);
    }

    let result = 0;
    let writeResult = true;
    const carry = this.regs.C ? 1 : 0;

    switch (opcode) {
      case 0x0: result = (rnVal & op2) >>> 0; break;                         // AND
      case 0x1: result = (rnVal ^ op2) >>> 0; break;                         // EOR
      case 0x2: result = this.sub32(rnVal, op2); break;                      // SUB
      case 0x3: result = this.sub32(op2, rnVal); break;                      // RSB
      case 0x4: result = this.add32(rnVal, op2); break;                      // ADD
      case 0x5: result = this.add32(rnVal, op2 + carry); break;              // ADC
      case 0x6: result = this.sub32(rnVal, op2 - carry + 1); break;          // SBC
      case 0x7: result = this.sub32(op2, rnVal - carry + 1); break;          // RSC
      case 0x8: result = (rnVal & op2) >>> 0; writeResult = false; break;    // TST
      case 0x9: result = (rnVal ^ op2) >>> 0; writeResult = false; break;    // TEQ
      case 0xA: result = this.sub32(rnVal, op2); writeResult = false; break; // CMP
      case 0xB: result = this.add32(rnVal, op2); writeResult = false; break; // CMN
      case 0xC: result = (rnVal | op2) >>> 0; break;                         // ORR
      case 0xD: result = op2 >>> 0; break;                                   // MOV
      case 0xE: result = (rnVal & ~op2) >>> 0; break;                        // BIC
      case 0xF: result = (~op2) >>> 0; break;                                // MVN
    }

    if (S) {
      if (Rd === 15) {
        // S + Rd=15: restore PSR from SPSR
        this.regs.restorePSR(this.regs.mode);
      } else {
        // Set flags from result
        this.regs.setNZ(result);
        if (opcode <= 1 || opcode === 0xC || opcode === 0xD || opcode === 0xE || opcode === 0xF || opcode === 8 || opcode === 9) {
          this.regs.C = shiftCarry;
          // V unchanged for logical ops
        }
        // ADD/ADC/CMN set C and V based on add32; SUB/SBC/RSB/RSC/CMP set from sub32
        // (Already set inside add32/sub32 helpers)
      }
    }

    if (writeResult && Rd !== 15) {
      this.regs.write(Rd, result);
    } else if (writeResult && Rd === 15) {
      this.regs.r15 = result >>> 0;
    }
  }

  /** 32-bit addition; sets C (carry) and V (overflow) flags */
  private add32(a: number, b: number): number {
    const ua = a >>> 0, ub = b >>> 0;
    const result = (ua + ub) >>> 0;
    this.regs.C = result < ua;
    const sa = (a | 0), sb = (b | 0), sr = (result | 0);
    this.regs.V = (sa > 0 && sb > 0 && sr < 0) || (sa < 0 && sb < 0 && sr > 0);
    return result;
  }

  /** 32-bit subtraction (a - b); sets C (borrow inverted) and V flags */
  private sub32(a: number, b: number): number {
    const ua = a >>> 0, ub = b >>> 0;
    const result = (ua - ub) >>> 0;
    this.regs.C = ua >= ub; // ARM: C=1 means no borrow
    const sa = (a | 0), sb = (b | 0), sr = (result | 0);
    this.regs.V = (sa > 0 && sb < 0 && sr < 0) || (sa < 0 && sb > 0 && sr > 0);
    return result;
  }

  // ---------------------------------------------------------------------------
  // Multiply
  // ---------------------------------------------------------------------------
  private execMultiply(instr: number): void {
    const A  = (instr >>> 21) & 1;
    const S  = (instr >>> 20) & 1;
    const Rd = (instr >>> 16) & 0xF;
    const Rn = (instr >>> 12) & 0xF;
    const Rs = (instr >>> 8)  & 0xF;
    const Rm = instr & 0xF;

    let result = Math.imul(this.regs.read(Rm), this.regs.read(Rs));
    if (A) result = (result + this.regs.read(Rn)) | 0;

    this.regs.write(Rd, result >>> 0);
    if (S) this.regs.setNZ(result);
  }

  // ---------------------------------------------------------------------------
  // Single data transfer (LDR / STR)
  // ---------------------------------------------------------------------------
  private execSingleTransfer(instr: number): void {
    const L    = (instr >>> 20) & 1; // 1=load
    const W    = (instr >>> 21) & 1; // write-back
    const B    = (instr >>> 22) & 1; // 1=byte
    const U    = (instr >>> 23) & 1; // 1=add offset
    const P    = (instr >>> 24) & 1; // 1=pre-index
    const I    = (instr >>> 25) & 1; // 1=register offset
    const Rn   = (instr >>> 16) & 0xF;
    const Rd   = (instr >>> 12) & 0xF;

    let offset: number;
    if (I) {
      const Rm       = instr & 0xF;
      const shiftType = (instr >>> 5) & 3;
      const shiftAmt  = (instr >>> 7) & 0x1F;
      [offset] = barrelShift(this.regs.read(Rm), shiftType, shiftAmt, this.regs.C);
    } else {
      offset = instr & 0xFFF;
    }

    let base = this.regs.read(Rn) >>> 0;
    const addr = P ? (U ? base + offset : base - offset) >>> 0 : base;

    if (L) {
      const val = B ? this.bus.read8(addr) : this.bus.read32(addr);
      if (Rd === 15) this.regs.r15 = val >>> 0;
      else this.regs.write(Rd, val);
    } else {
      const val = this.regs.read(Rd) >>> 0;
      if (B) this.bus.write8(addr, val & 0xFF);
      else   this.bus.write32(addr, val);
    }

    if (!P || W) {
      const wb = (U ? base + offset : base - offset) >>> 0;
      this.regs.write(Rn, wb);
    }
  }

  // ---------------------------------------------------------------------------
  // Block data transfer (LDM / STM)
  // ---------------------------------------------------------------------------
  private execBlockTransfer(instr: number): void {
    const L    = (instr >>> 20) & 1;
    const W    = (instr >>> 21) & 1;
    const S    = (instr >>> 22) & 1; // user-mode registers / PSR restore
    const U    = (instr >>> 23) & 1; // 1=increment
    const P    = (instr >>> 24) & 1; // 1=pre
    const Rn   = (instr >>> 16) & 0xF;
    const rlist = instr & 0xFFFF;

    let base = this.regs.read(Rn) >>> 0;
    const count = popcount(rlist);
    const start = U ? base : (base - count * 4) >>> 0;

    let addr = start;
    if (!U) addr = (base - count * 4) >>> 0;

    for (let i = 0; i < 16; i++) {
      if (!(rlist & (1 << i))) continue;
      const effective = P ? (addr + (U ? 0 : 4)) >>> 0 : addr;

      if (L) {
        const val = this.bus.read32(effective);
        if (i === 15) this.regs.r15 = val >>> 0;
        else           this.regs.write(i, val);
      } else {
        this.bus.write32(effective, this.regs.read(i));
      }
      addr = (addr + (U ? 4 : -4)) >>> 0;
    }

    if (W) {
      const newBase = U ? (base + count * 4) >>> 0 : (base - count * 4) >>> 0;
      this.regs.write(Rn, newBase);
    }

    if (S && L && (rlist & 0x8000)) {
      this.regs.restorePSR(this.regs.mode);
    }
  }

  // ---------------------------------------------------------------------------
  // Branch (B / BL)
  // ---------------------------------------------------------------------------
  private execBranch(instr: number): void {
    const L    = (instr >>> 24) & 1;
    // 24-bit signed offset, shifted left 2
    let offset = (instr & 0x00FF_FFFF) << 2;
    // Sign-extend from bit 25
    if (offset & 0x0200_0000) offset |= 0xFC00_0000;

    const pc = this.regs.pc; // already at PC+8 (pipeline)
    if (L) {
      // Save return address (PC+4 from instruction) into R14
      this.regs.write(14, (pc - 4) | (this.regs.r15 & ~PC_MASK));
    }
    this.regs.pc = ((pc - 8) + 8 + offset) & PC_MASK; // relative to instr+8
  }

  // ---------------------------------------------------------------------------
  // SWI
  // ---------------------------------------------------------------------------
  private execSWI(_instr: number): void {
    this.takeException(VECTOR_SWI, Mode.Supervisor);
  }

  // ---------------------------------------------------------------------------
  // Exception handling
  // ---------------------------------------------------------------------------
  takeException(vector: number, newMode: Mode): void {
    const retAddr = (this.regs.pc - 4) >>> 0;
    this.regs.savePSR(newMode);
    this.regs.switchMode(newMode);
    this.regs.write(14, retAddr);
    this.regs.r15 = (this.regs.r15 & ~PC_MASK) | (vector & PC_MASK) | IRQ_MASK_BIT;
    if (newMode === Mode.FIQ) this.regs.r15 |= FIQ_MASK_BIT;
  }

  triggerIRQ(): void {
    if (!this.regs.irqDisabled) {
      this.takeException(VECTOR_IRQ, Mode.IRQ);
    }
  }

  triggerFIQ(): void {
    if (!this.regs.fiqDisabled) {
      this.takeException(VECTOR_FIQ, Mode.FIQ);
    }
  }
}

function popcount(n: number): number {
  let c = 0;
  while (n) { c += n & 1; n >>>= 1; }
  return c;
}
