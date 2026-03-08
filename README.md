# Acorn Desktop

An Acorn Archimedes emulator that boots real RISC OS ROM images on Windows, Linux, and macOS.

The real RISC OS ROM executes from address 0 just as it would on hardware. Wimp SWI calls are intercepted and each RISC OS window is mapped to a real native OS window via Electron, so the desktop looks and feels native. Host directories are accessible to RISC OS programs via the built-in HostFS filing system.

## How it works

```
RISC OS ROM
      │ boots, initialises modules, starts Filer
      ▼
  ARM2 CPU (arm2.ts)
      │ SWI instruction
      ▼
  SWI Dispatcher (dispatcher.ts)
      ├─ Wimp_* calls ──────────────────────────────────────────────┐
      │                                                             ▼
      │                                                     WimpManager (wimp-manager.ts)
      │                                                         │ NativeHost interface
      │                                                         ▼
      │                                                 NativeWimpHost (native-wimp-host.ts)
      │                                                         │
      │                                                         ▼
      │                                               Electron BrowserWindow (per RISC OS window)
      │
      ├─ OS_File / OS_Find / OS_GBPB / OS_Args  ────────────────────┐
      │   (path starts with "HostFS::")                             ▼
      │                                                  HostFsHandler (hostfs-handler.ts)
      │                                                       │ Node.js fs
      │                                                       ▼
      │                                               Host file system (configurable root)
      │
      └─ all other SWIs ────────────────────────────────────────────┐
                                                                    ▼
                                                          ROM FileSwitch / OS kernel
                                                          (ADFS, RAM disc, modules…)
```

## Packages

| Package | Description |
|---|---|
| `@theprogramminggiantpanda/shared` | IPC channel names, `MachineConfig` type |
| `@theprogramminggiantpanda/arm-emulator` | ARM2/ARM3 CPU, MEMC, IOC, system bus |
| `@theprogramminggiantpanda/risc-os` | RISC OS SWI dispatch, Wimp manager, OS handlers |
| `electron-shell` | Electron app, native window host, launcher UI |

## Requirements

