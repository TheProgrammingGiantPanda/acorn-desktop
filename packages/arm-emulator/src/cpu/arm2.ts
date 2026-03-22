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
import { Logger } from "@theprogramminggiantpanda/shared";

/**
 * Called after the ROM's SWI handler returns (MOVS PC, R14_svc or LDM^).
 * At this point registers reflect the state the ROM left them in.
 *
 * Return `false` to decline the firing — the hook stays in the stack and the
 * search continues.  This lets hooks tied to a specific task reject a return
 * that belongs to a different task running the same binary at the same logical
 * address (e.g. during cooperative task switching in Wimp_Poll).
 */
export type SwiReturnHook = (regs: RegisterFile, bus: SystemBus) => false | void;

/**
 * A SWI handler receives the live register file and system bus.
 * Returning `'passthrough'` causes the CPU to fall through to the ROM's own
 * SWI vector, which is useful when a handler wants to service only a subset
 * of calls (e.g. HostFS for "HostFS::" paths, ROM FileSwitch for everything else).
 * Returning `{ passthrough: true, afterReturn }` also passthroughs to ROM, and
 * additionally fires `afterReturn` once the ROM's SWI handler returns to its caller.
 */
export type SwiHandler = (regs: RegisterFile, bus: SystemBus) =>
  'passthrough' | { passthrough: true; afterReturn: SwiReturnHook } | void;

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
  halted = false;
  /** Set to true when an instruction explicitly writes the PC (branch/exception). */
  private pcExplicit = false;
  /** Total executed instruction count */
  cycleCount = 0;
  /** Pending IRQ/FIQ — set when interrupt fires while CPU has the mask bit set */
  private _irqPending = false;
  private _fiqPending = false;

  constructor(
    private readonly bus: SystemBus,
    readonly variant: CpuVariant = "ARM2",
    private readonly logger = new Logger()
  ) {}

  reset(): void {
    this.regs.reset(); // PC = 0, Supervisor mode, IRQ+FIQ disabled
    this.halted      = false;
    this.swiPending  = false;
    this.cycleCount  = 0;
    this._irqPending = false;
    this._fiqPending = false;
    this._swiSeen.clear();
  }

  /** Execute up to `count` instructions. Returns actual count executed. */
  step(count: number): number {
    let executed = 0;
    while (executed < count && !this.halted && !this.swiPending) {
      // Check for deferred interrupts at each instruction boundary
      if (this._fiqPending && !this.regs.fiqDisabled) {
        this._fiqPending = false;
        this.takeException(VECTOR_FIQ, Mode.FIQ);
      } else if (this._irqPending && !this.regs.irqDisabled) {
        this._irqPending = false;
        this.logger.debug(`[CPU] IRQ delivery at PC=0x${this.regs.pc.toString(16)} R15=0x${(this.regs.r15>>>0).toString(16).padStart(8,'0')}`);
        this.takeException(VECTOR_IRQ, Mode.IRQ);
      }
      this.executeOne();
      executed++;
      this.cycleCount++;
    }
    return executed;
  }

  private _visitedPCs = new Set<number>();
  private _moduleAreaWarned = false;
  private _warnSummary = '';
  private _pabortDebugged = false;

  private executeOne(): void {
    const instrAddr = this.regs.pc;

    // ARM 3-stage pipeline: R15 reads as instrAddr+8 during instruction execution.
    // Set this BEFORE the instruction fetch so that if readLogical aborts,
    // takeException(PABORT) saves the correct R14 = instrAddr+4 | PSR.
    this.regs.pc = (instrAddr + 8) & PC_MASK;
    this.pcExplicit = false;

    const instr = this.bus.read32(instrAddr);

    // Prefetch abort: instruction fetch from an unmapped logical address
    if (this.bus.readAborted) {
      this.logger.debug(`[CPU] PABORT at 0x${instrAddr.toString(16)} R15=0x${(this.regs.r15>>>0).toString(16).padStart(8,'0')}${this._warnSummary ? ` [NV-block: ${this._warnSummary}]` : ''}`);
      if (!this._pabortDebugged) {
        this._pabortDebugged = true;
        const regs = Array.from({length: 15}, (_, i) => `R${i}=0x${(this.regs.read(i)>>>0).toString(16)}`);
        this.logger.debug(`[CPU] PABORT first-hit: ${regs.join(' ')} R15=0x${(this.regs.r15>>>0).toString(16)}`);
        // eslint-disable-next-line no-debugger
        debugger; // inspect why CPU is fetching from unmapped logical address
      }
      this.takeException(VECTOR_PABORT, Mode.Supervisor);
      return;
    }

    // Log first visit to key ROM/exception addresses and each new 4KB page
    if (!this._visitedPCs.has(instrAddr)) {
      const page = instrAddr >>> 12;
      const isNewPage = !this._visitedPCs.has(page | 0x80000000);
      if (instrAddr <= 0x1C || instrAddr === 0x5C || instrAddr === 0x160C || isNewPage) {
        this._visitedPCs.add(instrAddr);
        this._visitedPCs.add(page | 0x80000000);
        this.logger.debug(`[CPU] new region addr=0x${instrAddr.toString(16)} instr=0x${(instr>>>0).toString(16).padStart(8,'0')} R15=0x${(this.regs.r15>>>0).toString(16).padStart(8,'0')}`);
      }
      // One-time full register dump at key diagnostic addresses
      if (instrAddr === 0x157C8) {
        const regs = Array.from({length: 15}, (_, i) => `R${i}=0x${(this.regs.read(i)>>>0).toString(16)}`);
        this.logger.debug(`[CPU] DIAG@0x157C8 R10-check: ${regs.join(' ')} R15=0x${(this.regs.r15>>>0).toString(16)}`);
      }
    }

    // One-shot note: first time an 0xffffffff is fetched (part of the ARM3 NV-skip block in ROM).
    // This is intentional — ARM2 silently skips NV-condition instructions.
    if ((instr >>> 0) === 0xffffffff && !this._moduleAreaWarned) {
      this._moduleAreaWarned = true;
      const regs = Array.from({length: 15}, (_, i) => `R${i}=0x${(this.regs.read(i)>>>0).toString(16)}`);
      this._warnSummary = `addr=0x${instrAddr.toString(16)} ${regs.join(' ')} R15=0x${(this.regs.r15>>>0).toString(16)}`;
      this.logger.debug(`[CPU] NOTE: entering ARM3 NV-skip block at ${this._warnSummary}`);
    }

    const cond = (instr >>> 28) & 0xF;
    if (!conditionMet(cond, this.regs)) {
      // Only advance PC normally if no exception was taken during the fetch
      // (e.g. a synchronous abort callback that fires inside bus.read32).
      if (!this.pcExplicit) this.regs.pc = (instrAddr + 4) & PC_MASK;
      return;
    }

    const bits27_26 = (instr >>> 26) & 0x3;
    const bits27_25 = (instr >>> 25) & 0x7;

    if (bits27_25 === 0b101) {
      this.execBranch(instr);
    } else if (bits27_26 === 0b11) {
      if (bits27_25 === 0b110) {
        // Coprocessor data transfer (LDC/STC) — NOP; no coprocessor memory DMA needed
      } else if ((instr >>> 24) & 1) {
        this.execSWI(instr);           // bits 27:24 = 1111 → SWI
      } else {
        this.execCoprocessor(instr);   // bits 27:24 = 1110 → MRC/MCR/CDP
      }
    } else if (bits27_26 === 0b00) {
      const bit25 = (instr >>> 25) & 1;
      const bit4  = (instr >>> 4) & 1;
      const bit7  = (instr >>> 7) & 1;
      if (!bit25 && bit7 && bit4 && ((instr >>> 22) & 0xF) === 0) {
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
      this.takeException(VECTOR_UNDEF, Mode.Supervisor);
    }

    // Only advance to the next instruction if nothing explicitly wrote the PC.
    if (!this.pcExplicit) {
      this.regs.pc = (instrAddr + 4) & PC_MASK;
    }

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

    if (S && Rd === 15) {
      // ARM2: S=1, Rd=15 behaviour depends on opcode class:
      //
      // writeResult=true  (MOV, ADD, SUB, ORR, AND, …):
      //   Full 32-bit result → R15.  This is the exception-return / PC+PSR branch path.
      //   MOVS PC, R14 uses this to restore both PC and saved PSR.
      //
      // writeResult=false (TST/TEQ/CMP/CMN — the "P-class" / PSR-transfer ops):
      //   TEQP/TSTP/CMPP/CMNP: only the PSR fields (flags + mode + IRQ/FIQ) of R15 are
      //   updated from the result.  The PC field is left unchanged so execution continues
      //   sequentially.  Writing the full result here would corrupt the PC.
      const curMode = this.regs.mode;
      const r15val  = result >>> 0;
      if (writeResult) {
        if (curMode === Mode.Supervisor) {
          this._fireSwiReturn(r15val & PC_MASK);
        }
        const newMode = r15val & 0x3;
        if (newMode !== curMode) {
          this.logger.debug(`[CPU] S=1 Rd=15 mode change ${curMode}→${newMode} at PC=0x${(this.regs.pc-8).toString(16)} result=0x${r15val.toString(16).padStart(8,'0')} Rn=${Rn} rnVal=0x${(rnVal>>>0).toString(16)} op2=0x${(op2>>>0).toString(16)}`);
        }
        this.regs.r15 = r15val;
        this.pcExplicit = true;
      } else {
        // PSR-transfer only: update non-PC fields of R15, keep PC advancing normally.
        this.regs.r15 = (this.regs.r15 & PC_MASK) | (r15val & ~PC_MASK);
        // pcExplicit stays false → normal PC += 4 advancement
      }
    } else if (S) {
      // Normal flag update (Rd != 15)
      this.regs.setNZ(result);
      if (opcode <= 1 || opcode === 0xC || opcode === 0xD || opcode === 0xE || opcode === 0xF || opcode === 8 || opcode === 9) {
        this.regs.C = shiftCarry;
        // V unchanged for logical ops
      }
      // ADD/ADC/CMN and SUB/SBC/RSB/RSC/CMP flags already set inside add32/sub32
      if (writeResult) this.regs.write(Rd, result);
    } else if (writeResult) {
      if (Rd === 15) {
        this.regs.r15 = result >>> 0;
        this.pcExplicit = true;
      } else {
        this.regs.write(Rd, result);
      }
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

    // ARM2: when R15 is base, use PC (address bits only), not the full R15+PSR word
    let base = (Rn === 15 ? this.regs.pc : this.regs.read(Rn)) >>> 0;
    const addr = P ? (U ? base + offset : base - offset) >>> 0 : base;

    if (L) {
      const val = B ? this.bus.read8(addr) : this.bus.read32(addr);
      if (this.bus.readAborted) {
        // Data abort: MEMC translation fault during LDR/LDRB.
        // R14_svc = instrAddr+8 | PSR (ARM26 spec); but since we already set
        // regs.pc = instrAddr+8, r15Before in takeException = instrAddr+8 | PSR,
        // and we subtract 4 giving instrAddr+4 | PSR. RISC OS data abort handlers
        // typically do not retry (SUBS PC, R14, #8) during boot, so this is
        // acceptable for now.
        this.takeException(VECTOR_DABORT, Mode.Supervisor);
        return;
      }
      if (Rd === 15) { this.regs.r15 = val >>> 0; this.pcExplicit = true; }
      else this.regs.write(Rd, val);
    } else {
      const val = this.regs.read(Rd) >>> 0;
      if (B) this.bus.write8(addr, val & 0xFF);
      else   this.bus.write32(addr, val);
    }

    if (!P || W) {
      // ARM2: in post-index LDR (P=0) when Rd == Rn, the loaded value wins
      // and the base-register write-back is suppressed (otherwise we'd overwrite
      // the just-loaded Rd with the original base address).
      if (L && !P && Rd === Rn) {
        // write-back suppressed; Rd already holds the loaded value
      } else {
        const wb = (U ? base + offset : base - offset) >>> 0;
        this.regs.write(Rn, wb);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Block data transfer (LDM / STM)
  // ---------------------------------------------------------------------------
  private execBlockTransfer(instr: number): void {
    const L    = (instr >>> 20) & 1;
    const W    = (instr >>> 21) & 1;
    const S    = (instr >>> 22) & 1; // user-mode registers / PSR restore
    const U    = (instr >>> 23) & 1; // 1=increment, 0=decrement
    const P    = (instr >>> 24) & 1; // 1=pre (before), 0=post (after)
    const Rn   = (instr >>> 16) & 0xF;
    const rlist = instr & 0xFFFF;

    const base  = this.regs.read(Rn) >>> 0;
    const count = popcount(rlist);

    // All four addressing modes (IA/IB/DA/DB) can be reduced to:
    // compute the lowest address used, then step upward by 4 per register.
    // Registers are always transferred in order from lowest to highest bit index.
    let lowestAddr: number;
    if (U) {
      lowestAddr = P ? (base + 4) >>> 0 : base; // IB / IA
    } else {
      lowestAddr = P ? (base - count * 4) >>> 0 : (base - count * 4 + 4) >>> 0; // DB / DA
    }

    let pos = 0;
    for (let i = 0; i < 16; i++) {
      if (!(rlist & (1 << i))) continue;
      const addr = (lowestAddr + pos * 4) >>> 0;
      if (L) {
        const val = this.bus.read32(addr);
        if (i === 15) { this.regs.r15 = val >>> 0; this.pcExplicit = true; }
        else           this.regs.write(i, val);
      } else {
        this.bus.write32(addr, this.regs.read(i));
      }
      pos++;
    }

    if (W) {
      const newBase = U ? (base + count * 4) >>> 0 : (base - count * 4) >>> 0;
      this.regs.write(Rn, newBase);
    }

    if (S && L && (rlist & 0x8000)) {
      // LDM^ with PC in list: ARM2 exception return.
      // The value already loaded into r15 from memory was saved from a full R15
      // (PC+PSR) at an earlier STMFD, so no additional PSR restore is needed.
      const curMode = this.regs.mode;
      if (curMode === Mode.Supervisor) this._fireSwiReturn(this.regs.r15 & PC_MASK);
    }
  }

  // ---------------------------------------------------------------------------
  // Branch (B / BL)
  // ---------------------------------------------------------------------------
  private execBranch(instr: number): void {
    const L    = (instr >>> 24) & 1;
    // 24-bit signed offset, shifted left 2, sign-extended from bit 25
    let offset = (instr & 0x00FF_FFFF) << 2;
    if (offset & 0x0200_0000) offset |= 0xFC00_0000;

    // this.regs.pc is instrAddr+8 (set by executeOne before dispatch)
    const pipelinePC = this.regs.pc;
    if (L) {
      // LR = address of instruction after the branch (instrAddr+4)
      this.regs.write(14, (pipelinePC - 4) | (this.regs.r15 & ~PC_MASK));
    }
    // Branch target = instrAddr+8 + offset (ARM spec: relative to pipeline PC)
    this.regs.pc = (pipelinePC + offset) & PC_MASK;
    this.pcExplicit = true;
  }

  // ---------------------------------------------------------------------------
  // Coprocessor (ARM3 CP15 — cache / CPU-ID)
  // ---------------------------------------------------------------------------
  /** ARM3 cache control register (CP15 C1): write-only in emulation, always reads 0. */
  private _cp15Control = 0;

  private execCoprocessor(instr: number): void {
    const cpNum = (instr >>> 8) & 0xF;
    const L     = (instr >>> 20) & 1; // 1 = MRC (read), 0 = MCR (write)
    const CRn   = (instr >>> 16) & 0xF;
    const Rd    = (instr >>> 12) & 0xF;

    if (cpNum !== 15) {
      // Unknown coprocessor — treat as undefined (take Undef exception)
      this.takeException(VECTOR_UNDEF, Mode.Supervisor);
      return;
    }

    if (L) {
      // MRC P15 — read a CP15 register into an ARM register
      let val = 0;
      switch (CRn) {
        case 0: val = 0x41560300; break; // CPU ID: ARM Ltd, ARMv2a, ARM3, step 0
        case 1: val = this._cp15Control; break;
        default: val = 0; break;
      }
      this.regs.write(Rd, val);
      this.logger.debug(`[CP15] MRC C${CRn} → R${Rd}=0x${val.toString(16)}`);
    } else {
      // MCR P15 — write ARM register to CP15 (cache flush / enable, etc.)
      const val = this.regs.read(Rd);
      if (CRn === 1) this._cp15Control = val;
      // Cache flush (C5/C6) and other writes are no-ops in emulation
      this.logger.debug(`[CP15] MCR C${CRn} ← R${Rd}=0x${val.toString(16)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // SWI dispatch
  // ---------------------------------------------------------------------------
  /**
   * Registered SWI handlers.  If a handler is present for a given SWI number
   * it is called instead of vectoring to the ROM exception handler.
   *
   * Handlers receive the current registers, may modify them (results go back
   * into the register file), and may be async – in which case they should
   * set `this.swiPending = true` and resolve via `resumeFromSWI()`.
   */
  readonly swiHandlers = new Map<number, SwiHandler>();

  /** True while waiting for an async SWI (e.g. Wimp_Poll) to complete */
  swiPending = false;

  /**
   * Stack of callbacks to fire when the ROM's SWI handler returns.
   * Pushed by handlers that return `{ passthrough: true, afterReturn }`;
   * popped and called when a PSR-restoring return is detected in Supervisor mode
   * WHOSE RETURN ADDRESS matches the address recorded when the hook was pushed.
   *
   * Each hook records the instruction address immediately after its SWI as the
   * "expected return address".  When a MOVS PC / LDM^ PSR-restore fires in
   * Supervisor mode, we search the stack for a hook whose expected return address
   * matches the value being written to PC (= R14_svc at that moment).  The
   * innermost matching hook fires.
   *
   * This is robust against ROM SWIs that do not return via a standard MOVS PC
   * (e.g. internal debug stubs, error-handler paths, OS_GenerateError), because
   * those never produce a return address that matches any JS-pushed hook.
   */
  private readonly _swiReturnStack: { hook: SwiReturnHook; returnAddr: number }[] = [];

  /** Set of SWI numbers already logged — each is logged only on its first call */
  private _swiSeen = new Set<number>();
  /** Total SWI call count — used to log first N calls for boot diagnostics */
  private _swiCallCount = 0;

  private execSWI(instr: number): void {
    const swiNum = instr & 0x00FF_FFFF;
    const handler = this.swiHandlers.get(swiNum);
    this._swiCallCount++;
    if (!this._swiSeen.has(swiNum) || this._swiCallCount <= 30) {
      this._swiSeen.add(swiNum);
      const tag = handler ? "→JS" : "→ROM";
      const instrPc = (this.regs.pc - 8) & 0x03FFFFFC;
      this.logger.debug(`[SWI #${this._swiCallCount}] 0x${swiNum.toString(16).padStart(6,'0')} ${tag} at 0x${instrPc.toString(16).padStart(7,'0')}`);
    }
    if (handler) {
      const result = handler(this.regs, this.bus);
      if (!result) return;
      if (result === 'passthrough') {
        this.takeException(VECTOR_SWI, Mode.Supervisor);
        return;
      }
      // { passthrough: true, afterReturn } — record return address, queue hook, vector to ROM.
      // Return address = instruction after the SWI = current pc (instrAddr+8) - 4 = instrAddr+4.
      const returnAddr = (this.regs.pc - 4) >>> 0;
      this._swiReturnStack.push({ hook: result.afterReturn, returnAddr });
      this.logger.debug(`[SWI] 0x${swiNum.toString(16).padStart(6,'0')} passthrough+hook returnAddr=0x${returnAddr.toString(16)} stackLen=${this._swiReturnStack.length}`);
      this.takeException(VECTOR_SWI, Mode.Supervisor);
      return;
    }
    // No JS handler — passthrough to ROM directly
    this.takeException(VECTOR_SWI, Mode.Supervisor);
  }

  /**
   * Check for a pending afterReturn hook whose expected return address matches
   * `returnAddr` (the value being written to PC by a MOVS PC / LDM^ in Supervisor
   * mode).  Searches innermost-first so reentrant SWIs at the same site work.
   */
  private _fireSwiReturn(returnAddr: number): void {
    for (let i = this._swiReturnStack.length - 1; i >= 0; i--) {
      const entry = this._swiReturnStack[i]!;
      if (entry.returnAddr === returnAddr) {
        const result = entry.hook(this.regs, this.bus);
        if (result !== false) {
          // Hook accepted — remove it and stop
          this._swiReturnStack.splice(i, 1);
          this.logger.debug(`[SWI] afterReturn fired returnAddr=0x${returnAddr.toString(16)} stackLen=${this._swiReturnStack.length}`);
          return;
        }
        // Hook declined (returned false) — leave it in the stack and keep
        // searching for another hook at the same address for a different task
      }
    }
  }

  /** Resume after an async SWI completes (called externally) */
  resumeFromSWI(): void {
    this.swiPending = false;
  }

  // ---------------------------------------------------------------------------
  // Exception handling
  // ---------------------------------------------------------------------------
  takeException(vector: number, newMode: Mode): void {
    // ARM2: R14 = old R15 − 4.  old R15 includes both PC (instrAddr+8) and PSR bits,
    // so R14 = instrAddr+4 | old_PSR.  This allows MOVS PC, R14 to restore both.
    const r15Before = this.regs.r15;
    const pcBefore  = r15Before & PC_MASK;
    this.regs.switchMode(newMode);
    this.regs.write(14, (r15Before - 4) >>> 0);
    this.regs.r15 = (this.regs.r15 & ~PC_MASK) | (vector & PC_MASK) | IRQ_MASK_BIT;
    if (newMode === Mode.FIQ) this.regs.r15 |= FIQ_MASK_BIT;
    this.pcExplicit = true;
    const vecInstr = this.bus.read32(vector);
    this.logger.debug(`[CPU] exception vector=0x${vector.toString(16)} mode=${newMode} from PC=0x${pcBefore.toString(16)} vec_instr=0x${(vecInstr>>>0).toString(16).padStart(8,'0')} R14=0x${(this.regs.read(14)>>>0).toString(16)}`);
  }

  triggerIRQ(): void {
    // Always queue the IRQ; step() takes the exception at the next
    // instruction boundary when the CPU's I-mask bit is clear.
    this._irqPending = true;
  }

  triggerFIQ(): void {
    this._fiqPending = true;
  }

  triggerDataAbort(): void {
    this.takeException(VECTOR_DABORT, Mode.Supervisor);
  }
}

function popcount(n: number): number {
  let c = 0;
  while (n) { c += n & 1; n >>>= 1; }
  return c;
}
