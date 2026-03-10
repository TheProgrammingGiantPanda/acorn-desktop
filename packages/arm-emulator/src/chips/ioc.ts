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
  // Control register (offset 0x00)
  private control = 0xFF; // pull-ups give 0xFF on reset

  // Interrupt registers
  private irqAStatus = 0x00;
  irqAMask   = 0x00;
  private irqBStatus = 0x00;
  irqBMask   = 0x00;
  private fiqStatus  = 0x00;
  fiqMask    = 0x00;

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
    // IOC data is always on D[7:0]; all registers are at offsets 0x00–0x7C.
    return this.readByte(offset);
  }

  private readByte(offset: number): number {
    switch (offset & 0x7C) {
      case 0x00: return this.control;
      case 0x10: return this.irqAStatus;
      case 0x14: return this.irqAStatus & this.irqAMask;  // IRQ A request = masked status
      case 0x18: return this.irqAMask;
      case 0x20: return this.irqBStatus;
      case 0x24: return this.irqBStatus & this.irqBMask;  // IRQ B request = masked status
      case 0x28: return this.irqBMask;
      case 0x30: return this.fiqStatus;
      case 0x34: return this.fiqStatus & this.fiqMask;    // FIQ request = masked status
      case 0x38: return this.fiqMask;
      // Timer read-back (latch value, after a latch command)
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
    // IOC data is always on D[7:0]; all registers are at offsets 0x00–0x7C.
    const byte = value & 0xFF;
    switch (offset & 0x7C) {
      case 0x00: this.control = byte; break;
      // IRQ clear registers: writing 1 bits clears those bits in the status register.
      // After clearing, re-assert the IRQ line if other bits are still pending
      // (level-sensitive behaviour — matches real Archimedes hardware).
      case 0x14:
        this.irqAStatus &= ~byte;
        if (this.irqAStatus & this.irqAMask) this.onIRQ?.();
        break;
      case 0x24:
        this.irqBStatus &= ~byte;
        if (this.irqBStatus & this.irqBMask) this.onIRQ?.();
        break;
      case 0x34:
        this.fiqStatus &= ~byte;
        if (this.fiqStatus & this.fiqMask) this.onFIQ?.();
        break;
      case 0x18:
        this.irqAMask = byte;
        if (this.irqAStatus & this.irqAMask) this.onIRQ?.();
        break;
      case 0x28:
        this.irqBMask = byte;
        if (this.irqBStatus & this.irqBMask) this.onIRQ?.();
        break;
      case 0x38:
        this.fiqMask = byte;
        if (this.fiqStatus & this.fiqMask) this.onFIQ?.();
        break;
      // Timer latch writes
      case 0x40: this.timerLatch[0] = (this.timerLatch[0]! & 0xFF00) | byte; break;
      case 0x44: this.timerLatch[0] = (this.timerLatch[0]! & 0x00FF) | (byte << 8); break;
      case 0x48: this.timerCount[0] = this.timerLatch[0]!; this.timerGo[0] = 1; break;
      case 0x4C: this.timerLatch[0] = this.timerCount[0]!; break;
      case 0x50: this.timerLatch[1] = (this.timerLatch[1]! & 0xFF00) | byte; break;
      case 0x54: this.timerLatch[1] = (this.timerLatch[1]! & 0x00FF) | (byte << 8); break;
      case 0x58: this.timerCount[1] = this.timerLatch[1]!; this.timerGo[1] = 1; break;
      case 0x5C: this.timerLatch[1] = this.timerCount[1]!; break;
      // Timer 2 (baud-rate clock — no interrupt raised on expiry)
      case 0x60: this.timerLatch[2] = (this.timerLatch[2]! & 0xFF00) | byte; break;
      case 0x64: this.timerLatch[2] = (this.timerLatch[2]! & 0x00FF) | (byte << 8); break;
      case 0x68: this.timerCount[2] = this.timerLatch[2]!; this.timerGo[2] = 1; break;
      case 0x6C: this.timerLatch[2] = this.timerCount[2]!; break;
      // Timer 3 (RTC / event timer — no interrupt raised on expiry)
      case 0x70: this.timerLatch[3] = (this.timerLatch[3]! & 0xFF00) | byte; break;
      case 0x74: this.timerLatch[3] = (this.timerLatch[3]! & 0x00FF) | (byte << 8); break;
      case 0x78: this.timerCount[3] = this.timerLatch[3]!; this.timerGo[3] = 1; break;
      case 0x7C: this.timerLatch[3] = this.timerCount[3]!; break;
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
    this.irqAStatus |= bit;
    if (this.irqAStatus & this.irqAMask) this.onIRQ?.();
  }

  raiseIRQB(bit: number): void {
    this.irqBStatus |= bit;
    if (this.irqBStatus & this.irqBMask) this.onIRQ?.();
  }

  raiseFIQ(bit: number): void {
    this.fiqStatus |= bit;
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
    this.control    = 0xFF;
    // Power-on reset: IRQA_POWER_ON is asserted so the ROM knows this is a
    // cold start rather than a soft reset.
    this.irqAStatus = IOC.IRQA_POWER_ON;
    this.irqAMask   = 0;
    this.irqBStatus = this.irqBMask = 0;
    this.fiqStatus  = this.fiqMask  = 0;
    this.timerLatch.fill(0);
    this.timerCount.fill(0);
    this.timerGo.fill(0);
    this.kbBuffer = [];
  }
}
