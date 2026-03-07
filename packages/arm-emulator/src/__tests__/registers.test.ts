import { describe, it, expect, beforeEach } from "vitest";
import { RegisterFile, Mode, FLAG_N, FLAG_Z, FLAG_C, FLAG_V, IRQ_MASK_BIT, FIQ_MASK_BIT } from "../cpu/registers.js";

describe("RegisterFile", () => {
  let regs: RegisterFile;

  beforeEach(() => {
    regs = new RegisterFile();
    regs.reset();
  });

  // ── Reset state ────────────────────────────────────────────────────────────
  describe("reset()", () => {
    it("starts in Supervisor mode", () => {
      expect(regs.mode).toBe(Mode.Supervisor);
    });

    it("has PC = 0 after reset", () => {
      expect(regs.pc).toBe(0);
    });

    it("has IRQ and FIQ disabled after reset", () => {
      expect(regs.irqDisabled).toBe(true);
      expect(regs.fiqDisabled).toBe(true);
    });

    it("has all flags clear after reset", () => {
      expect(regs.N).toBe(false);
      expect(regs.Z).toBe(false);
      expect(regs.C).toBe(false);
      expect(regs.V).toBe(false);
    });
  });

  // ── PC manipulation ────────────────────────────────────────────────────────
  describe("pc", () => {
    it("advances by 4 per advancePC()", () => {
      regs.pc = 0x1000;
      regs.advancePC();
      expect(regs.pc).toBe(0x1004);
    });

    it("setting pc preserves PSR bits in r15", () => {
      regs.N = true;
      regs.pc = 0x2000;
      expect(regs.N).toBe(true);
      expect(regs.pc).toBe(0x2000);
    });
  });

  // ── User-mode registers ────────────────────────────────────────────────────
  describe("user mode registers", () => {
    it("reads and writes R0–R12 in User mode", () => {
      regs.switchMode(Mode.User);
      for (let i = 0; i < 13; i++) {
        regs.write(i, i * 100);
        expect(regs.read(i)).toBe(i * 100);
      }
    });
  });

  // ── FIQ banking ────────────────────────────────────────────────────────────
  describe("FIQ register banking", () => {
    it("R8–R14 are banked in FIQ mode", () => {
      regs.switchMode(Mode.User);
      for (let i = 8; i <= 14; i++) regs.write(i, 0xAAAA_0000 | i);

      regs.switchMode(Mode.FIQ);
      for (let i = 8; i <= 14; i++) {
        // FIQ registers start at 0, different from user-mode values
        expect(regs.read(i)).toBe(0);
        regs.write(i, 0xBBBB_0000 | i);
      }

      // Return to User — original values preserved
      regs.switchMode(Mode.User);
      for (let i = 8; i <= 14; i++) {
        expect(regs.read(i)).toBe(0xAAAA_0000 | i);
      }

      // Back to FIQ — FIQ values preserved
      regs.switchMode(Mode.FIQ);
      for (let i = 8; i <= 14; i++) {
        expect(regs.read(i)).toBe(0xBBBB_0000 | i);
      }
    });

    it("R0–R7 are shared between User and FIQ", () => {
      regs.switchMode(Mode.User);
      regs.write(0, 0xDEAD);
      regs.switchMode(Mode.FIQ);
      expect(regs.read(0)).toBe(0xDEAD);
    });
  });

  // ── IRQ / Supervisor banking ───────────────────────────────────────────────
  describe("IRQ / Supervisor banking (R13–R14)", () => {
    it("R13 and R14 are banked in IRQ mode", () => {
      regs.switchMode(Mode.User);
      regs.write(13, 0x1111);
      regs.write(14, 0x2222);

      regs.switchMode(Mode.IRQ);
      expect(regs.read(13)).toBe(0); // IRQ bank starts at 0
      regs.write(13, 0xABCD);

      regs.switchMode(Mode.User);
      expect(regs.read(13)).toBe(0x1111); // unchanged
    });

    it("R13 and R14 are banked in Supervisor mode", () => {
      regs.switchMode(Mode.User);
      regs.write(13, 0x9999);

      regs.switchMode(Mode.Supervisor);
      expect(regs.read(13)).toBe(0); // SVC bank starts at 0
    });
  });

  // ── Status flags ───────────────────────────────────────────────────────────
  describe("status flags", () => {
    it("sets N flag independently", () => {
      regs.N = true;  expect(regs.N).toBe(true);
      regs.N = false; expect(regs.N).toBe(false);
    });

    it("sets Z flag independently", () => {
      regs.Z = true;  expect(regs.Z).toBe(true);
      regs.Z = false; expect(regs.Z).toBe(false);
    });

    it("sets C flag independently", () => {
      regs.C = true;  expect(regs.C).toBe(true);
      regs.C = false; expect(regs.C).toBe(false);
    });

    it("sets V flag independently", () => {
      regs.V = true;  expect(regs.V).toBe(true);
      regs.V = false; expect(regs.V).toBe(false);
    });

    it("setNZ sets N for negative result", () => {
      regs.setNZ(0x8000_0000);
      expect(regs.N).toBe(true);
      expect(regs.Z).toBe(false);
    });

    it("setNZ sets Z for zero", () => {
      regs.N = true;
      regs.setNZ(0);
      expect(regs.Z).toBe(true);
      expect(regs.N).toBe(false);
    });

    it("flags coexist with PC in r15", () => {
      regs.pc = 0x4000;
      regs.N = true; regs.Z = false; regs.C = true; regs.V = false;
      expect(regs.pc).toBe(0x4000);
      expect(regs.N).toBe(true);
      expect(regs.C).toBe(true);
    });
  });

  // ── SPSR save/restore ──────────────────────────────────────────────────────
  describe("SPSR save / restore", () => {
    it("saves and restores PSR for Supervisor mode", () => {
      regs.N = true; regs.Z = true;
      regs.savePSR(Mode.Supervisor);

      regs.N = false; regs.Z = false;
      regs.restorePSR(Mode.Supervisor);

      expect(regs.N).toBe(true);
      expect(regs.Z).toBe(true);
    });
  });
});
