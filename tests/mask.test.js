import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MASK_MAX_SIDE, computeAlphaMask, sampleMask } from '../src/core/sources/mask.js';

/** @typedef {import('../src/core/sources/image-source.js').AlphaMask} AlphaMask */

/**
 * 4x2 mask with a single opaque cell at column 2, row 1.
 * @returns {AlphaMask}
 */
function createMask() {
  const data = new Uint8Array(8);
  data[1 * 4 + 2] = 200;
  return { width: 4, height: 2, data };
}

test('sampleMask hits an opaque cell and misses transparent cells without radius', () => {
  const mask = createMask();
  assert.equal(sampleMask(mask, 2.5 / 4, 1.5 / 2, 0), true);
  assert.equal(sampleMask(mask, 0.5 / 4, 0.5 / 2, 0), false);
  assert.equal(sampleMask(mask, 1.5 / 4, 1.5 / 2, 0), false);
});

test('sampleMask radius reaches nearby cells by distance to the cell edge', () => {
  const mask = createMask();
  // Point centered in cell (1, 1): 0.5 cell from the opaque cell's left edge.
  assert.equal(sampleMask(mask, 1.5 / 4, 1.5 / 2, 0.49), false);
  assert.equal(sampleMask(mask, 1.5 / 4, 1.5 / 2, 0.5), true);
  // Diagonal neighbour (1, 0): corner distance is sqrt(0.5² + 0.5²).
  assert.equal(sampleMask(mask, 1.5 / 4, 0.5 / 2, 0.7), false);
  assert.equal(sampleMask(mask, 1.5 / 4, 0.5 / 2, 0.71), true);
});

test('sampleMask outside the mask only hits within the radius', () => {
  const mask = createMask();
  assert.equal(sampleMask(mask, 2.5 / 4, 1.2, 0), false);
  assert.equal(sampleMask(mask, 2.5 / 4, 2.4 / 2, 0.45), true);
  assert.equal(sampleMask(mask, 1, 1.5 / 2, 0), false, 'right edge of a transparent cell');
  assert.equal(sampleMask(mask, 3 / 4, 1.5 / 2, 0), true, 'shared edge counts for both cells');
  assert.equal(sampleMask(mask, -1, 0.5, 2), false);
  assert.equal(sampleMask(mask, Number.NaN, 0.5, 2), false);
  assert.equal(sampleMask(mask, 2.5 / 4, 1.5 / 2, -3), true, 'negative radius behaves as 0');
});

test('computeAlphaMask caps the longest side and copies only the alpha channel', (t) => {
  /** @type {{ width: number, height: number }[]} */
  const created = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas');
  Object.defineProperty(globalThis, 'OffscreenCanvas', {
    configurable: true, writable: true,
    value: class {
      /** @param {number} width @param {number} height */
      constructor(width, height) { created.push({ width, height }); }
      getContext() {
        return {
          drawImage() {},
          /** @param {number} _x @param {number} _y @param {number} width @param {number} height */
          getImageData(_x, _y, width, height) {
            const data = new Uint8ClampedArray(width * height * 4);
            for (let i = 0; i < width * height; i++) {
              data[i * 4] = 255;
              data[i * 4 + 3] = i % 2 === 0 ? 0 : 128;
            }
            return { data };
          },
        };
      }
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'OffscreenCanvas', original);
    else Reflect.deleteProperty(globalThis, 'OffscreenCanvas');
  });
  const source = /** @type {CanvasImageSource} */ (/** @type {unknown} */ ({}));
  const large = computeAlphaMask(source, 1920, 1080);
  assert.deepEqual([large.width, large.height], [MASK_MAX_SIDE, 288]);
  assert.deepEqual([...large.data.slice(0, 4)], [0, 128, 0, 128]);
  const small = computeAlphaMask(source, 100, 3000);
  assert.deepEqual([small.width, small.height], [17, MASK_MAX_SIDE]);
  const tiny = computeAlphaMask(source, 40, 20);
  assert.deepEqual([tiny.width, tiny.height], [40, 20], 'never upscales');
  assert.deepEqual(created.length, 3);
});