- Node.js 18+
- pnpm 8+
- A RISC OS ROM image (see [ROM images](#rom-images))

```sh
npm install -g pnpm
```

## Getting started

```sh
pnpm install
pnpm build
pnpm start
```

Place a RISC OS ROM image (`.rom`, `.bin`, or `.img`) in `assets/roms/`. The emulator loads it automatically on startup. You can also click **Load ROM** in the menu or drag a ROM file onto the launcher window.

## Development

```sh
pnpm dev
```

Starts the Electron app in dev mode with hot-reload for the renderer and watch mode for the main process TypeScript.

### Build order

The packages have dependencies between them and must be built in order:

```sh
pnpm --filter @theprogramminggiantpanda/shared run build
pnpm --filter @theprogramminggiantpanda/arm-emulator run build
pnpm --filter @theprogramminggiantpanda/risc-os run build
pnpm --filter electron-shell run build
```

`pnpm build` (at the root) does this automatically.

### Tests

```sh
pnpm test           # run once
pnpm test:watch     # watch mode
pnpm test:coverage  # with coverage report
```

Tests cover the CPU instruction set, system bus, chip registers, Wimp event queue, OS SWI handlers, and Wimp type helpers. The test suite uses [Vitest](https://vitest.dev/) with workspace-level path aliases so packages can be tested without a prior build step.

## Architecture notes

### CPU (ARMv2)

The CPU is a full ARMv2 implementation:

- All data processing opcodes (AND, EOR, SUB, RSB, ADD, ADC, SBC, RSC, TST, TEQ, CMP, CMN, ORR, MOV, BIC, MVN)
- Barrel shifter (LSL, LSR, ASR, ROR) with carry-out
- Single and block data transfer (LDR/STR, LDM/STM — all four IA/IB/DA/DB addressing modes)
- Branch and branch-with-link
- Multiply and multiply-accumulate
- SWI dispatch: registered handlers are checked first; returning `'passthrough'` falls through to the ROM SWI vector
- Exception vectors (Reset, Undefined, SWI, Prefetch Abort, Data Abort, IRQ, FIQ)
- ARM2 R15 encodes both PC and PSR (flags, mode, IRQ/FIQ mask bits)

ARM3 support adds a coprocessor CP15 cache-flush stub but is otherwise instruction-set identical.

### Memory map

```
0x0000_0000 – 0x01FF_FFFF   Logical RAM (via MEMC CAM)
0x0200_0000 – 0x03FF_FFFF   Physical RAM (up to 4 MB)
0x3200_0000 – 0x323F_FFFF   IOC (I/O controller)
0x3400_0000 – 0x37FF_FFFF   ROM (4 MB window)
0x3500_0000 – 0x35FF_FFFF   VIDC (write-only; no frame buffer rendered)
0x36E0_0000 – 0x36FF_FFFF   MEMC control registers
```

ROM is aliased at address 0 on reset. The ROM releases the alias itself by writing the MEMC control register during its boot sequence.

### Boot sequence

The real RISC OS ROM boots from address 0:

1. ROM initialises MEMC, IOC, and writes its own exception vectors into RAM
2. ROM releases the ROM alias by writing the MEMC control register
3. ROM initialises the module system (FileSwitch, ADFS, RAM disc, Filer, etc.)
4. The Wimp starts and the desktop appears

A 50 Hz vertical-blank IRQ is generated unconditionally (without VIDC rendering) so the ROM's cooperative task switcher fires correctly.

Before the ROM boots, `assets/programs/` is scanned for RISC OS `!App` directories. Each app's `!Boot` Obey script is executed (or its `!Sprites` loaded directly) to register file type associations and load app sprites into the system sprite pool.

### Native window mode

No VIDC pixel rendering takes place. Instead:

- `Wimp_CreateWindow` → creates a `BrowserWindow` with a canvas renderer
- `Wimp_OpenWindow` → shows and positions the window
- `Wimp_Poll` → suspends the CPU (`swiPending = true`) until a native event arrives, then resumes
- Mouse clicks and key presses in a `BrowserWindow` are sent via IPC to the main process and delivered to the emulated CPU as Wimp events
- The iconbar is a persistent, frameless, always-on-bottom `BrowserWindow`

### HostFS

HostFS exposes a host directory to RISC OS programs using the path prefix `HostFS::`.

**Path format:**

| RISC OS path | Host path |
|---|---|
| `HostFS::$` | `{root}` |
| `HostFS::$.Programs.!Paint` | `{root}/Programs/!Paint` |

The root directory defaults to the directory from which the app or ROM was launched (typically `assets/programs/`).

**File type preservation — `,xyz` suffix convention:**

RISC OS files carry a 12-bit file type encoded in the load address. On a native filesystem these are preserved using the standard `,xyz` filename suffix (three lowercase hex digits):

| Host filename | RISC OS name | File type |
|---|---|---|
| `Document,fff` | `Document` | 0xFFF (untyped) |
| `Letter,ffc` | `Letter` | 0xFFC (Text) |
| `Sprite,ff9` | `Sprite` | 0xFF9 (Sprite) |

When reading, the `,xyz` suffix is stripped and the file type is encoded into the RISC OS load/exec address words (including a RISC OS 5-byte centisecond timestamp derived from the host file's mtime). When writing, the correct `,xyz` suffix is appended and any stale copy with a different suffix is removed.

Files without a `,xyz` suffix are presented as untyped (`load=0xFFFFFFFF`).

**SWI coverage:**

| SWI | Reason codes | Notes |
|---|---|---|
| `OS_File` | 0 (save block), 5 (stat), 8 (mkdir), 255 (load) | Save appends `,xyz` from load addr |
| `OS_Find` | 0x40 read, 0x80 write, 0xC0 update, 0x00 close | Writes buffered in memory, flushed on close |
| `OS_Args` | 0 get ptr, 1 set ptr, 2 get extent, 255 flush | |
| `OS_GBPB` | 1–2 write, 3–4 read, 9/10/11/12 dir listing | Dir listing returns bare names + full catalogue info |
| `OS_FSControl` | 0 select, 36 canonicalise | |

All other paths (not beginning with `HostFS::`) return `'passthrough'` and are handled by the real ROM FileSwitch (ADFS, RAM disc, etc.).

### Sprites

RISC OS sprite files (`.!Sprites`) are parsed and decoded at boot time by `SpritePool` in `packages/risc-os/src/sprite/sprite-pool.ts`.

**File format:**

| Region | Layout |
|---|---|
| Area header | 3 words: num_sprites, first_sprite_mem_offset, free_mem_offset |
| Per-sprite header | 44 bytes: next_offset, name (12 b), width_words−1, height−1, lbit, rbit, img_offset, mask_offset, mode |
| Palette (optional) | Between byte 44 and img_offset; 8 bytes per entry (two flash-colour words) |
| Image data | Packed LSB-first; `lbit` leading bits per row are padding |
| Mask data | 1 bit per pixel, same row width (in words) as image; 1 = opaque |

Colour words use the format: bits 8–15 = red, 16–23 = green, 24–31 = blue.

Default palettes are provided for 1, 2, 4, and 8 bpp modes. An embedded palette in the sprite overrides the default.

### Supported SWIs

**OS core:** `OS_WriteC`, `OS_Write0`, `OS_WriteN`, `OS_NewLine`, `OS_Exit`, `OS_GetEnv`, `OS_Byte`, `OS_Mouse`, `OS_ReadModeVar`, `OS_Heap`, `OS_Module`, `OS_IntOn`, `OS_IntOff`

**HostFS:** `OS_File`, `OS_Find`, `OS_Args`, `OS_GBPB`, `OS_FSControl` (for `HostFS::` paths only; all other paths pass through to ROM)

**Wimp:** `Wimp_Initialise`, `Wimp_CreateWindow`, `Wimp_OpenWindow`, `Wimp_CloseWindow`, `Wimp_DeleteWindow`, `Wimp_Poll`, `Wimp_PollIdle`, `Wimp_RedrawWindow`, `Wimp_UpdateWindow`, `Wimp_GetWindowState`, `Wimp_ForceRedraw`, `Wimp_CreateIcon`, `Wimp_CreateMenu`, `Wimp_ReportError`, `Wimp_GetPointerInfo`, `Wimp_SlotSize`, `Wimp_ReadSysInfo`, `Wimp_SendMessage`, `Wimp_CloseDown`

**Font:** `Font_FindFont`, `Font_LoseFont`, `Font_Paint`, `Font_StringWidth`, `Font_SetFontColours` (stubs)

All other SWIs are handled by the ROM.

## Project structure

```
acorn-desktop/
├── packages/
│   ├── shared/
│   │   └── src/
│   │       └── index.ts          # IPC channels, MachineConfig
│   ├── arm-emulator/
│   │   └── src/
│   │       ├── cpu/
│   │       │   ├── arm2.ts       # CPU core + SWI passthrough mechanism
│   │       │   └── registers.ts  # Register file (R0–R15, PSR)
│   │       ├── memory/
│   │       │   └── bus.ts        # System bus / address decode
│   │       ├── chips/
│   │       │   ├── memc.ts       # Memory controller (CAM, ROM alias release)
│   │       │   ├── ioc.ts        # I/O controller (timers, IRQ/FIQ, VBL)
│   │       │   └── vidc.ts       # Video controller (stub)
│   │       └── machine.ts        # Top-level machine wiring + bootROM()
│   ├── risc-os/
│   │   └── src/
│   │       ├── swi/
│   │       │   ├── dispatcher.ts # Registers Wimp + OS SWI handlers
│   │       │   └── os-core.ts    # OS_* SWI implementations
│   │       ├── fs/
│   │       │   ├── fs-host.ts    # FileSystemHost interface
│   │       │   └── os-fs.ts      # HLE file SWI handlers (used in non-ROM mode)
│   │       ├── wimp/
│   │       │   ├── wimp-manager.ts  # Wimp_* SWI implementations
│   │       │   ├── event-queue.ts   # Wimp event queue
│   │       │   ├── native-host.ts   # NativeHost interface
│   │       │   └── types.ts         # Wimp types and constants
│   │       ├── sprite/
│   │       │   └── sprite-pool.ts   # RISC OS sprite area parser + decoded pool
│   │       └── swi-numbers.ts    # SWI number constants
│   └── electron-shell/
│       └── src/
│           ├── main/
│           │   ├── index.ts            # Electron main process + boot sequence
│           │   ├── native-wimp-host.ts # NativeHost → BrowserWindow
│           │   ├── hostfs-handler.ts   # HostFS SWI handler (HostFS:: paths)
│           │   ├── node-fs-host.ts     # FileSystemHost → host OS
│           │   └── menu.ts             # Application menu
│           ├── preload/
│           │   ├── index.ts           # Launcher preload
│           │   ├── window-preload.ts  # Per-window preload
│           │   └── iconbar-preload.ts # Iconbar preload
│           └── renderer/
│               ├── index.html + app.ts        # Launcher
│               ├── window.html + window-renderer.ts  # RISC OS window canvas
│               └── iconbar.html + iconbar.ts  # Iconbar
├── vitest.config.ts
└── package.json
```

## ROM images

You need a RISC OS ROM image to run the emulator. ROM images are copyrighted by RISC OS Open Ltd and are not included here. A legitimate copy can be obtained from [riscosopen.org](https://riscosopen.org).

Place the ROM image in `assets/roms/` with a `.rom`, `.bin`, or `.img` extension. The first file found is loaded automatically.

## Limitations

- No VIDC pixel rendering — applications that draw directly to the frame buffer rather than using Wimp SWIs will not display correctly
- No sound
- No floating-point emulation (FPE)
- HostFS is read/write but does not implement all `OS_FSControl` operations or the full FileSwitch module registration API
