export {};

import { type SerialisedSprite, renderSpriteToCanvas } from "./sprite-renderer.js";

interface IconbarEntry {
  sprite: string;
  text: string;
  spriteData?: SerialisedSprite;
}

declare global {
  interface Window {
    iconbar: {
      onUpdate: (cb: (entries: [number, IconbarEntry][]) => void) => void;
      click: (taskHandle: number, buttons: number) => void;
    };
  }
}

const iconsEl = document.getElementById("icons")!;
const clockEl = document.getElementById("clock")!;

function updateClock(): void {
  const now = new Date();
  clockEl.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
updateClock();
setInterval(updateClock, 10_000);

window.iconbar.onUpdate((entries) => {
  iconsEl.innerHTML = "";
  for (const [taskHandle, { sprite, text, spriteData }] of entries) {
    const entry = document.createElement("div");
    entry.className = "icon-entry";

    const spriteEl = document.createElement("div");
    spriteEl.className = "icon-sprite";
    spriteEl.title = text;

    if (spriteData) {
      spriteEl.appendChild(renderSpriteToCanvas(spriteData, 34));
    } else {
      spriteEl.textContent = sprite.slice(0, 1).toUpperCase();
    }

    const labelEl = document.createElement("div");
    labelEl.className = "icon-label";
    labelEl.textContent = text;

    entry.appendChild(spriteEl);
    entry.appendChild(labelEl);

    entry.addEventListener("click", (e) => {
      const buttons = e.button === 2 ? 2 : (e.button === 1 ? 2 : 4);
      window.iconbar.click(taskHandle, buttons);
    });
    entry.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      window.iconbar.click(taskHandle, 2);
    });
    iconsEl.appendChild(entry);
  }
});
