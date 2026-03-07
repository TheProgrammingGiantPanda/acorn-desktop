import { describe, it, expect, beforeEach } from "vitest";
import { SystemVariables } from "../sysvar/sysvar.js";

describe("SystemVariables", () => {
  let sv: SystemVariables;
  beforeEach(() => { sv = new SystemVariables(); });

  it("stores and retrieves a string variable", () => {
    sv.set("Foo$Bar", "hello");
    expect(sv.get("Foo$Bar")).toBe("hello");
  });

  it("is case-insensitive on name lookup", () => {
    sv.set("FOO$BAR", "hello");
    expect(sv.get("foo$bar")).toBe("hello");
    expect(sv.get("Foo$Bar")).toBe("hello");
  });

  it("returns undefined for an unset variable", () => {
    expect(sv.get("Missing$Var")).toBeUndefined();
  });

  it("unsets a variable", () => {
    sv.set("Foo$Bar", "hello");
    sv.unset("Foo$Bar");
    expect(sv.get("Foo$Bar")).toBeUndefined();
    expect(sv.has("Foo$Bar")).toBe(false);
  });

  it("has() reports presence correctly", () => {
    expect(sv.has("X")).toBe(false);
    sv.set("X", "1");
    expect(sv.has("X")).toBe(true);
  });

  it("overwrites an existing variable", () => {
    sv.set("X", "first");
    sv.set("X", "second");
    expect(sv.get("X")).toBe("second");
  });

  describe("substitute()", () => {
    it("replaces <VarName> with the variable value", () => {
      sv.set("Obey$Dir", "$.Apps.!Paint");
      expect(sv.substitute("Run <Obey$Dir>.!RunImage")).toBe("Run $.Apps.!Paint.!RunImage");
    });

    it("replaces multiple references in one string", () => {
      sv.set("A", "foo");
      sv.set("B", "bar");
      expect(sv.substitute("<A>-<B>")).toBe("foo-bar");
    });

    it("leaves unknown references as empty string", () => {
      expect(sv.substitute("hello <Missing$Var> world")).toBe("hello  world");
    });
  });

  describe("macro type", () => {
    it("expands references when read", () => {
      sv.set("Base$Dir", "$.Apps");
      sv.set("Paint$Dir", "<Base$Dir>.!Paint", "macro");
      expect(sv.get("Paint$Dir")).toBe("$.Apps.!Paint");
    });

    it("string type does not expand references on read", () => {
      sv.set("Base$Dir", "$.Apps");
      sv.set("Paint$Dir", "<Base$Dir>.!Paint", "string");
      expect(sv.get("Paint$Dir")).toBe("<Base$Dir>.!Paint");
    });
  });
});
