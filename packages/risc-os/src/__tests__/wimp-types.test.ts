import { describe, it, expect } from "vitest";
import { osUnitsToPx, pxToOsUnits, WF_CLOSE_ICON, WF_TITLE_BAR, IF_TEXT, IF_SELECTED } from "../wimp/types.js";

describe("OS unit conversions", () => {

  it("0 OS units = 0 pixels", () => {
    expect(osUnitsToPx(0)).toBe(0);
  });

  it("2 OS units = 1 pixel", () => {
    expect(osUnitsToPx(2)).toBe(1);
  });

  it("1280 OS units = 640 pixels (standard 640×512 mode)", () => {
    expect(osUnitsToPx(1280)).toBe(640);
  });

  it("pxToOsUnits is the inverse of osUnitsToPx", () => {
    for (const px of [0, 1, 100, 640, 1024]) {
      expect(osUnitsToPx(pxToOsUnits(px))).toBe(px);
    }
  });
});

describe("Window flags", () => {

  it("WF_CLOSE_ICON flag bit is 23", () => {
    expect(WF_CLOSE_ICON).toBe(1 << 23);
  });

  it("WF_TITLE_BAR flag bit is 24", () => {
    expect(WF_TITLE_BAR).toBe(1 << 24);
  });

  it("flags can be combined with bitwise OR", () => {
    const flags = WF_CLOSE_ICON | WF_TITLE_BAR;
    expect(flags & WF_CLOSE_ICON).toBeTruthy();
    expect(flags & WF_TITLE_BAR).toBeTruthy();
  });
});

describe("Icon flags", () => {

  it("IF_TEXT bit is 0", () => {
    expect(IF_TEXT).toBe(1 << 0);
  });

  it("IF_SELECTED bit is 21", () => {
    expect(IF_SELECTED).toBe(1 << 21);
  });

  it("icon flags combine independently", () => {
    const flags = IF_TEXT | IF_SELECTED;
    expect(flags & IF_TEXT).toBeTruthy();
    expect(flags & IF_SELECTED).toBeTruthy();
  });
});
