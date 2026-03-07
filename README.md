# Acorn Desktop

An Acorn Archimedes emulator that runs RISC OS programs on Windows, Linux, and macOS.

Instead of emulating the hardware display (VIDC frame buffer), it intercepts RISC OS Wimp SWI calls and maps each RISC OS window to a real native OS window via Electron. The result is a RISC OS application environment that looks and feels like a native desktop app.

## How it works

The ARM2/ARM3 CPU executes RISC OS machine code. When the program calls a Wimp SWI (e.g. `Wimp_CreateWindow`), the emulator intercepts it and creates a real `BrowserWindow` instead of writing pixels to a frame buffer. File I/O SWIs are forwarded to the host file system. Mouse clicks, key presses, and window events flow back into the emulated CPU via the `Wimp_Poll` event queue.

```
ARM program code
      │
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
      └─ OS_File / OS_Find / OS_BGet / OS_GBPB … ──────────────────┐
                                                                    ▼
                                                          OSFileHandler (os-fs.ts)
                                                              │ FileSystemHost interface
                                                              ▼
                                                         NodeFsHost (node-fs-host.ts)
                                                              │
                                                              ▼
                                                       Host file system (~/Documents/RISCOS)
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

```sh
npm install -g pnpm
```

## Getting started

```sh
pnpm install
pnpm build
pnpm start
```

Then click **Load ROM** and select a RISC OS ROM image (`.rom`, `.bin`, or `.img`). You can also drag a ROM file onto the launcher window.

## Development

```sh
pnpm dev
```

This starts the Electron app in dev mode with hot-reload for the renderer and watch mode for the main process TypeScript.

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
- SWI dispatch with registered handlers
- Exception vectors (Reset, Undefined, SWI, Prefetch Abort, Data Abort, IRQ, FIQ)
- ARM2 R15 encodes both PC and PSR (flags, mode, IRQ/FIQ mask bits)

ARM3 support adds a coprocessor CP15 cache-flush stub but is otherwise instruction-set identical.

### Memory map

```
0x0000_0000 – 0x01FF_FFFF   Logical RAM (via MEMC)
0x0200_0000 – 0x03FF_FFFF   Physical RAM (up to 4 MB)
0x3200_0000 – 0x323F_FFFF   IOC (I/O controller)
0x3400_0000 – 0x37FF_FFFF   ROM (4 MB window)
0x3500_0000 – 0x35FF_FFFF   VIDC (write-only; no frame buffer rendered)
0x36E0_0000 – 0x36FF_FFFF   MEMC control registers
```

ROM is also aliased at address 0 until MEMC releases it (standard Archimedes reset behaviour).

### Native window mode

No VIDC pixel rendering takes place. Instead:

- `Wimp_CreateWindow` → creates a `BrowserWindow` with a canvas renderer
- `Wimp_OpenWindow` → shows and positions the window
- `Wimp_Poll` → suspends the CPU (`swiPending = true`) until a native event arrives, then resumes
- Mouse clicks and key presses in a `BrowserWindow` are sent via IPC to the main process and delivered to the emulated CPU as Wimp events
- The iconbar is a persistent, frameless, always-on-bottom `BrowserWindow`

### Boot sequence

On startup, the emulator scans `assets/programs/` for RISC OS application directories (names beginning with `!`) and boots them in alphabetical order, mirroring the behaviour of the RISC OS Filer when it first opens a directory:

1. If the app has a `!Boot` Obey script, it is executed. This sets system variables (e.g. `AppName$Dir`, `AppName$Path`), registers file type associations, and loads the app's sprites.
2. If the app has no `!Boot` but has a `!Sprites` file, the sprites are loaded directly.

Variables set during boot (e.g. `File$Type_FCA`) remain live for the duration of the session and are visible to any subsequently launched application.

### Sprites

RISC OS sprite files (`.!Sprites`) are parsed and decoded at boot time by `SpritePool` in `packages/risc-os/src/sprite/sprite-pool.ts`.

**File format:**

Sprite files omit the first "area size" word that is present in memory-resident sprite areas. All stored offsets are therefore 4 bytes larger than their file-relative positions.

| Region | Layout |
|---|---|
| Area header | 3 words: num_sprites, first_sprite_mem_offset, free_mem_offset |
| Per-sprite header | 44 bytes: next_offset, name (12 b), width_words−1, height−1, lbit, rbit, img_offset, mask_offset, mode |
| Palette (optional) | Between byte 44 and img_offset; 8 bytes per entry (two flash-colour words) |
| Image data | Packed LSB-first; `lbit` leading bits per row are padding |
| Mask data | 1 bit per pixel, same row width (in words) as image; 1 = opaque |

Colour words use the format: bits 8–15 = red, 16–23 = green, 24–31 = blue.

Default palettes are provided for 1, 2, 4, and 8 bpp modes. An embedded palette in the sprite overrides the default.

**Path-variable resolution:**

The Obey `IconSprites` command supports the RISC OS path-variable syntax (`AppName:filename`). `AppName:` is expanded to the value of the `AppName$Path` system variable before the file is read.

### File system

File I/O SWIs are forwarded to the host OS via a `FileSystemHost` interface. The default implementation (`NodeFsHost`) uses synchronous Node.js `fs` APIs, mirroring the blocking behaviour of real Archimedes hardware.

The RISC OS filing system root (`$`) maps to `~/Documents/RISCOS` on the host. The directory is created automatically on first launch.

**Path translation:**

| RISC OS | Host equivalent |
|---|---|
| `$` | `~/Documents/RISCOS` |
| `$.Apps.Paint` | `~/Documents/RISCOS/Apps/Paint` |
| `@` | current selected directory |
| `^` | parent directory (`..`) |
| `:Volume.$` | volume prefix stripped, treated as `$` |

**File system SWI coverage:**

| SWI | Reason codes implemented |
|---|---|
| `OS_File` | 0 (save block), 5 (stat), 6 (delete), 7 (create), 255 (load) |
| `OS_Find` | 0x40 read, 0x80 write, 0xC0 read/write, 0x00 close |
| `OS_Args` | 0 get ptr, 1 set ptr, 2 get extent, 3 set extent, 255 flush |
| `OS_BGet` | read byte, C=1 on EOF |
| `OS_BPut` | write byte |
| `OS_GBPB` | 1–4 block read/write, 8 directory listing |
| `OS_FSControl` | 26 set CSD, 36 canonicalise path |

### Supported SWIs

**OS core:** `OS_WriteC`, `OS_Write0`, `OS_WriteN`, `OS_NewLine`, `OS_Exit`, `OS_GetEnv`, `OS_Byte`, `OS_Mouse`, `OS_ReadModeVar`, `OS_Heap`, `OS_Module`, `OS_IntOn`, `OS_IntOff`

**File system:** `OS_File`, `OS_Find`, `OS_Args`, `OS_BGet`, `OS_BPut`, `OS_GBPB`, `OS_FSControl`

**Wimp:** `Wimp_Initialise`, `Wimp_CreateWindow`, `Wimp_OpenWindow`, `Wimp_CloseWindow`, `Wimp_DeleteWindow`, `Wimp_Poll`, `Wimp_PollIdle`, `Wimp_RedrawWindow`, `Wimp_UpdateWindow`, `Wimp_GetWindowState`, `Wimp_ForceRedraw`, `Wimp_CreateIcon`, `Wimp_CreateMenu`, `Wimp_ReportError`, `Wimp_GetPointerInfo`, `Wimp_SlotSize`, `Wimp_ReadSysInfo`, `Wimp_SendMessage`, `Wimp_CloseDown`

**Font:** `Font_FindFont`, `Font_LoseFont`, `Font_Paint`, `Font_StringWidth`, `Font_SetFontColours` (stubs)

Unhandled SWIs vector to the ROM exception handler in the normal ARMv2 way.

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
│   │       │   ├── arm2.ts       # CPU core
│   │       │   └── registers.ts  # Register file (R0–R15, PSR)
│   │       ├── memory/
│   │       │   └── bus.ts        # System bus / address decode
│   │       ├── chips/
│   │       │   ├── memc.ts       # Memory controller
│   │       │   ├── ioc.ts        # I/O controller
│   │       │   └── vidc.ts       # Video controller (stub)
│   │       └── machine.ts        # Top-level machine wiring
│   ├── risc-os/
│   │   └── src/
│   │       ├── swi/
│   │       │   ├── dispatcher.ts # Registers all SWI handlers
│   │       │   └── os-core.ts    # OS_* SWI implementations
│   │       ├── fs/
│   │       │   ├── fs-host.ts    # FileSystemHost interface
│   │       │   └── os-fs.ts      # OS_File / OS_Find / OS_Args / OS_BGet / OS_BPut / OS_GBPB / OS_FSControl
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
│           │   ├── index.ts            # Electron main process
│           │   ├── native-wimp-host.ts # NativeHost → BrowserWindow
│           │   ├── node-fs-host.ts     # FileSystemHost → host OS (~/Documents/RISCOS)
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

You need a RISC OS ROM image to run anything. ROM images are copyrighted by RISC OS Open Ltd and are not included here. A legitimate copy can be obtained from [riscosopen.org](https://riscosopen.org).

## Limitations

- No VIDC pixel rendering — applications that draw directly to the frame buffer rather than using Wimp SWIs will not display correctly
- No sound
- Single-tasking (one ARM program at a time)
- No floating-point emulation (FPE)
- File system covers core I/O but not all `OS_FSControl` operations, `OS_Var`, or the FileSwitch module API
