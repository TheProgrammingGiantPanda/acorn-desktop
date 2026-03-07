/**
 * IOC - I/O Controller (82C711 equivalent)
 *
 * The IOC provides:
 *  - Interrupt management (IRQA, IRQB, FIQ)
 *  - Timers (four 16-bit counters)
 *  - Serial line / keyboard interface
 *  - Floppy disk / printer port control
 *
 * IOC registers (offset from 0x3200_0000, byte-addressed but 32-bit bus):
 *   0x00  Control register
 *   0x04  Serial Rx data
 *   0x08  Serial Tx data
 *   0x10  IRQA status
 *   0x14  IRQA request (clears on read)
 *   0x18  IRQA mask
 *   0x20  IRQB status
 *   0x24  IRQB request
 *   0x28  IRQB mask
 *   0x30  FIQ status
 *   0x34  FIQ request
 *   0x38  FIQ mask
 *   0x40–0x5F Timer 0–3 (latch-low, latch-high, go, latch command)
 */

export type IocIrqCallback = () => void;

export class IOC {
  // Interrupt registers
  private irqAStatus  = 0x00;
  private irqARequest = 0x00;
  irqAMask    = 0x00;
  private irqBStatus  = 0x00;
  private irqBRequest = 0x00;
  irqBMask    = 0x00;
  private fiqStatus   = 0x00;
  private fiqRequest  = 0x00;
  fiqMask     = 0x00;

  // Timers (16-bit each)
  private timerLatch = new Uint16Array(4);
  private timerCount = new Uint16Array(4);
  private timerGo    = new Uint8Array(4);

  // Keyboard receive buffer (FIFO)
  private kbBuffer: number[] = [];

  // Callbacks
  onIRQ?: IocIrqCallback;
  onFIQ?: IocIrqCallback;

  /** IRQ A bit definitions */
  static readonly IRQA_PRINTER_BUSY = 0x01;
  static readonly IRQA_SERIAL_RING  = 0x02;
  static readonly IRQA_PRINTER_ACK  = 0x04;
  static readonly IRQA_VBL          = 0x08; // Vertical blank from VIDC
  static readonly IRQA_POWER_ON     = 0x10;
  static readonly IRQA_TIMER0       = 0x20;
  static readonly IRQA_TIMER1       = 0x40;
  static readonly IRQA_FD_CHANGED   = 0x80;

  /** IRQ B bit definitions */
  static readonly IRQB_PODULE       = 0x01;
  static readonly IRQB_SOUND        = 0x02;
  static readonly IRQB_SERIAL_TX    = 0x04;
  static readonly IRQB_SERIAL_RX    = 0x08;
  static readonly IRQB_KEYBOARD_TX  = 0x10;
  static readonly IRQB_KEYBOARD_RX  = 0x20;
  static readonly IRQB_DISK_CHANGE  = 0x40;
  static readonly IRQB_NETWORK      = 0x80;

  read(offset: number): number {
    switch (offset & 0xFF) {
      case 0x10: return this.irqAStatus;
      case 0x14: { const r = this.irqARequest; this.irqARequest = 0; return r; }
      case 0x18: return this.irqAMask;
      case 0x20: return this.irqBStatus;
      case 0x24: { const r = this.irqBRequest; this.irqBRequest = 0; return r; }
      case 0x28: return this.irqBMask;
      case 0x30: return this.fiqStatus;
      case 0x34: { const r = this.fiqRequest; this.fiqRequest = 0; return r; }
      case 0x38: return this.fiqMask;
      // Timer read-back (latch value)
      case 0x40: return this.timerLatch[0]! & 0xFF;
      case 0x44: return (this.timerLatch[0]! >>> 8) & 0xFF;
      case 0x50: return this.timerLatch[1]! & 0xFF;
      case 0x54: return (this.timerLatch[1]! >>> 8) & 0xFF;
      case 0x60: return this.timerLatch[2]! & 0xFF;
      case 0x64: return (this.timerLatch[2]! >>> 8) & 0xFF;
      case 0x70: return this.timerLatch[3]! & 0xFF;
      case 0x74: return (this.timerLatch[3]! >>> 8) & 0xFF;
      // Keyboard data
      case 0x08: return this.kbBuffer.shift() ?? 0xFF;
    }
    return 0xFF;
  }

