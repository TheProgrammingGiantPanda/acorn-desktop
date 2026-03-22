// Shared types for the Acorn Archimedes emulator

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
export type LogLevel = 'debug' | 'info' | 'error' | 'silent';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, error: 2, silent: 3 };

export class Logger {
  constructor(readonly level: LogLevel = 'silent') {}

  debug(msg: string): void {
    if (LEVELS[this.level] <= 0) console.debug(msg);
  }

  info(msg: string): void {
    if (LEVELS[this.level] <= 1) console.info(msg);
  }

  error(msg: string): void {
    if (LEVELS[this.level] <= 2) console.error(msg);
  }
}

export type MachineModel = "A305" | "A310" | "A410" | "A3000" | "A5000";

export interface MachineConfig {
  model: MachineModel;
  /** RAM in bytes (512KB, 1MB, 2MB, 4MB, 8MB, 16MB) */
  ramSize: number;
  /** Path to RISC OS ROM image */
  romPath?: string;
  /** CPU speed multiplier (1.0 = real time ~8MHz ARM2, ~25MHz ARM3) */
  speedMultiplier: number;
  /** ARM chip variant */
  cpuVariant: "ARM2" | "ARM3";
}

export interface DisplayConfig {
  zoom: 1 | 2 | 3 | 4;
  fullscreen: boolean;
}

export interface EmulatorState {
  running: boolean;
  paused: boolean;
  fps: number;
  mhz: number;
  model: MachineModel;
}

/** IPC channel names between main and renderer */
export const IPC = {
  // Renderer -> Main
  LOAD_ROM: "emulator:load-rom",
  LOAD_DISK: "emulator:load-disk",
  RESET: "emulator:reset",
  PAUSE: "emulator:pause",
  RESUME: "emulator:resume",
  SET_ZOOM: "emulator:set-zoom",
  SET_SPEED: "emulator:set-speed",
  DRAG_FILE: "emulator:drag-file",

  // Main -> Renderer
  STATE_UPDATE: "emulator:state-update",
  ROM_LOADED: "emulator:rom-loaded",
  DISK_LOADED: "emulator:disk-loaded",
  ERROR: "emulator:error",
  FRAME_READY: "emulator:frame-ready",

  // HostFS browser
  HOSTFS_LIST_DIR:  "hostfs:list-dir",
  HOSTFS_LAUNCH:    "hostfs:launch",
  HOSTFS_OPEN_DIR:  "hostfs:open-dir",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

export interface DirEntry {
  name:   string;   // bare filename, e.g. "!SciCalc" or "Documents"
  isDir:  boolean;
  isApp:  boolean;  // starts with "!"
  sprite?: {
    rgba:   number[];  // flat RGBA Uint8ClampedArray serialised as plain array
    width:  number;
    height: number;
  };
}

export interface RomLoadedPayload {
  path: string;
  sizeBytes: number;
}

export interface DiskLoadedPayload {
  path: string;
  name: string;
  sizeBytes: number;
}

export interface FramePayload {
  /** RGBA pixel data */
  buffer: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface ErrorPayload {
  message: string;
  fatal: boolean;
}
