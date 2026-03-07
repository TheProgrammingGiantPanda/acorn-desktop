/**
 * Core OS SWI handlers (OS_WriteC, OS_Write0, OS_Exit, OS_GetEnv, etc.)
 */

import type { RegisterFile } from "@theprogramminggiantpanda/arm-emulator";
import type { SystemBus }    from "@theprogramminggiantpanda/arm-emulator";
import type { ArchimedesMachine } from "@theprogramminggiantpanda/arm-emulator";

/** Callback for OS_WriteC / OS_Write0 output */
export type OutputCallback = (text: string) => void;

/** Reads null-terminated string from bus */
function readString(bus: SystemBus, addr: number): string {
  let s = "", i = 0;
  while (i < 4096) {
    const c = bus.read8(addr + i++);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

export function makeOSHandlers(
  machine: ArchimedesMachine,
  output: OutputCallback,
) {
  return {
    /** OS_WriteC — write character in R0 to VDU stream */
    OS_WriteC: (regs: RegisterFile, _bus: SystemBus) => {
      output(String.fromCharCode(regs.read(0) & 0xFF));
    },

    /** OS_Write0 — write null-terminated string pointed to by R0 */
    OS_Write0: (regs: RegisterFile, bus: SystemBus) => {
      output(readString(bus, regs.read(0)));
    },

    /** OS_NewLine — write CR+LF */
    OS_NewLine: (_regs: RegisterFile, _bus: SystemBus) => {
      output("\r\n");
    },

    /** OS_Exit — terminate current task */
    OS_Exit: (_regs: RegisterFile, _bus: SystemBus) => {
      machine.stop();
    },

    /** OS_GetEnv — return basic environment info */
    OS_GetEnv: (regs: RegisterFile, bus: SystemBus) => {
      // R0 = ptr to command string (we put an empty string at a fixed RAM location)
      const cmdAddr = 0x8000; // arbitrary safe RAM address
      bus.write8(cmdAddr, 0);
      regs.write(0, cmdAddr);
      regs.write(1, 0x0280_0000); // memory limit (just above 4MB RAM)
      regs.write(2, 0); // time
    },

    /** OS_Byte — miscellaneous one-byte operations */
    OS_Byte: (regs: RegisterFile, _bus: SystemBus) => {
      const reason = regs.read(0);
      switch (reason) {
        case 0:   regs.write(0, 1); break; // read OS version — RISC OS 3
        case 124: /* clear escape */ break;
        case 125: /* set escape */ break;
        case 129: // read keyboard with timeout
          regs.write(1, 0);  // no key
          regs.write(2, 1);  // timeout
          break;
        case 161: // read CMOS RAM
          regs.write(2, 0);
          break;
        default:
          break;
      }
    },

    /** OS_IntOn — enable interrupts */
    OS_IntOn: (regs: RegisterFile, _bus: SystemBus) => {
      regs.r15 &= ~0x0800_0000; // clear IRQ disable bit
    },

    /** OS_IntOff — disable interrupts */
    OS_IntOff: (regs: RegisterFile, _bus: SystemBus) => {
      regs.r15 |= 0x0800_0000; // set IRQ disable bit
    },

    /** OS_Mouse — return mouse position and button state */
    OS_Mouse: (regs: RegisterFile, _bus: SystemBus) => {
      regs.write(0, 0); // X
      regs.write(1, 0); // Y
      regs.write(2, 0); // buttons
      regs.write(3, 0); // timestamp
    },

    /** OS_ReadModeVar — read screen mode variable */
    OS_ReadModeVar: (regs: RegisterFile, _bus: SystemBus) => {
      // R0 = mode, R1 = variable number
      const varNum = regs.read(1);
      const modeVars: Record<number, number> = {
        0:  0,     // mode flags
        1:  3,     // BPP log2 (2^3=8bpp)
        2:  1,     // X eig factor (2px per OS unit)
        3:  1,     // Y eig factor
        4:  639,   // X screen size - 1 (pixels)
        5:  511,   // Y screen size - 1
        6:  80,    // screen width in characters
        7:  32,    // screen height in characters
        9:  2,     // log2 BPP
        11: 640,   // screen width in pixels
        12: 512,   // screen height in pixels
      };
      regs.write(2, modeVars[varNum] ?? 0);
      // C flag: 0 = valid
      regs.C = false;
    },

    /** OS_Heap — simple heap manager stub */
    OS_Heap: (regs: RegisterFile, bus: SystemBus) => {
      const reason  = regs.read(0);
      const heapBase = regs.read(1);

      switch (reason) {
        case 0: // initialise heap
          bus.write32(heapBase,     0x70616548); // 'Heap' magic
          bus.write32(heapBase + 4, regs.read(3)); // size
          bus.write32(heapBase + 8, regs.read(3));
          bus.write32(heapBase + 12, 0);
          break;
        case 1: { // describe heap
          regs.write(2, bus.read32(heapBase + 4)); // largest free block
          regs.write(3, bus.read32(heapBase + 8)); // total free
          break;
        }
        case 2: { // get heap block
          const size = (regs.read(3) + 7) & ~7;
          const free = bus.read32(heapBase + 8);
          if (free >= size + 8) {
            const ptr = heapBase + (bus.read32(heapBase + 4) - free);
            bus.write32(heapBase + 8, free - size - 8);
            regs.write(2, ptr + 4);
            regs.C = false;
          } else {
            regs.C = true; // out of memory
          }
          break;
        }
        case 3: // release heap block
          regs.C = false;
          break;
        default:
          break;
      }
    },

    /** OS_Module — module management stub */
    OS_Module: (regs: RegisterFile, _bus: SystemBus) => {
      // Most calls — return sensible defaults
      regs.write(0, 0);
      regs.C = false;
    },

    /** OS_WriteN — write N characters */
    OS_WriteN: (regs: RegisterFile, bus: SystemBus) => {
      const addr = regs.read(0);
      const n    = regs.read(1);
      let s = "";
      for (let i = 0; i < n; i++) s += String.fromCharCode(bus.read8(addr + i));
      output(s);
    },
  };
}
