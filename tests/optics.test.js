import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRefFactor,
  resolveDepths,
  computeDrawOrder,
  computeApertureK,
  computeSigmaRef,
  computeLayerSigmaRef,
  computeLod,
  computeLevelSigmaTex,
  computeBreathingZoom,
} from '../src/core/optics.js';

/**
 * @param {number} actual
 * @param {number} expected
 * @param {number} [eps]
 */
function assertClose(actual, expected, eps = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} != ${expected} (diff: ${Math.abs(actual - expected)})`);
}

test('computeRefFactor maps reference height and scale correctly', () => {
  assert.equal(computeRefFactor(1080, 1), 1);
  assert.equal(computeRefFactor(1440, 1.5), 2);
});

test('computeRefFactor unit property: sigmaRender / heightRender remains invariant to renderScale', () => {
  const compHeightComp = 1080;
  const scale1 = 1.0;
  const scale2 = 0.5;

  const refFactor1 = computeRefFactor(compHeightComp, scale1);
  const refFactor2 = computeRefFactor(compHeightComp, scale2);

  const sigmaRef = 20;
  const sigmaRender1 = sigmaRef * refFactor1;
  const sigmaRender2 = sigmaRef * refFactor2;

  const heightRender1 = compHeightComp * scale1;
  const heightRender2 = compHeightComp * scale2;

  assertClose(sigmaRender1 / heightRender1, sigmaRender2 / heightRender2);
});

test('computeSigmaRef evaluates tolerance, aperture and clamps to maxBlur', () => {
  /** @type {import('../src/core/scene/model.js').Optics} */
  const optics = {
    focus: 50,
    aperture: 2.8,
    tolerance: 5,
    maxBlur: 24,
    focusRange: [0, 100],
    focusSpeed: 0.5,
    breathing: 0,
  };

  // Within tolerance -> 0
  assert.equal(computeSigmaRef(53, 50, optics), 0);
  assert.equal(computeSigmaRef(46, 50, optics), 0);

  // f/2.8 with excess 10 -> excess = (65 - 50) - 5 = 10; kAperture = 0.35 * (2.8/2.8) = 0.35 -> 3.5
  assertClose(computeSigmaRef(65, 50, optics), 3.5);

  // f/5.6 gives half of f/2.8
  const opticsF56 = { ...optics, aperture: 5.6 };
  assertClose(computeSigmaRef(65, 50, opticsF56), 1.75);

  // Clamps at maxBlur
  assert.equal(computeSigmaRef(100, 0, optics), 24);
});

test('computeLayerSigmaRef respects focusMode', () => {
  /** @type {import('../src/core/scene/model.js').Optics} */
  const optics = {
    focus: 50,
    aperture: 2.8,
    tolerance: 5,
    maxBlur: 24,
    focusRange: [0, 100],
    focusSpeed: 0.5,
    breathing: 0,
  };

  // 'sharp' -> 0
  assert.equal(computeLayerSigmaRef('sharp', 100, 50, 10, optics), 0);

  // 'fixed' -> min(fixedBlur, maxBlur)
  assert.equal(computeLayerSigmaRef('fixed', 100, 50, 10, optics), 10);
  assert.equal(computeLayerSigmaRef('fixed', 100, 50, 50, optics), 24);

  // 'dynamic' -> computeSigmaRef
  assertClose(computeLayerSigmaRef('dynamic', 65, 50, 0, optics), 3.5);
});

test('computeLod calculates LOD levels, min lod for minification, and consistency with computeLevelSigmaTex', () => {
  // sigma 0 and texelsPerPixel 1 -> 0
  assert.equal(computeLod(0, 1, 5), 0);

  // texelsPerPixel 4 -> >= 2
  assert.ok(computeLod(0, 4, 5) >= 2);

  // Clamps at lastLevel
  assert.equal(computeLod(100, 10, 3), 3);

  // Consistency: computeLod(computeLevelSigmaTex(k), 1, 99) ≈ k
  for (let k = 0; k <= 5; k++) {
    const sigmaTex = computeLevelSigmaTex(k);
    const lod = computeLod(sigmaTex, 1, 99);
    assertClose(lod, k, 1e-4);
  }
});

test('resolveDepths resolves 4 null depths and preserves manual depth', () => {
  /** @type {import('../src/core/scene/model.js').Layer[]} */
  const layers = [
    { id: '1', assetId: 'a1', placement: { x: 0, y: 0, width: 100, height: 100 }, depth: null, focusMode: 'dynamic', fixedBlur: 0, order: 0 },
    { id: '2', assetId: 'a2', placement: { x: 0, y: 0, width: 100, height: 100 }, depth: null, focusMode: 'dynamic', fixedBlur: 0, order: 1 },
    { id: '3', assetId: 'a3', placement: { x: 0, y: 0, width: 100, height: 100 }, depth: null, focusMode: 'dynamic', fixedBlur: 0, order: 2 },
    { id: '4', assetId: 'a4', placement: { x: 0, y: 0, width: 100, height: 100 }, depth: null, focusMode: 'dynamic', fixedBlur: 0, order: 3 },
  ];

  const depths = resolveDepths(layers);
  assertClose(depths[0], 90);
  assertClose(depths[1], 90 - 80 / 3, 1e-4);
  assertClose(depths[2], 90 - 160 / 3, 1e-4);
  assertClose(depths[3], 10);

  // Manual depth preserved
  layers[1].depth = 55;
  const depthsManual = resolveDepths(layers);
  assertClose(depthsManual[1], 55);
});

test('computeDrawOrder sorts by resolved depth descending and tie-breaks by order ascending', () => {
  /** @type {import('../src/core/scene/model.js').Layer[]} */
  const layers = [
    { id: '1', assetId: 'a1', placement: { x: 0, y: 0, width: 100, height: 100 }, depth: null, focusMode: 'dynamic', fixedBlur: 0, order: 10 },
    { id: '2', assetId: 'a2', placement: { x: 0, y: 0, width: 100, height: 100 }, depth: null, focusMode: 'dynamic', fixedBlur: 0, order: 5 },
    { id: '3', assetId: 'a3', placement: { x: 0, y: 0, width: 100, height: 100 }, depth: null, focusMode: 'dynamic', fixedBlur: 0, order: 20 },
  ];
  // depths: layer 0 = 50, layer 1 = 80, layer 2 = 50
  const depths = new Float32Array([50, 80, 50]);

  // Expected order:
  // layer 1 has depth 80 (highest, drawn first)
  // layer 0 and layer 2 tie at depth 50 -> tie-break by order ascending (layer 0 has order 10, layer 2 has order 20)
  // so indices order: [1, 0, 2]
  const drawOrder = computeDrawOrder(layers, depths);
  assert.deepEqual(drawOrder, [1, 0, 2]);
});

test('computeBreathingZoom scales zoom accurately', () => {
  assert.equal(computeBreathingZoom(100, 0.02), 1);
  assertClose(computeBreathingZoom(0, 0.02), 1.02);
});
