import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFrameLayout, FRAMING_MAX_ZOOM } from '../src/core/framing.js';

/**
 * @param {number} actual
 * @param {number} expected
 * @param {number} [eps]
 */
function assertClose(actual, expected, eps = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} != ${expected} (diff: ${Math.abs(actual - expected)})`);
}

test('no edgeLayers on 1920x1080 canvas and 1920x1080 ref gives scale 1, centered camera, 0 margins, infinity limits', () => {
  const layout = computeFrameLayout({
    reference: { width: 1920, height: 1080 },
    pointOfInterest: { x: 0.5, y: 0.5 },
    canvasWidthRender: 1920,
    canvasHeightRender: 1080,
    edgeLayers: [],
  });

  assertClose(layout.renderPxPerCompPx, 1);
  assertClose(layout.cameraXComp, 960);
  assertClose(layout.cameraYComp, 540);
  assert.equal(layout.marginXComp, 0);
  assert.equal(layout.marginYComp, 0);
  assert.equal(layout.offsetLimitXRef, Infinity);
  assert.equal(layout.offsetLimitYRef, Infinity);
  assert.equal(layout.isMarginInsufficient, false);
});

test('portrait canvas (1080x1920) covers by height and camera clamps within bounds', () => {
  const layout = computeFrameLayout({
    reference: { width: 1920, height: 1080 },
    pointOfInterest: { x: 0.5, y: 0.5 },
    canvasWidthRender: 1080,
    canvasHeightRender: 1920,
    edgeLayers: [],
  });

  // Scale covers height: 1920 / 1080 = 1.777777...
  assertClose(layout.renderPxPerCompPx, 1920 / 1080);
  // halfViewW = 1080 / (2 * (1920 / 1080)) = 303.75
  // cameraXComp can roam between 303.75 and 1920 - 303.75 = 1616.25
  assertClose(layout.cameraXComp, 960);
  assertClose(layout.cameraYComp, 540);
});

test('pointOfInterest (0, 0) clamps camera to minimum allowable position', () => {
  const layout = computeFrameLayout({
    reference: { width: 1920, height: 1080 },
    pointOfInterest: { x: 0, y: 0 },
    canvasWidthRender: 1920,
    canvasHeightRender: 1080,
    edgeLayers: [],
  });

  // For 1:1 canvas, halfView is 960, 540, so clamped camera stays at 960, 540
  assertClose(layout.cameraXComp, 960);
  assertClose(layout.cameraYComp, 540);

  // Now with portrait canvas where X has roaming room:
  const layoutPortrait = computeFrameLayout({
    reference: { width: 1920, height: 1080 },
    pointOfInterest: { x: 0, y: 0 },
    canvasWidthRender: 1080,
    canvasHeightRender: 1920,
    edgeLayers: [],
  });
  // halfViewW is 1080 / (2 * (1920 / 1080)) = 303.75
  assertClose(layoutPortrait.cameraXComp, 303.75);
  assertClose(layoutPortrait.cameraYComp, 540);
});

test('excessive edge margin request flags isMarginInsufficient and limits offsetLimitXRef', () => {
  const layout = computeFrameLayout({
    reference: { width: 1920, height: 1080 },
    pointOfInterest: { x: 0.5, y: 0.5 },
    canvasWidthRender: 1920,
    canvasHeightRender: 1080,
    edgeLayers: [{ maxOffsetXRef: 500, maxOffsetYRef: 0 }],
  });

  // limitXComp = 1920 * (1 - 1 / 1.25) / 2 = 1920 * 0.2 / 2 = 192
  assert.equal(layout.isMarginInsufficient, true);
  assertClose(layout.marginXComp, 192);
  assertClose(layout.offsetLimitXRef, 192); // refToComp = 1080/1080 = 1
  assert.equal(layout.offsetLimitYRef, Infinity);
});

test('margins reduce visible area and proportionately increase cover scale', () => {
  const layoutWithMargin = computeFrameLayout({
    reference: { width: 1920, height: 1080 },
    pointOfInterest: { x: 0.5, y: 0.5 },
    canvasWidthRender: 1920,
    canvasHeightRender: 1080,
    edgeLayers: [{ maxOffsetXRef: 100, maxOffsetYRef: 50 }],
  });

  // visibleW = 1920 - 200 = 1720, visibleH = 1080 - 100 = 980
  // renderPxPerCompPx = max(1920 / 1720, 1080 / 980)
  const expectedScale = Math.max(1920 / 1720, 1080 / 980);
  assertClose(layoutWithMargin.renderPxPerCompPx, expectedScale);
  assert.ok(layoutWithMargin.renderPxPerCompPx > 1);
});
