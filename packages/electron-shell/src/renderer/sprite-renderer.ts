/**
 * Sprite rendering helpers for the renderer process.
 *
 * Accepts the IPC-serialised form of a sprite (rgba as plain number[])
 * and renders it onto a canvas element.
 */

/** IPC-safe form of a RISC OS sprite (Uint8ClampedArray serialised as number[]). */
export interface SerialisedSprite {
  name:   string;
  rgba:   number[];
  width:  number;
  height: number;
}

/**
 * Render a serialised sprite into a new <canvas> element scaled to `size` × `size`.
 * Nearest-neighbour scaling preserves the pixel-art look of RISC OS icons.
 */
export function renderSpriteToCanvas(sprite: SerialisedSprite, size: number): HTMLCanvasElement {
  // Decode into a temporary canvas at native resolution
  const tmp = document.createElement("canvas");
  tmp.width  = sprite.width;
  tmp.height = sprite.height;
  const tmpCtx = tmp.getContext("2d")!;
  const imgData = tmpCtx.createImageData(sprite.width, sprite.height);
  imgData.data.set(sprite.rgba);
  tmpCtx.putImageData(imgData, 0, 0);

  // Scale to the requested size
  const canvas = document.createElement("canvas");
  canvas.width  = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, size, size);
  return canvas;
}
