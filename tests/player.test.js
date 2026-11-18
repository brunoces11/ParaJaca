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

/** @typedef {(u: number, v: number) => number} AlphaAt alpha 0–255 at 0–1 image coordinates */

/**
 * @param {{ alphaByLoad?: AlphaAt[] }} [options] alpha of each decoded bitmap, in load order
 *   (back to front); missing entries are fully opaque.
 */
function createHarness({ alphaByLoad = [] } = {}) {
  const windowTarget = Object.assign(new EventTarget(), { devicePixelRatio: 1 });
  /** @type {ReturnType<typeof createElement> | null} */
  let canvasElement = null;
  const documentTarget = Object.assign(new EventTarget(), {
    /** @param {string} tag */
    createElement(tag) {
      const element = createElement();
      if (tag === 'canvas') canvasElement = element;
      return element;
    },
    documentElement: new EventTarget(), baseURI: 'http://localhost/demo/',
    visibilityState: 'visible',
  });
  let loadIndex = 0;
  /** @type {IntersectionObserverCallback | null} */
  let intersectionCallback = null;
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
    releaseLayer() {},
    /** @param {FrameState} frame */
    draw(frame) { drawn = structuredClone(frame); },
    dispose() {},
  };
  const globals = {
    window: windowTarget,
    document: documentTarget,
    ResizeObserver: undefined,
    IntersectionObserver: class {
      /** @param {IntersectionObserverCallback} callback */
      constructor(callback) { intersectionCallback = callback; }
      observe() {}
      disconnect() {}
    },
    /** @param {FrameRequestCallback} callback */
    requestAnimationFrame(callback) { callbacks.set(++nextId, callback); return nextId; },
    /** @param {number} id */
    cancelAnimationFrame(id) { callbacks.delete(id); },
    async createImageBitmap(
      /** @type {Blob} */ _blob, _x = 0, _y = 0, _width = 1, _height = 1,
      options = { resizeWidth: 1, resizeHeight: 1 },
    ) {
      const alphaAt = alphaByLoad[loadIndex++] ?? (() => 255);
      return { width: options.resizeWidth, height: options.resizeHeight, alphaAt, close() {} };
    },
    // Rasterizes the fake bitmap's alphaAt into the mask read by computeAlphaMask.
    OffscreenCanvas: class {
      constructor() {
        /** @type {AlphaAt} */
        this.alphaAt = () => 255;
      }
      getContext() {
        return {
          /** @param {{ alphaAt: AlphaAt }} source */
          drawImage: (source) => { this.alphaAt = source.alphaAt; },
          /** @param {number} _x @param {number} _y @param {number} width @param {number} height */
          getImageData: (_x, _y, width, height) => {
            const data = new Uint8ClampedArray(width * height * 4);
            for (let y = 0; y < height; y++) {
              for (let x = 0; x < width; x++) {
                data[(y * width + x) * 4 + 3] = this.alphaAt((x + 0.5) / width, (y + 0.5) / height);
              }
            }
            return { data };
          },
        };
      }
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
    /** Runs only the frames already requested. */
    step() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      timestampMs += 16;
      pending.forEach((callback) => callback(timestampMs));
    },
    /** @param {{ x: number, y: number, isOverCanvas?: boolean }} position */
    pointAt({ x, y, isOverCanvas = false }) {
      const event = new Event('pointermove');
      Object.assign(event, { clientX: x, clientY: y });
      // The pointer listener is on the window; target tells whether the scene is under the pointer.
      if (isOverCanvas) Object.defineProperty(event, 'target', { value: canvasElement });
      windowTarget.dispatchEvent(event);
    },
    getFrame() { assert.ok(drawn); return drawn; },
    getPreparedCount() { return preparedCount; },
    getPendingFrames() { return callbacks.size; },
    /** @param {boolean} hidden */
    setHidden(hidden) {
      documentTarget.visibilityState = hidden ? 'hidden' : 'visible';
      documentTarget.dispatchEvent(new Event('visibilitychange'));
    },
    /** @param {boolean} visible */
    setIntersecting(visible) {
      assert.ok(intersectionCallback);
      intersectionCallback([
        /** @type {IntersectionObserverEntry} */ (/** @type {unknown} */ ({ isIntersecting: visible })),
      ], /** @type {IntersectionObserver} */ (/** @type {unknown} */ ({})));
    },
    cleanup() {
      player.dispose();
      for (const { name, descriptor } of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

test('visibility and viewport pauses cannot override one another', async (t) => {
  const h = createHarness();
  t.after(h.cleanup);
  await h.player.load(createScene());
  h.flush();
  h.setHidden(true);
  h.setIntersecting(true);
  h.pointAt({ x: 1920, y: 1080 });
  assert.equal(h.getPendingFrames(), 0, 'a visible intersection cannot resume a hidden document');
  h.setIntersecting(false);
  h.setHidden(false);
  assert.equal(h.getPendingFrames(), 0, 'document visibility cannot resume an offscreen player');
  h.setIntersecting(true);
  assert.ok(h.getPendingFrames() > 0);
  h.flush();
});

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


test('global depth of field scales blur without changing parallax or rebuilding textures', async (t) => {
  const h = createHarness();
  t.after(h.cleanup);
  await h.player.load(createScene());
  h.player.setFocus(0, { animate: false });
  h.pointAt({ x: 1920, y: 1080 });
  h.flush();
  const full = h.getFrame();
  const prepared = h.getPreparedCount();
  h.player.setDepthOfFieldStrength(0);
  h.flush();
  const clear = h.getFrame();
  h.player.setDepthOfFieldStrength(0.5);
  h.flush();
  const half = h.getFrame();
  for (let i = 0; i < full.layerCount * 4; i++) {
    assert.ok(Math.abs(clear.rects[i] - full.rects[i]) < 0.1);
  }
  assert.equal(h.getPreparedCount(), prepared);
  assert.ok([...full.lods].some((lod, i) => lod > clear.lods[i]));
  for (let i = 0; i < full.layerCount; i++) {
    assert.ok(half.lods[i] >= clear.lods[i] && half.lods[i] <= full.lods[i]);
  }
});


test('layer scale preserves aspect ratio, anchor, and authored size through reload', async (t) => {
  const h = createHarness();
  t.after(h.cleanup);
  await h.player.load(createScene());
  h.flush();
  await h.player.edit({ type: 'set-layer', layerId: 'layer-1', changesLayer: { scalePercent: 200 } });
  h.flush();
  let layer = h.player.getScene().variants[0].layers[1];
  assert.deepEqual(layer.placement, { x: 0, y: 0, width: 6000, height: 2160 });
  assert.deepEqual([...h.getFrame().rects.slice(4, 8)], [0, 0, 6000, 2160]);
  await h.player.load(h.player.getScene());
  h.flush();
  layer = h.player.getScene().variants[0].layers[1];
  assert.equal(layer.scalePercent, 200);
  assert.deepEqual(layer.placement, { x: 0, y: 0, width: 6000, height: 2160 });
  for (const scalePercent of [5, 500]) {
    await h.player.edit({ type: 'set-layer', layerId: 'layer-1', changesLayer: { scalePercent } });
    h.flush();
    const scaled = h.player.getScene().variants[0].layers[1];
    assert.equal(scaled.placement.width, 3000 * scalePercent / 100);
    assert.equal(scaled.placement.height, 1080 * scalePercent / 100);
    assert.deepEqual([scaled.placement.x, scaled.placement.y], [0, 0]);
  }
  assert.deepEqual(h.errors, []);
});

test('cursor tracking focuses the front-most silhouette under the pointer after the dwell time', async (t) => {
  // Load order is back to front: opaque background, two transparent layers, front opaque on its left half.
  const h = createHarness({ alphaByLoad: [() => 255, () => 0, () => 0, (u) => (u < 0.5 ? 255 : 0)] });
  t.after(h.cleanup);
  await h.player.load(createScene());
  h.player.setIntensity(0, 0);
  /** @type {number[]} */
  const focusTargets = [];
  h.player.on('focus-change', (payload) => focusTargets.push(payload.d));
  h.flush();

  h.pointAt({ x: 270, y: 540, isOverCanvas: true });
  h.flush();
  assert.deepEqual(focusTargets, [], 'manual tracking ignores the cursor');

  h.player.setFocusTracking('cursor');
  h.step();
  assert.deepEqual(focusTargets, [], 'focus waits for the dwell time');
  h.flush();
  assert.deepEqual(focusTargets, [10]);
  const front = h.getFrame();
  assert.ok(front.lods[3] < front.lods[0], 'the front layer is sharper than the background');

  h.pointAt({ x: 800, y: 540, isOverCanvas: true });
  h.flush();
  assert.deepEqual(focusTargets, [10, 90], 'transparent front pixels fall through to the background');
  const back = h.getFrame();
  assert.ok(back.lods[0] < back.lods[3], 'the background is sharper than the front layer');

  h.pointAt({ x: 270, y: 540 });
  h.flush();
  assert.deepEqual(focusTargets, [10, 90], 'a pointer over an overlaid panel keeps the focus');

  h.pointAt({ x: 270, y: 540, isOverCanvas: true });
  h.step();
  h.step();
  h.pointAt({ x: 800, y: 540, isOverCanvas: true });
  h.flush();
  assert.deepEqual(focusTargets, [10, 90], 'a brief pass over another layer does not refocus');

  h.player.setFocusTracking('manual');
  h.pointAt({ x: 270, y: 540, isOverCanvas: true });
  h.flush();
  assert.deepEqual(focusTargets, [10, 90]);
  assert.deepEqual(h.errors, []);
});
