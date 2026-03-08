/**
 * HostFS browser renderer
 *
 * Displays RISC OS HostFS directory contents as icon tiles.
 * Supports navigation, launching apps and opening sub-directories.
 */

export {};

interface DirEntry {
  name:   string;
  isDir:  boolean;
  isApp:  boolean;
  sprite?: { rgba: number[]; width: number; height: number };
}

declare global {
  interface Window {
    hostfsBrowser: {
      listDir: (riscosPath: string) => Promise<DirEntry[]>;
      launch:  (riscosPath: string) => Promise<void>;
      openDir: (riscosPath: string) => Promise<void>;
    };
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const params  = new URLSearchParams(window.location.search);
let   curPath = params.get("path") ?? "HostFS::$";

const grid        = document.getElementById("grid")!;
const emptyEl     = document.getElementById("empty")!;
const pathDisplay = document.getElementById("path-display")!;
const btnUp       = document.getElementById("btn-up") as HTMLButtonElement;

let selectedEntry: HTMLElement | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render a sprite into a 34×34 canvas and return the element. */
function spriteToCanvas(rgba: number[], width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width  = width;
  canvas.height = height;
  canvas.style.width  = "34px";
  canvas.style.height = "34px";
  canvas.style.imageRendering = "pixelated";
  const ctx = canvas.getContext("2d")!;
  const imgData = ctx.createImageData(width, height);
  imgData.data.set(rgba);
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

/** Folder icon placeholder (unicode folder emoji). */
function folderIcon(): HTMLElement {
  const el = document.createElement("div");
  el.className = "icon-placeholder";
  el.textContent = "\u{1F4C1}"; // folder emoji
  return el;
}

/** Document icon placeholder. */
function fileIcon(): HTMLElement {
  const el = document.createElement("div");
  el.className = "icon-placeholder";
  el.textContent = "\u{1F4C4}"; // page emoji
  return el;
}

/** App fallback icon (grey square with "!"). */
function appIcon(): HTMLElement {
  const canvas = document.createElement("canvas");
  canvas.width  = 34;
  canvas.height = 34;
  canvas.style.width  = "34px";
  canvas.style.height = "34px";
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#b0b0c8";
  ctx.fillRect(0, 0, 34, 34);
  ctx.strokeStyle = "#606080";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, 33, 33);
  ctx.fillStyle = "#202060";
  ctx.font = "bold 18px serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("!", 17, 18);
  return canvas;
}

/** Parent of a HostFS path: "HostFS::$.Dir.Sub" → "HostFS::$.Dir" */
function parentPath(p: string): string | null {
  const dotIdx = p.lastIndexOf(".");
  if (dotIdx <= 0) return null;
  const parent = p.slice(0, dotIdx);
  // Don't go above "HostFS::$"
  return parent.endsWith("HostFS::") ? "HostFS::$" : parent;
}

/** Child path: "HostFS::$.Dir" + "Sub" → "HostFS::$.Dir.Sub" */
function childPath(parent: string, name: string): string {
  if (parent === "HostFS::$") return `HostFS::$.${name}`;
  return `${parent}.${name}`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function buildEntryEl(entry: DirEntry): HTMLElement {
  const el = document.createElement("div");
  el.className = "entry";

  let iconEl: HTMLElement | HTMLCanvasElement;
  if (entry.sprite) {
    iconEl = spriteToCanvas(entry.sprite.rgba, entry.sprite.width, entry.sprite.height);
  } else if (entry.isApp) {
    iconEl = appIcon();
  } else if (entry.isDir) {
    iconEl = folderIcon();
  } else {
    iconEl = fileIcon();
  }
  el.appendChild(iconEl);

  const nameEl = document.createElement("div");
  nameEl.className = "entry-name";
  nameEl.textContent = entry.name;
  el.appendChild(nameEl);

  // Single click — select
  el.addEventListener("click", () => {
    if (selectedEntry) selectedEntry.classList.remove("selected");
    el.classList.add("selected");
    selectedEntry = el;
  });

  // Double click — open dir or launch app
  el.addEventListener("dblclick", async () => {
    const target = childPath(curPath, entry.name);
    if (entry.isDir) {
      if (entry.isApp) {
        // Open a new hostfs-browser window for this app dir
        await window.hostfsBrowser.openDir(target);
      } else {
        // Navigate within this window
        navigateTo(target);
      }
    } else {
      // File — try to launch it
      await window.hostfsBrowser.launch(target);
    }
  });

  return el;
}

async function navigateTo(riscosPath: string): Promise<void> {
  curPath = riscosPath;
  pathDisplay.textContent = curPath;
  selectedEntry = null;

  // Update Up button state
  btnUp.disabled = parentPath(curPath) === null;

  let entries: DirEntry[] = [];
  try {
    entries = await window.hostfsBrowser.listDir(curPath) as DirEntry[];
  } catch (err) {
    console.error("listDir failed:", err);
  }

  // Clear grid (keep empty placeholder)
  while (grid.firstChild) grid.removeChild(grid.firstChild);
  grid.appendChild(emptyEl);

  if (entries.length === 0) {
    emptyEl.style.display = "block";
    return;
  }
  emptyEl.style.display = "none";

  for (const entry of entries) {
    grid.appendChild(buildEntryEl(entry));
  }
}

// ---------------------------------------------------------------------------
// Up button
// ---------------------------------------------------------------------------
btnUp.addEventListener("click", () => {
  const parent = parentPath(curPath);
  if (parent) navigateTo(parent);
});

// ---------------------------------------------------------------------------
// Initial load
// ---------------------------------------------------------------------------
navigateTo(curPath);
