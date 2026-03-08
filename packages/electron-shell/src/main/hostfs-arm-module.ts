/**
 * HostFS ARM Module binary generator
 *
 * Generates a 256-byte RISC OS ARM module for HostFS.  When loaded into RAM
 * at `moduleBase` and its init entry is called by the OS module system, the
 * module registers itself with FileSwitch via OS_FSControl 12 and signals JS
 * via a private SWI sentinel.  Its service entry listens for Service_StartFiler
 * (&4D) and signals JS to add a disc icon to the iconbar.
 *
 * See the issue-27 spec for the full layout description.
 */

export const MODULE_SIZE        = 256;
export const MODULE_INIT_OFFSET = 44;  // byte offset of the init entry within the module
export const MODULE_SENTINEL_SWI = 0x041510; // SWI that signals init complete

/** Generate the ARM module binary for HostFS at the given logical base address. */
export function generateHostFsModule(moduleBase: number): Uint8Array {
  const buf  = new Uint8Array(MODULE_SIZE);
  const view = new DataView(buf.buffer);

  // Helper: write a 32-bit little-endian word at byte offset `off`
  const w = (off: number, val: number) => view.setUint32(off, val >>> 0, true);

  // ── Module header (11 words, offsets 0–40) ────────────────────────────────
  w(0,  0);                  // word 0: module start (0 = no explicit start entry)
  w(4,  44);                 // word 1: init entry offset
  w(8,  0);                  // word 2: finalise entry (none)
  w(12, 68);                 // word 3: service entry offset
  w(16, 88);                 // word 4: title string offset
  w(20, 96);                 // word 5: help string offset
  w(24, 0);                  // word 6: help/command table (none)
  w(28, 0);                  // word 7: SWI chunk base (none)
  w(32, 0);                  // word 8: SWI handler code (none)
  w(36, 0);                  // word 9: SWI decoding table (none)
  w(40, 0);                  // word 10: SWI decoding code (none)

  // ── Init entry (offset 44, 6 instructions × 4 bytes = 24 bytes) ──────────
  // When called, PC is moduleBase+44; "PC" as seen by ADD is moduleBase+44+8 = moduleBase+52
  // We need R1 → moduleBase+208 (FS info block)
  // ADD R1, PC, #N where PC+8 = moduleBase+52 → N = 208 - 52 = 156 = 0x9C
  w(44, 0xE3A0000C);         // MOV R0, #12            (OS_FSControl reason 12 = AddFS)
  w(48, 0xE28F109C);         // ADD R1, PC, #156       (PC+8 at this point = moduleBase+52, +156 = moduleBase+208)
  w(52, 0xE3A02000);         // MOV R2, #0
  w(56, 0xE3A03000);         // MOV R3, #0
  w(60, 0xEF000019);         // SWI OS_FSControl        (register FS; passthroughs to ROM)
  w(64, 0xEF041510);         // SWI 0x041510            (sentinel: signals init done to JS)

  // ── Service entry (offset 68, 5 instructions × 4 bytes = 20 bytes) ───────
  w(68, 0xE351004D);         // CMP R1, #0x4D          (Service_StartFiler?)
  w(72, 0x11A0F00E);         // MOVNE PC, R14          (return if not our service)
  w(76, 0xE92D4000);         // STMFD SP!, {LR}
  w(80, 0xEF041509);         // SWI 0x041509            (callback: notify JS → add iconbar icon)
  w(84, 0xE8BD8000);         // LDMFD SP!, {PC}

  // ── Title string (offset 88): "HostFS\0" padded to 8 bytes ───────────────
  const title = "HostFS";
  for (let i = 0; i < title.length; i++) buf[88 + i] = title.charCodeAt(i);
  buf[88 + title.length] = 0;
  // bytes 95: already 0 (padded)

  // ── Help string (offset 96): "HostFS\t1.00\0" padded to 16 bytes ─────────
  const help = "HostFS\t1.00";
  for (let i = 0; i < help.length; i++) buf[96 + i] = help.charCodeAt(i);
  buf[96 + help.length] = 0;
  // remaining bytes up to 112: already 0

  // ── FS entry stubs (3 instructions each, offsets 112–207) ────────────────
  // Each stub: STMFD SP!, {R8-R12, LR} / SWI 0x04150N / LDMFD SP!, {R8-R12, PC}
  const fsEntries = [
    { off: 112, swi: 0x041500 },  // 0: Open
    { off: 124, swi: 0x041501 },  // 1: GetBytes
    { off: 136, swi: 0x041502 },  // 2: PutBytes
    { off: 148, swi: 0x041503 },  // 3: Args
    { off: 160, swi: 0x041504 },  // 4: Close
    { off: 172, swi: 0x041505 },  // 5: File
    { off: 184, swi: 0x041506 },  // 6: Enumerate
    { off: 196, swi: 0x041507 },  // 7: GBPB
  ];
  for (const { off, swi } of fsEntries) {
    w(off + 0, 0xE92D5F00);       // STMFD SP!, {R8-R12, LR}
    w(off + 4, 0xEF000000 | (swi & 0xFFFFFF)); // SWI <private>
    w(off + 8, 0xE8BD9F00);       // LDMFD SP!, {R8-R12, PC}
  }

  // ── FS info block (offset 208) for OS_FSControl 12 ───────────────────────
  // Byte 0:    FS number (0 = let FileSwitch assign)
  // Bytes 1-6: "HostFS"
  // Byte 7:    0x0D (CR terminator)
  // Bytes 8-11: padding (word-align to offset 216)
  // Word at +8  (offset 216): flags
  // Word at +12 (offset 220): reserved
  // Words at +16..+44 (offsets 224..252): absolute addresses of FS entry stubs
  buf[208] = 0;
  const fsName = "HostFS";
  for (let i = 0; i < fsName.length; i++) buf[209 + i] = fsName.charCodeAt(i);
  buf[215] = 0x0D;  // CR terminator (≤ 0x20 signals end of name to FileSwitch)
  // 216–219: already 0 (pad)
  w(216, 0);  // flags
  w(220, 0);  // reserved
  // Entry point absolute addresses
  for (let i = 0; i < fsEntries.length; i++) {
    w(224 + i * 4, moduleBase + fsEntries[i]!.off);
  }

  return buf;
}
