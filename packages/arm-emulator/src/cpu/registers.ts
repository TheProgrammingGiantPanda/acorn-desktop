/**
 * ARM2/ARM3 register file
 *
 * ARM2 has 27 registers total but only 16 visible at a time depending on mode.
 * Banked registers exist for FIQ, IRQ and Supervisor modes.
 *
 * In ARM2, R15 (PC) also encodes the PSR (status flags + mode + IRQ/FIQ mask).
 * ARM3 adds a separate CPSR/SPSR but we keep the R15-as-PSR model here for ARM2
 * and alias CPSR onto it for ARM3 compatibility.
 */

/** Processor operating modes (bits 1:0 of R15 in ARM2) */
export const enum Mode {
  User       = 0b00,
  FIQ        = 0b01,
  IRQ        = 0b10,
  Supervisor = 0b11,
}

/** Bit positions within R15 (ARM2 combined PC/PSR) */
export const PC_MASK      = 0x03FF_FFFC; // bits 25:2  (word-aligned PC)
export const MODE_MASK    = 0x0000_0003; // bits 1:0   (processor mode)
export const IRQ_MASK_BIT = 0x0800_0000; // bit 27     (IRQ disable)
export const FIQ_MASK_BIT = 0x0400_0000; // bit 26     (FIQ disable)
export const FLAG_V       = 0x1000_0000; // bit 28     (overflow)
export const FLAG_C       = 0x2000_0000; // bit 29     (carry)
export const FLAG_Z       = 0x4000_0000; // bit 30     (zero)
export const FLAG_N       = 0x8000_0000; // bit 31     (negative)

export class RegisterFile {
  /** User/System mode registers R0-R14 */
  private usr = new Int32Array(15);

  /** FIQ banked R8-R14 (fiq[0]=R8_fiq … fiq[6]=R14_fiq) */
  private fiq = new Int32Array(7);

  /** IRQ banked R13-R14 */
  private irq = new Int32Array(2);

  /** Supervisor banked R13-R14 */
  private svc = new Int32Array(2);

  /** R15: combined PC and PSR for ARM2.  Bits 25:2 = PC, bits 31:26 = flags/masks, bits 1:0 = mode */
  r15 = 0;

  /** ARM3 SPSR banked per mode (saved PSR on exception entry) */
  private spsr: Record<Mode, number> = {
    [Mode.FIQ]:        0,
    [Mode.IRQ]:        0,
    [Mode.Supervisor]: 0,
    [Mode.User]:       0,
  };

  get mode(): Mode {
    return (this.r15 & MODE_MASK) as Mode;
  }

  /** Read a register by number (0-15) for the current mode */
  read(n: number): number {
    if (n === 15) return this.r15;
    const mode = this.mode;
    if (mode === Mode.FIQ && n >= 8 && n <= 14) return this.fiq[n - 8]!;
    if (mode === Mode.IRQ && n >= 13 && n <= 14) return this.irq[n - 13]!;
    if (mode === Mode.Supervisor && n >= 13 && n <= 14) return this.svc[n - 13]!;
    return this.usr[n]!;
  }

  /** Write a register by number (0-15) for the current mode */
  write(n: number, value: number): void {
    if (n === 15) {
      // Writing R15 updates both PC and PSR in ARM2
      this.r15 = value >>> 0;
      return;
    }
    const mode = this.mode;
    if (mode === Mode.FIQ && n >= 8 && n <= 14) { this.fiq[n - 8] = value; return; }
    if (mode === Mode.IRQ && n >= 13 && n <= 14) { this.irq[n - 13] = value; return; }
    if (mode === Mode.Supervisor && n >= 13 && n <= 14) { this.svc[n - 13] = value; return; }
    this.usr[n] = value;
  }

  /** PC value (byte address) */
  get pc(): number {
    return this.r15 & PC_MASK;
  }

  set pc(addr: number) {
    this.r15 = (this.r15 & ~PC_MASK) | (addr & PC_MASK);
  }

  /** Advance PC by 4 */
  advancePC(): void {
    this.r15 = (this.r15 + 4) >>> 0;
  }

  // Status flag helpers
  get N(): boolean { return (this.r15 & FLAG_N) !== 0; }
  get Z(): boolean { return (this.r15 & FLAG_Z) !== 0; }
  get C(): boolean { return (this.r15 & FLAG_C) !== 0; }
  get V(): boolean { return (this.r15 & FLAG_V) !== 0; }

  set N(v: boolean) { this.r15 = v ? (this.r15 | FLAG_N) : (this.r15 & ~FLAG_N); }
  set Z(v: boolean) { this.r15 = v ? (this.r15 | FLAG_Z) : (this.r15 & ~FLAG_Z); }
  set C(v: boolean) { this.r15 = v ? (this.r15 | FLAG_C) : (this.r15 & ~FLAG_C); }
  set V(v: boolean) { this.r15 = v ? (this.r15 | FLAG_V) : (this.r15 & ~FLAG_V); }

  get irqDisabled(): boolean { return (this.r15 & IRQ_MASK_BIT) !== 0; }
  get fiqDisabled(): boolean { return (this.r15 & FIQ_MASK_BIT) !== 0; }

  /** Set N and Z flags from a 32-bit result */
  setNZ(result: number): void {
    const u = result >>> 0;
    this.N = (u & 0x8000_0000) !== 0;
    this.Z = u === 0;
  }

  /** Save PSR to SPSR for the given mode (ARM3 / exception entry) */
  savePSR(mode: Mode): void {
    this.spsr[mode] = this.r15 & ~PC_MASK;
  }

  /** Restore PSR from SPSR for the given mode */
  restorePSR(mode: Mode): void {
    const psr = this.spsr[mode]!;
    this.r15 = (this.r15 & PC_MASK) | (psr & ~PC_MASK);
  }

  /** Switch mode, banking appropriate registers */
  switchMode(newMode: Mode): void {
    this.r15 = (this.r15 & ~MODE_MASK) | newMode;
  }

  reset(): void {
    this.usr.fill(0);
    this.fiq.fill(0);
    this.irq.fill(0);
    this.svc.fill(0);
    // Start in Supervisor mode with IRQ+FIQ disabled, PC at 0
    this.r15 = Mode.Supervisor | IRQ_MASK_BIT | FIQ_MASK_BIT;
  }
}
