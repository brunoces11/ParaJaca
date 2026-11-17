// Player integration tests: real scene validation, sources, optics, motion, and layout.
// DOM, bitmap decoding, and GPU drawing are simulated; these do not replace visual GPU checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

/** @typedef {import('../src/core/render/renderer.js').FrameState} FrameState */
/** @typedef {import('../src/core/scene/model.js').Scene} Scene */

const rendererUrl = new URL('../src/core/render/renderer.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url !== rendererUrl) return nextLoad(url, context);
    return {
      format: 'module', shortCircuit: true,
      source: `
        export function createRenderer() { return globalThis.__parajacaTestRenderer; }
        export function createFrameState() {
          return {
            layerCount: 0, layerIds: new Array(11).fill(''), rects: new Float32Array(44),
            lods: new Float32Array(11), opacities: new Float32Array(11),
            outlineFlags: new Uint8Array(11),
          };
        }
      `,
    };
  },
});
const { createPlayer } = await import('../src/core/player.js');
hooks.deregister();

/** Creates only the DOM surface used by the player. */
function createElement() {
  return Object.assign(new EventTarget(), {
    style: { cssText: '', display: '' }, innerHTML: '', className: '', alt: '', tabIndex: 0,
    clientWidth: 1920, clientHeight: 1080, width: 1920, height: 1080,
    appendChild() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 1920, height: 1080 }; },
  });
}

