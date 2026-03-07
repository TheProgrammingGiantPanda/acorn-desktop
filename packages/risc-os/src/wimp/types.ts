/**
 * RISC OS Wimp data structures
 *
 * All coordinates are in OS units (1 OS unit = 1/180 inch at 90 DPI → ~2 screen pixels).
 * Windows have a work area (content) and a visible area (what's on screen).
 */

/** Wimp window flags (word at offset 28 in the window definition block) */
export const WF_MOVEABLE        = 1 << 1;
export const WF_HASVSCROLL      = 1 << 2;
export const WF_HASHSCROLL      = 1 << 3;
export const WF_HASADJUST       = 1 << 4;
export const WF_IGNORE_R3       = 1 << 5;
export const WF_PANE            = 1 << 6;
export const WF_AUTO_REDRAW     = 1 << 7;
export const WF_CLOSE_ICON      = 1 << 23;
export const WF_TITLE_BAR       = 1 << 24;
export const WF_TOGGLE_ICON     = 1 << 25;
export const WF_FRONT           = 1 << 26;
export const WF_BACK_ICON       = 1 << 27;
export const WF_HAS_TITLE       = 1 << 24;

/** Icon flags */
export const IF_TEXT            = 1 << 0;
export const IF_SPRITE          = 1 << 1;
export const IF_BORDER          = 1 << 2;
export const IF_HCENTRED        = 1 << 3;
export const IF_VCENTRED        = 1 << 4;
export const IF_FILLED          = 1 << 5;
export const IF_FONT            = 1 << 6;
export const IF_NEEDS_HELP      = 1 << 7;
export const IF_INDIRECTED      = 1 << 8;
export const IF_RJUSTIFIED      = 1 << 9;
export const IF_ALLOW_ADJUST    = 1 << 10;
export const IF_HALF_SIZE       = 1 << 11;
export const IF_BUTTON_TYPE     = 0xF << 12;
export const IF_ESG             = 0x1F << 16;
export const IF_SELECTED        = 1 << 21;
export const IF_SHADED          = 1 << 22;
export const IF_DELETED         = 1 << 23;

/** Wimp event codes returned by Wimp_Poll */
export const enum WimpEvent {
  Null            = 0,
  Redraw          = 1,
  Open            = 2,
  Close           = 3,
  PointerLeave    = 4,
  PointerEnter    = 5,
  Click           = 6,
  UserDrag        = 7,
  KeyPressed      = 8,
  MenuSelection   = 9,
  ScrollRequest   = 10,
  LoseCaretEv     = 11,
  GainCaretEv     = 12,
  PollWordNonZero = 13,
  UserMessage     = 17,
  UserMessageRecorded = 18,
  UserMessageAck  = 19,
}

/** Wimp message action codes */
export const enum WimpMsg {
  Quit          = 0,
  DataSave      = 1,
  DataSaveAck   = 2,
  DataLoad      = 3,
  DataLoadAck   = 4,
  DataOpen      = 5,
  RamFetch      = 6,
  RamTransmit   = 7,
  PreQuit       = 8,
  PaletteChange = 9,
  SaveDesktop   = 10,
  DeviceClaim   = 11,
  DeviceInUse   = 12,
  DataSaved     = 13,
  FilerOpenDir  = 14,
  FilerCloseDir = 15,
  MenuWarning   = 0x400C0,
  ModeChange    = 0x400C1,
  TaskInitialise = 0x400C2,
  TaskCloseDown  = 0x400C3,
  SlotSize      = 0x400C4,
  SetSlot       = 0x400C5,
  TaskNameRq    = 0x400C6,
  TaskNameIs    = 0x400C7,
}

export interface WimpWindowDef {
  /** Visible area in screen coordinates (OS units) */
  visX0: number; visY0: number; visX1: number; visY1: number;
  /** Scroll offsets */
  scrollX: number; scrollY: number;
  /** Window to open behind (-1 = top, -2 = bottom) */
  behind: number;
  flags: number;
  /** Title foreground/background colours */
  titleFg: number; titleBg: number;
  /** Work area foreground/background colours */
  workFg: number; workBg: number;
  scrollBarOuterColour: number; scrollBarInnerColour: number;
  titleBarHighlightColour: number;
  /** Work area extent */
  workX0: number; workY0: number; workX1: number; workY1: number;
  titleFlags: number;
  workAreaButtonType: number;
  spriteArea: number;
  minWidth: number; minHeight: number;
  /** Title bar string (if text title) */
  title: string;
  numIcons: number;
}

export interface WimpIcon {
  x0: number; y0: number; x1: number; y1: number;
  flags: number;
  text: string;
  sprite: string;
  validation: string;
  maxLen: number;
}

export interface WimpWindow {
  handle: number;
  def: WimpWindowDef;
  icons: Map<number, WimpIcon>;
  open: boolean;
  /** Tracks last-drawn state for redraw events */
  dirty: boolean;
}

/** A queued Wimp event to be delivered via Wimp_Poll */
export interface WimpPollEvent {
  code: WimpEvent;
  /** Data block to write into the buffer pointed to by R1 */
  data: number[];
}

/** OS unit ↔ pixel conversion (assume 90 DPI, 2px per OS unit) */
export function osUnitsToPx(osUnits: number): number {
  return Math.round(osUnits / 2);
}
export function pxToOsUnits(px: number): number {
  return px * 2;
}
