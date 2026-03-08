/**
 * Programs browser renderer
 * Shows !App directories from assets/programs/ as icon tiles.
 */

import type { AppEntry } from "@theprogramminggiantpanda/shared";

declare global {
  interface Window {
    programsBrowser: {
      listApps:   ()                           => Promise<AppEntry[]>;
      launchApp:  (name: string)               => Promise<void>;
      installApp: (hostPath: string)           => Promise<{ ok: boolean; error?: string }>;
      onRefresh:  (cb: () => void)             => () => void;
    };
  }
}

const grid      = document.getElementById("grid")!;
const emptyEl   = document.getElementById("empty")!;
const statusbar = document.getElementById("statusbar")!;

/** Convert a flat RGBA array + dimensions to a 34×34 canvas data URL. */
function spriteToDataURL(rgba: number[], width: number, height: number): string {
  const canvas = document.createElement("canvas");
  canvas.width  = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const imgData = ctx.createImageData(width, height);
  imgData.data.set(rgba);
  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL();
}

/** Generic fallback icon — a simple grey square with an "A". */
function genericIconDataURL(): string {
  const canvas = document.createElement("canvas");
  canvas.width  = 34;
  canvas.height = 34;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#c0c0c0";
  ctx.fillRect(0, 0, 34, 34);
  ctx.strokeStyle = "#808080";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, 33, 33);
  ctx.fillStyle = "#404040";
  ctx.font = "bold 18px serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("A", 17, 18);
  return canvas.toDataURL();
}

let selectedTile: HTMLElement | null = null;

function buildTile(app: AppEntry): HTMLElement {
  const iconURL = app.sprite
    ? spriteToDataURL(app.sprite.rgba, app.sprite.width, app.sprite.height)
    : genericIconDataURL();

  const tile = document.createElement("div");
  tile.className = "tile";
  tile.dataset.name = app.name;

  const img = document.createElement("img");
  img.className = "tile-icon";
  img.src  = iconURL;
  img.alt  = app.displayName;
  img.draggable = false;

  const label = document.createElement("div");
  label.className = "tile-name";
  label.textContent = app.displayName;

  tile.appendChild(img);
  tile.appendChild(label);

  tile.addEventListener("click", () => {
    if (selectedTile) selectedTile.classList.remove("selected");
    tile.classList.add("selected");
    selectedTile = tile;
    statusbar.textContent = app.name;
  });

  tile.addEventListener("dblclick", async () => {
    statusbar.textContent = `Launching ${app.name}…`;
    tile.style.opacity = "0.6";
    try {
      await window.programsBrowser.launchApp(app.name);
      statusbar.textContent = `${app.name} launched`;
    } catch (err) {
      statusbar.textContent = `Error: ${String(err)}`;
    } finally {
      tile.style.opacity = "";
    }
  });

  return tile;
}

async function refresh(): Promise<void> {
  statusbar.textContent = "Loading…";
  try {
    const apps = await window.programsBrowser.listApps();
    grid.innerHTML = "";
    selectedTile = null;

    if (apps.length === 0) {
      emptyEl.classList.add("visible");
      statusbar.textContent = "No applications found";
      return;
    }
    emptyEl.classList.remove("visible");

    for (const app of apps) {
      grid.appendChild(buildTile(app));
    }
    statusbar.textContent = `${apps.length} application${apps.length === 1 ? "" : "s"}`;
  } catch (err) {
    statusbar.textContent = `Error: ${String(err)}`;
  }
}

// Drag-and-drop install
document.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer!.dropEffect = "copy";
  document.body.classList.add("drag-over");
});
document.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) document.body.classList.remove("drag-over");
});
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  document.body.classList.remove("drag-over");
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  const filePath = (file as File & { path: string }).path;
  statusbar.textContent = `Installing ${file.name}…`;
  const result = await window.programsBrowser.installApp(filePath);
  if (result.ok) {
    statusbar.textContent = `Installed ${file.name}`;
    await refresh();
  } else {
    statusbar.textContent = `Install failed: ${result.error ?? "unknown error"}`;
  }
});

// Listen for main-process refresh signal
window.programsBrowser.onRefresh(() => refresh());

// Initial load
refresh();
