import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRequirements,
  satisfiesRequirements,
} from '../src/core/quality/requirements.js';
import { DEFAULT_OPTICS, DEFAULT_MOTION, DEFAULT_QUALITY } from '../src/core/scene/model.js';

function createMockParams() {
  /** @type {import('../src/core/scene/model.js').Layer} */
  const layer = {
    id: 'lay-1',
    assetId: 'ast-1',
    placement: { x: 0, y: 0, width: 1920, height: 1080 },
    depth: null,
    focusMode: 'dynamic',
    fixedBlur: 0,
    order: 0,
  };

  /** @type {import('../src/core/scene/model.js').Asset} */
  const asset = {
    id: 'ast-1',
    name: 'Layer 1',
    type: 'png',
    width: 3840,
    height: 2160,
    path: 'assets/l1.png',
  };

  /** @type {import('../src/core/scene/model.js').Variant} */
  const variant = {
    id: 'var-1',
    name: 'Default',
    layers: [layer],
    optics: structuredClone(DEFAULT_OPTICS),
    motion: structuredClone(DEFAULT_MOTION),
    quality: structuredClone(DEFAULT_QUALITY),
  };

  return {
    layer,
    resolvedDepth: 90,
    asset,
    contentRectComp: { x: 0, y: 0, width: 1920, height: 1080 },
    croppedSides: { left: true, top: true, right: true, bottom: true },
    variant,
    reference: { width: 1920, height: 1080 },
    renderPxPerCompPxAtScale1: 1.0,
    preset: { renderScale: 1.0, textureMaxHeight: 2160 },
    maxTextureSize: 4096,
  };
}

test('sharp focusMode gives sigmaMaxRef 0, padding 0, and levels >= 2 if texture > 1px', () => {
  const params = createMockParams();
  params.layer.focusMode = 'sharp';
  const req = computeRequirements(params);

  assert.equal(req.sigmaMaxRef, 0);
  assert.deepEqual(req.paddingTex, { left: 0, top: 0, right: 0, bottom: 0 });
  assert.ok(req.textureSize.width > 1);
  assert.ok(req.levels >= 2);
  assert.equal(req.maxLod, req.levels - 1);
});

test('texScale never exceeds asset.width / placement.width', () => {
  const params = createMockParams();
  // Asset is 1000px, placement is 2000px -> max allowed texScale is 0.5
  params.asset.width = 1000;
  params.layer.placement.width = 2000;
  params.renderPxPerCompPxAtScale1 = 2.0;

  const req = computeRequirements(params);
  assert.ok(req.texScale <= 0.5 + 1e-6);
});

test('texScale is capped by preset ceiling (low: 1080 / reference.height)', () => {
  const params = createMockParams();
  params.reference = { width: 1920, height: 2160 };
  params.preset = { renderScale: 0.7, textureMaxHeight: 1080 }; // low preset
  params.renderPxPerCompPxAtScale1 = 2.0;

  const req = computeRequirements(params);
  // Ceiling = 1080 / 2160 = 0.5
  assert.ok(req.texScale <= 0.5 + 1e-6);
});

test('uncropped side gives padding 0; cropped side gives padding > 0 when sigma > 0', () => {
  const params = createMockParams();
  params.croppedSides = { left: true, top: false, right: false, bottom: true };
  params.resolvedDepth = 90; // far from focus (50) -> sigma > 0

  const req = computeRequirements(params);
  assert.ok(req.sigmaMaxRef > 0);
  assert.ok(req.paddingTex.left > 0);
  assert.equal(req.paddingTex.top, 0);
  assert.equal(req.paddingTex.right, 0);
  assert.ok(req.paddingTex.bottom > 0);
});

test('exceeding maxTextureSize reduces texScale until texture fits within limit', () => {
  const params = createMockParams();
  params.maxTextureSize = 512;
  params.contentRectComp = { x: 0, y: 0, width: 2000, height: 2000 };

  const req = computeRequirements(params);
  assert.ok(req.textureSize.width <= 512);
  assert.ok(req.textureSize.height <= 512);
});

test('satisfiesRequirements returns true for larger or equal scale, sigma, levels; false otherwise', () => {
  /** @type {import('../src/core/quality/requirements.js').LayerRequirements} */
  const current = {
    texScale: 1.0,
    contentSizeTex: { width: 1000, height: 1000 },
    paddingTex: { left: 10, top: 10, right: 10, bottom: 10 },
    textureSize: { width: 1020, height: 1020 },
    levels: 5,
    maxLod: 4,
    sigmaMaxRef: 24,
  };

  /** @type {import('../src/core/quality/requirements.js').LayerRequirements} */
  const neededEqual = { ...current };
  assert.equal(satisfiesRequirements(current, neededEqual), true);

  /** @type {import('../src/core/quality/requirements.js').LayerRequirements} */
  const neededSmaller = { ...current, texScale: 0.8, sigmaMaxRef: 20, levels: 4 };
  assert.equal(satisfiesRequirements(current, neededSmaller), true);

  /** @type {import('../src/core/quality/requirements.js').LayerRequirements} */
  const neededHigherScale = { ...current, texScale: 1.2 };
  assert.equal(satisfiesRequirements(current, neededHigherScale), false);

  /** @type {import('../src/core/quality/requirements.js').LayerRequirements} */
  const neededHigherSigma = { ...current, sigmaMaxRef: 30 };
  assert.equal(satisfiesRequirements(current, neededHigherSigma), false);

  /** @type {import('../src/core/quality/requirements.js').LayerRequirements} */
  const neededHigherLevels = { ...current, levels: 6 };
  assert.equal(satisfiesRequirements(current, neededHigherLevels), false);
});