  write(offset: number, value: number): void {
    switch (offset & 0xFF) {
      case 0x18: this.irqAMask = value & 0xFF; break;
      case 0x28: this.irqBMask = value & 0xFF; break;
      case 0x38: this.fiqMask  = value & 0xFF; break;
      // Timer latch writes
      case 0x40: this.timerLatch[0] = (this.timerLatch[0]! & 0xFF00) | (value & 0xFF); break;
      case 0x44: this.timerLatch[0] = (this.timerLatch[0]! & 0x00FF) | ((value & 0xFF) << 8); break;
      case 0x48: // Timer 0 Go
        this.timerCount[0] = this.timerLatch[0]!;
        this.timerGo[0] = 1;
        break;
      case 0x4C: // Timer 0 Latch (capture current count)
        this.timerLatch[0] = this.timerCount[0]!;
        break;
      case 0x50: this.timerLatch[1] = (this.timerLatch[1]! & 0xFF00) | (value & 0xFF); break;
      case 0x54: this.timerLatch[1] = (this.timerLatch[1]! & 0x00FF) | ((value & 0xFF) << 8); break;
      case 0x58: this.timerCount[1] = this.timerLatch[1]!; this.timerGo[1] = 1; break;
      case 0x5C: this.timerLatch[1] = this.timerCount[1]!; break;
    }
  }

  /** Called every ~1ms (or per frame). Ticks timers and raises interrupts. */
  tick(microseconds: number): void {
    const ticks = Math.floor(microseconds * 2); // IOC timer: 2MHz

    for (let i = 0; i < 4; i++) {
      if (!this.timerGo[i]) continue;
      const prev = this.timerCount[i]!;
      const next = (prev - ticks) | 0;
      if (next <= 0 && prev > 0) {
        // Timer expired
        this.timerCount[i] = (this.timerLatch[i]! + next) & 0xFFFF;
        if (i === 0) this.raiseIRQA(IOC.IRQA_TIMER0);
        if (i === 1) this.raiseIRQA(IOC.IRQA_TIMER1);
      } else {
        this.timerCount[i] = next & 0xFFFF;
      }
    }
  }

  raiseIRQA(bit: number): void {
    this.irqAStatus  |= bit;
    this.irqARequest |= bit;
    if (this.irqAStatus & this.irqAMask) this.onIRQ?.();
  }

  raiseIRQB(bit: number): void {
    this.irqBStatus  |= bit;
    this.irqBRequest |= bit;
    if (this.irqBStatus & this.irqBMask) this.onIRQ?.();
  }

  raiseFIQ(bit: number): void {
    this.fiqStatus  |= bit;
    this.fiqRequest |= bit;
    if (this.fiqStatus & this.fiqMask) this.onFIQ?.();
  }

  clearIRQA(bit: number): void { this.irqAStatus &= ~bit; }
  clearIRQB(bit: number): void { this.irqBStatus &= ~bit; }

  /** Push a keyboard scan code byte into the receive buffer */
  pushKeyboardByte(byte: number): void {
    this.kbBuffer.push(byte & 0xFF);
    this.raiseIRQB(IOC.IRQB_KEYBOARD_RX);
  }

  /** Trigger vertical blank interrupt (called by renderer every frame) */
  vblank(): void {
    this.raiseIRQA(IOC.IRQA_VBL);
  }

  reset(): void {
    this.irqAStatus = this.irqARequest = this.irqAMask = 0;
    this.irqBStatus = this.irqBRequest = this.irqBMask = 0;
    this.fiqStatus  = this.fiqRequest  = this.fiqMask  = 0;
    this.timerLatch.fill(0);
    this.timerCount.fill(0);
    this.timerGo.fill(0);
    this.kbBuffer = [];
  }
}
