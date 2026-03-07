import { describe, it, expect, beforeEach } from "vitest";
import { SystemBus } from "../memory/bus.js";
import { VIDC } from "../chips/vidc.js";
import { MEMC } from "../chips/memc.js";
import { IOC }  from "../chips/ioc.js";

function makeBus(ramBytes = 512 * 1024): { bus: SystemBus; vidc: VIDC; memc: MEMC; ioc: IOC } {
  const vidc = new VIDC();
  const memc = new MEMC();
  const ioc  = new IOC();
  const bus  = new SystemBus(ramBytes, vidc, memc, ioc);
  return { bus, vidc, memc, ioc };
}

describe("SystemBus — RAM", () => {

  it("reads 0 from uninitialised RAM", () => {
    const { bus } = makeBus();
    expect(bus.read32(0x0200_0000)).toBe(0);
  });

  it("write32 / read32 round-trip in physical RAM", () => {
    const { bus } = makeBus();
    bus.write32(0x0200_0000, 0xDEAD_BEEF);
    expect(bus.read32(0x0200_0000)).toBe(0xDEAD_BEEF);
  });

  it("write8 / read8 round-trip", () => {
    const { bus } = makeBus();
    bus.write8(0x0200_0001, 0xAB);
    expect(bus.read8(0x0200_0001)).toBe(0xAB);
  });

  it("read32 is little-endian", () => {
    const { bus } = makeBus();
    bus.write8(0x0200_0000, 0x01);
    bus.write8(0x0200_0001, 0x02);
    bus.write8(0x0200_0002, 0x03);
    bus.write8(0x0200_0003, 0x04);
    expect(bus.read32(0x0200_0000)).toBe(0x0403_0201);
  });

  it("write8 into word-aligned address affects only that byte", () => {
    const { bus } = makeBus();
    bus.write32(0x0200_0010, 0xFFFF_FFFF);
    bus.write8 (0x0200_0010, 0x00);
    expect(bus.read32(0x0200_0010)).toBe(0xFFFF_FF00);
  });
});

describe("SystemBus — ROM", () => {

  it("ROM is readable after loadROM", () => {
    const { bus } = makeBus();
    const rom = new Uint8Array(64 * 1024);
    rom[0] = 0xAA; rom[1] = 0xBB; rom[2] = 0xCC; rom[3] = 0xDD;
    bus.loadROM(rom);
    expect(bus.read32(0x3400_0000)).toBe(0xDDCC_BBAA);
  });

  it("ROM is aliased at address 0 before release", () => {
    const { bus } = makeBus();
    const rom = new Uint8Array(64 * 1024);
    rom[0] = 1; rom[1] = 2; rom[2] = 3; rom[3] = 4;
    bus.loadROM(rom);
    // ROM should be visible at address 0 (reset alias)
    expect(bus.read32(0)).toBe(bus.read32(0x3400_0000));
  });

  it("ROM alias is released after releaseROMAlias()", () => {
    const { bus } = makeBus();
    const rom = new Uint8Array(64 * 1024);
    rom[0] = 0xFF;
    bus.loadROM(rom);
    bus.releaseROMAlias();
    // Address 0 should now be RAM (which is 0)
    expect(bus.read32(0)).toBe(0);
  });

  it("writing to ROM is silently ignored", () => {
    const { bus } = makeBus();
    const rom = new Uint8Array(64 * 1024);
    rom[0] = 0x42;
    bus.loadROM(rom);
    bus.write32(0x3400_0000, 0xDEAD);
    expect(bus.read32(0x3400_0000)).toBe(0x0000_0042); // unchanged
  });
});

describe("SystemBus — MEMC", () => {

  it("MEMC reads return 0xFFFFFFFF (write-only chip)", () => {
    const { bus } = makeBus();
    expect(bus.read32(0x36E0_0000)).toBe(0xFFFF_FFFF);
  });

  it("MEMC video DMA start is updated by write", () => {
    const { bus, memc } = makeBus();
    bus.write32(0x36E0_0004, 0x0200_0010);
    expect(memc.videoDMAStart).toBe(0x0200_0010);
  });
});

describe("SystemBus — DMA", () => {

  it("dmaRead returns a view into physical RAM", () => {
    const { bus } = makeBus();
    bus.write32(0x0200_0000, 0x1234_5678);
    const view = bus.dmaRead(0x0200_0000, 4);
    expect(view[0]).toBe(0x78);
    expect(view[1]).toBe(0x56);
    expect(view[2]).toBe(0x34);
    expect(view[3]).toBe(0x12);
  });
});
