// Low-resolution alpha masks for silhouette hit tests (R§15.4).
// computeAlphaMask reads pixels once at load time; sampleMask is pure and allocation-free (hot path).

import { ParaJacaError, ERROR_CODES } from '../errors.js';

/** @typedef {import('./image-source.js').AlphaMask} AlphaMask */

export const MASK_MAX_SIDE = 512; // calibrate

/**
 * Copies the alpha channel of an image into a mask whose longest side is
 * min(MASK_MAX_SIDE, longest side of the source).
 * @param {CanvasImageSource} imageSource
 * @param {number} width   source width (px of the image source)
 * @param {number} height  source height (px of the image source)
 * @returns {AlphaMask}
 */
export function computeAlphaMask(imageSource, width, height) {
  const scale = Math.min(1, MASK_MAX_SIDE / Math.max(width, height));
  const maskWidth = Math.max(1, Math.round(width * scale));
  const maskHeight = Math.max(1, Math.round(height * scale));
  const canvas = new OffscreenCanvas(maskWidth, maskHeight);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new ParaJacaError(ERROR_CODES.ASSET_LOAD_FAILED, 'Canvas 2D unavailable for alpha mask');
  ctx.drawImage(imageSource, 0, 0, maskWidth, maskHeight);
  const pixels = ctx.getImageData(0, 0, maskWidth, maskHeight).data;
  const data = new Uint8Array(maskWidth * maskHeight);
  for (let i = 0; i < data.length; i++) {
    data[i] = pixels[i * 4 + 3];
  }
  return { width: maskWidth, height: maskHeight, data };
}

/**
 * Reports whether any mask cell within radiusCells of (u, v) has alpha > 0.
 * u and v are 0–1 over the mask (v = 0 is the top row); a point outside the mask still
 * hits cells inside the radius.
 * @param {AlphaMask} mask
 * @param {number} u
 * @param {number} v
 * @param {number} radiusCells
 * @returns {boolean}
 */
export function sampleMask(mask, u, v, radiusCells) {
  const xCell = u * mask.width;
  const yCell = v * mask.height;
  const radius = Math.max(0, radiusCells);
  if (!Number.isFinite(xCell) || !Number.isFinite(yCell) || !Number.isFinite(radius)) return false;
  // Cell x spans [x, x + 1]; keep every cell whose span comes within the radius.
  const xMin = Math.max(0, Math.ceil(xCell - radius - 1));
  const xMax = Math.min(mask.width - 1, Math.floor(xCell + radius));
  const yMin = Math.max(0, Math.ceil(yCell - radius - 1));
  const yMax = Math.min(mask.height - 1, Math.floor(yCell + radius));
  const radiusSq = radius * radius;
  for (let y = yMin; y <= yMax; y++) {
    // Distance from the point to the nearest edge of the cell (0 when the point is on or inside it).
    const dy = Math.max(y - yCell, 0, yCell - (y + 1));
    for (let x = xMin; x <= xMax; x++) {
      const dx = Math.max(x - xCell, 0, xCell - (x + 1));
      if (dx * dx + dy * dy <= radiusSq && mask.data[y * mask.width + x] > 0) return true;
    }
  }
  return false;
}
