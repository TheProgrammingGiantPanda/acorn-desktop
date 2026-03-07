export {};

declare global {
  interface Window {
    iconbar: {
      onUpdate: (cb: (entries: [number, { sprite: string; text: string }][]) => void) => void;
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
  for (const [taskHandle, { sprite, text }] of entries) {
    const entry = document.createElement("div");
    entry.className = "icon-entry";
    entry.innerHTML = `
      <div class="icon-sprite" title="${text}">
        ${sprite === "application" ? "🖥" : sprite.slice(0, 1).toUpperCase()}
      </div>
      <div class="icon-label">${text}</div>
    `;
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
