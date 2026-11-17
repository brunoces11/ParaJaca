import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAnchorDepth,
  computeParallaxOffsetRef,
  computeLayerParallaxOffsetRef,
  resolveParallaxPercents,
  clampDt,
  computeInputK,
  computeFocusK,
  smoothStep,
  computeDriftInputX,
  computeDriftInputY,
  isConverged,
} from '../src/core/motion.js';

/**
 * @param {number} actual
 * @param {number} expected
 * @param {number} [eps]
 */
function assertClose(actual, expected, eps = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} != ${expected} (diff: ${Math.abs(actual - expected)})`);
}

test('motion percentages span 0 to 100 by order, independently of optical depth', () => {
  const layers = Array.from({ length: 7 }, (_, order) => ({
    id: `layer-${order}`, assetId: `asset-${order}`,
    placement: { x: 0, y: 0, width: 1920, height: 1080 },
    depth: 50, focusMode: /** @type {const} */ ('dynamic'), fixedBlur: 0, order,
  }));
  const snapshot = structuredClone(layers);
  const percents = resolveParallaxPercents([...layers].reverse());
  for (let i = 0; i < layers.length; i++) {
    assertClose(percents[i], 100 - i * 100 / 6, 1e-4);
  }
  assert.deepEqual(layers, snapshot);
  assert.deepEqual([...resolveParallaxPercents([])], []);
  assert.deepEqual([...resolveParallaxPercents([layers[0]])], [0]);
});

test('equal manual percentages group motion without changing automatic neighbors', () => {
  const layers = Array.from({ length: 4 }, (_, order) => ({
    id: `layer-${order}`, assetId: `asset-${order}`,
    placement: { x: 0, y: 0, width: 1920, height: 1080 },
    depth: null, focusMode: /** @type {const} */ ('dynamic'), fixedBlur: 0, order,
    parallaxPercent: order === 1 || order === 2 ? 72.5 : null,
  }));
  assert.deepEqual([...resolveParallaxPercents(layers)], [0, 72.5, 72.5, 100]);
  layers[1].parallaxPercent = 0;
  layers[2].parallaxPercent = 100;
  assert.deepEqual([...resolveParallaxPercents(layers)], [0, 0, 100, 100]);
});

test('layer motion reaches the chosen maximum and scales both axes by the same percentage', () => {
  assertClose(computeLayerParallaxOffsetRef(1, 400, 100), -400);
  assertClose(computeLayerParallaxOffsetRef(-1, 400, 100), 400);
  assertClose(computeLayerParallaxOffsetRef(1, 400, 0), 0);
  assertClose(computeLayerParallaxOffsetRef(0, 400, 100), 0);
  assertClose(computeLayerParallaxOffsetRef(1, 0, 100), 0);
  assertClose(computeLayerParallaxOffsetRef(0.5, 400, 25), -50);
  assertClose(computeLayerParallaxOffsetRef(0.5, 100, 25), -12.5);
});

test('computeParallaxOffsetRef computes directional offset and respects depth', () => {
  // input 1, intensity 40, anchor 100, depth 0 -> -40
  const off0 = computeParallaxOffsetRef(1, 40, 100, 0);
  assertClose(off0, -40);

  // depth 100 -> 0 (no movement at infinity)
  const off100 = computeParallaxOffsetRef(1, 40, 100, 100);
  assertClose(off100, 0);

  // input -1 reverses the sign -> +40
  const offNeg = computeParallaxOffsetRef(-1, 40, 100, 0);
  assertClose(offNeg, 40);
});

test('computeAnchorDepth returns focus depth when anchor is focus, and 100 when infinity', () => {
  assert.equal(computeAnchorDepth('infinity', 60), 100);
  assert.equal(computeAnchorDepth('focus', 60), 60);

  // Layer at focus depth has 0 offset when anchor is focus
  const anchorFocus = computeAnchorDepth('focus', 60);
  const offFocus = computeParallaxOffsetRef(1, 40, anchorFocus, 60);
  assertClose(offFocus, 0);
});

test('smoothStep is rate-independent (1 step of dt=0.032 ≈ 2 steps of dt=0.016)', () => {
  const current = 0;
  const target = 100;
  const k = 10;

  // 1 single step of 0.032s
  const oneStep = smoothStep(current, target, k, 0.032);

  // 2 consecutive steps of 0.016s
  const stepA = smoothStep(current, target, k, 0.016);
  const twoSteps = smoothStep(stepA, target, k, 0.016);

  // Exponential decay is analytically exact across subdivisions: error < 1e-9
  assertClose(oneStep, twoSteps, 1e-9);
});

test('clampDt clamps to [0, MAX_DT_SEC]', () => {
  assert.equal(clampDt(5), 0.1);
  assert.equal(clampDt(-1), 0);
  assert.equal(clampDt(0.016), 0.016);
});

test('computeInputK and computeFocusK lerp correctly', () => {
  assert.equal(computeInputK(0), 30);
  assert.equal(computeInputK(1), 2);
  assert.equal(computeInputK(0.5), 16);

  assert.equal(computeFocusK(0), 1);
  assert.equal(computeFocusK(1), 20);
  assert.equal(computeFocusK(0.5), 10.5);
});

test('computeDriftInputX and computeDriftInputY evaluate harmonic oscillations', () => {
  assertClose(computeDriftInputX(0), 0);
  assertClose(computeDriftInputY(0), 0);
  assertClose(computeDriftInputX(11 / 4), 0.15); // quarter period peak
  assertClose(computeDriftInputY(7 / 4), 0.1);  // quarter period peak
});

test('isConverged checks remaining offset and sigma thresholds', () => {
  assert.equal(isConverged(0.05, 0.01), true);
  assert.equal(isConverged(0.2, 0), false);
  assert.equal(isConverged(0.05, 0.1), false);
});