function createHarness() {
  const windowTarget = Object.assign(new EventTarget(), { devicePixelRatio: 1 });
  /** @type {Map<number, FrameRequestCallback>} */
  const callbacks = new Map();
  let nextId = 0;
  let timestampMs = 0;
  /** @type {FrameState | null} */
  let drawn = null;
  let preparedCount = 0;
  const renderer = {
    setViewport(cssWidth = 1920, cssHeight = 1080, dpr = 1, renderScale = 1) {
      return {
        widthRender: Math.round(cssWidth * dpr * renderScale),
        heightRender: Math.round(cssHeight * dpr * renderScale),
      };
    },
    getLimits() { return { maxTextureSize: 4096 }; },
    prepareLayer() { preparedCount++; return Promise.resolve(); },
    /** @param {FrameState} frame */
    draw(frame) { drawn = structuredClone(frame); },
    dispose() {},
  };
  const globals = {
    window: windowTarget,
    document: Object.assign(new EventTarget(), {
      createElement, documentElement: new EventTarget(), baseURI: 'http://localhost/demo/',
      visibilityState: 'visible',
    }),
    ResizeObserver: undefined,
    IntersectionObserver: undefined,
    /** @param {FrameRequestCallback} callback */
    requestAnimationFrame(callback) { callbacks.set(++nextId, callback); return nextId; },
    /** @param {number} id */
    cancelAnimationFrame(id) { callbacks.delete(id); },
    async createImageBitmap(
      /** @type {Blob} */ _blob, _x = 0, _y = 0, _width = 1, _height = 1,
      options = { resizeWidth: 1, resizeHeight: 1 },
    ) {
      return { width: options.resizeWidth, height: options.resizeHeight, close() {} };
    },
    __parajacaTestRenderer: renderer,
  };
  const originals = Object.keys(globals).map((name) => ({
    name, descriptor: Object.getOwnPropertyDescriptor(globalThis, name),
  }));
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  // The fake element deliberately implements only the surface consumed by createPlayer.
  const container = /** @type {HTMLElement} */ (/** @type {unknown} */ (createElement()));
  const player = createPlayer(container, { assetResolver: () => new Blob(['test']) });
  /** @type {unknown[]} */
  const errors = [];
  player.on('error', (error) => errors.push(error));
  return {
    player, errors,
    flush() {
      let steps = 0;
      while (callbacks.size > 0 && steps++ < 500) {
        const pending = [...callbacks.values()];
        callbacks.clear();
        timestampMs += 16;
        pending.forEach((callback) => callback(timestampMs));
      }
      assert.equal(callbacks.size, 0, 'animation must converge');
    },
    /** @param {{ x: number, y: number }} position */
    pointAt({ x, y }) {
      const event = new Event('pointermove');
      Object.assign(event, { clientX: x, clientY: y });
      windowTarget.dispatchEvent(event);
    },
    getFrame() { assert.ok(drawn); return drawn; },
    getPreparedCount() { return preparedCount; },
    cleanup() {
      player.dispose();
      for (const { name, descriptor } of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

/** @returns {Scene} */
function createScene() {
  const sizes = [[1920, 1080], [3000, 1080], [640, 480], [1080, 3000]];
  return {
    formatVersion: 1, id: 'scene', name: 'Mixed sizes', reference: { width: 1920, height: 1080 },
    pointOfInterest: { x: 0.5, y: 0.5 }, posterAssetId: null, defaultVariantId: 'variant',
    assets: sizes.map(([width, height], index) => ({
      id: `asset-${index}`, name: `Image ${index}`, type: 'png', width, height,
      path: `assets/${index}.png`,
    })),
    variants: [{
      id: 'variant', name: 'Default',
      layers: sizes.map((_, order) => ({
        id: `layer-${order}`, assetId: `asset-${order}`, order, depth: null,
        focusMode: 'dynamic', fixedBlur: 0,
        placement: { x: 0, y: 0, width: 1920, height: 1080 },
      })),
      optics: {
        focus: 50, aperture: 2.8, tolerance: 5, maxBlur: 24,
        focusRange: [0, 100], focusSpeed: 0.5, breathing: 0,
      },
      motion: { intensity: 80, smoothing: 0.5, axisY: true, anchor: 'infinity', drift: false },
      quality: { preset: 'high', fpsTarget: 60 },
    }],
  };
}

test('player draws mixed native sizes and reaches 400px without zoom or edge clamps', async (t) => {
  const h = createHarness();
  t.after(h.cleanup);
  await h.player.load(createScene());
  h.flush();
  const before = h.getFrame();
  assert.deepEqual([...before.rects.slice(0, 16)], [
    0, 0, 1920, 1080, 0, 0, 3000, 1080, 0, 0, 640, 480, 0, 0, 1080, 3000,
  ]);
  h.player.setIntensity(400, 250);
  h.pointAt({ x: 1920, y: 1080 });
  h.flush();
  h.player.resize();
  h.flush();
  const after = h.getFrame();
  assert.equal(after.rects[0], 0);
  assert.equal(after.rects[1], 0);
  assert.equal(after.rects[12], -400);
  assert.equal(after.rects[13], -250);
  assert.equal(after.rects[6], 3000);
  assert.equal(after.rects[15], 3000);
  assert.deepEqual(h.errors, []);
});

test('live percentages group movement without changing blur or rebuilding textures', async (t) => {
  const h = createHarness();
  t.after(h.cleanup);
  await h.player.load(createScene());
  h.flush();
  const before = h.getFrame();
  for (const layerId of ['layer-1', 'layer-2']) {
    await h.player.edit({ type: 'set-layer', layerId, changesLayer: { parallaxPercent: 70 } });
  }
  h.player.setIntensity(400, 100);
  h.pointAt({ x: 1920, y: 1080 });
  h.flush();
  h.player.resize();
  h.flush();
  const after = h.getFrame();
  assert.equal(after.rects[4], -280);
  assert.equal(after.rects[8], -280);
  assert.equal(after.rects[5], -70);
  assert.equal(after.rects[9], -70);
  assert.deepEqual(after.lods, before.lods);
  h.player.setFocus(0, { animate: false });
  h.flush();
  assert.deepEqual(h.getFrame().rects, after.rects);
  h.player.setFocus(100, { animate: false });
  h.flush();
  assert.deepEqual(h.getFrame().rects, after.rects);
  assert.equal(h.getPreparedCount(), 4);
  assert.deepEqual(h.errors, []);
});

test('replacement and quality changes retain native geometry, X/Y, and percentage', async (t) => {
  const h = createHarness();
  t.after(h.cleanup);
  await h.player.load(createScene());
  await h.player.edit({
    type: 'set-layer', layerId: 'layer-1',
    changesLayer: {
      placement: { x: -2500, y: 1900, width: 3000, height: 1080 }, parallaxPercent: 45,
    },
  });
  const replacement = h.player.getScene();
  replacement.assets[1].width = 800;
  replacement.assets[1].height = 1600;
  await h.player.load(replacement);
  h.flush();
  const layer = h.player.getScene().variants[0].layers[1];
  assert.deepEqual(layer.placement, { x: -2500, y: 1900, width: 800, height: 1600 });
  assert.equal(layer.parallaxPercent, 45);
  assert.deepEqual([...h.getFrame().rects.slice(4, 8)], [-2500, 1900, 800, 1600]);
  h.player.setQuality('low');
  h.flush();
  const frame = h.getFrame();
  assert.equal(frame.rects[6] / frame.rects[7], 0.5);
  assert.equal(h.player.getScene().variants[0].layers[1].parallaxPercent, 45);
  assert.deepEqual(h.errors, []);
});

test('invalid percentage edits are rejected without moving or changing the layer', async (t) => {
  const h = createHarness();
  t.after(h.cleanup);
  await h.player.load(createScene());
  const before = h.player.getScene();
  await h.player.edit({
    type: 'set-layer', layerId: 'layer-1',
    changesLayer: {
      placement: { x: 1500, y: 0, width: 3000, height: 1080 }, parallaxPercent: 101,
    },
  });
  assert.equal(h.errors.length, 1);
  assert.deepEqual(h.player.getScene(), before);
});
