import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateScene } from '../src/core/scene/validate.js';
import {
  DEFAULT_OPTICS,
  DEFAULT_MOTION,
  DEFAULT_QUALITY,
} from '../src/core/scene/model.js';

function createValidRawScene() {
  return {
    formatVersion: 1,
    id: 'scene-test-1',
    name: 'Test Scene',
    reference: { width: 1920, height: 1080 },
    pointOfInterest: { x: 0.5, y: 0.5 },
    posterAssetId: null,
    defaultVariantId: 'var-1',
    assets: [
      { id: 'ast-1', name: 'Layer 1', type: 'png', width: 1920, height: 1080, path: 'assets/l1.png' },
      { id: 'ast-2', name: 'Layer 2', type: 'png', width: 1920, height: 1080, path: 'assets/l2.png' },
      { id: 'ast-3', name: 'Layer 3', type: 'png', width: 1920, height: 1080, path: 'assets/l3.png' },
      { id: 'ast-4', name: 'Layer 4', type: 'png', width: 1920, height: 1080, path: 'assets/l4.png' },
    ],
    variants: [
      {
        id: 'var-1',
        name: 'Default Variant',
        layers: [
          { id: 'lay-1', assetId: 'ast-1', order: 0 },
          { id: 'lay-2', assetId: 'ast-2', order: 1 },
          { id: 'lay-3', assetId: 'ast-3', order: 2 },
          { id: 'lay-4', assetId: 'ast-4', order: 3 },
        ],
      },
    ],
  };
}

test('minimal valid scene passes and receives all default properties', () => {
  const raw = createValidRawScene();
  const res = validateScene(raw);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.scene.formatVersion, 1);
    assert.equal(res.scene.id, 'scene-test-1');
    assert.deepEqual(res.scene.variants[0].optics, DEFAULT_OPTICS);
    assert.deepEqual(res.scene.variants[0].motion, DEFAULT_MOTION);
    assert.deepEqual(res.scene.variants[0].quality, DEFAULT_QUALITY);
    assert.deepEqual(res.scene.variants[0].layers[0].placement, {
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    });
    assert.equal(res.scene.variants[0].layers[0].depth, null);
    assert.equal(res.scene.variants[0].layers[0].focusMode, 'dynamic');
    assert.equal(res.scene.variants[0].layers[0].fixedBlur, 0);
  }
});

test('unknown fields are discarded from clean scene output', () => {
  const raw = createValidRawScene();
  /** @type {Record<string, unknown>} */ (raw).unknownTopField = 'discard-me';
  /** @type {Record<string, unknown>} */ (raw.variants[0]).speed = 999;
  /** @type {Record<string, unknown>} */ (raw.variants[0].layers[0]).nearZ = 123;

  const res = validateScene(raw);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal('unknownTopField' in res.scene, false);
    assert.equal('speed' in res.scene.variants[0], false);
    assert.equal('nearZ' in res.scene.variants[0].layers[0], false);
  }
});

test('different image sizes use native geometry and retain manual position without mutation', () => {
  const raw = createValidRawScene();
  const dimensions = [[3000, 1080], [640, 480], [1080, 3000], [1, 1]];
  raw.assets.forEach((asset, index) => {
    [asset.width, asset.height] = dimensions[index];
    Object.assign(raw.variants[0].layers[index], {
      placement: { x: -1200, y: 2500, width: 1920, height: 1080 },
      parallaxPercent: index * 25,
    });
  });
  const snapshot = structuredClone(raw);
  const result = validateScene(raw);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  result.scene.variants[0].layers.forEach((layer, index) => {
    assert.deepEqual(layer.placement, {
      x: -1200, y: 2500, width: dimensions[index][0], height: dimensions[index][1],
    });
    assert.equal(layer.parallaxPercent, index * 25);
  });
  assert.deepEqual(raw, snapshot);
  assert.deepEqual(validateScene(result.scene), result);
});

test('absent placement uses native image dimensions and absent percentage uses automatic motion', () => {
  const raw = createValidRawScene();
  raw.assets[0].width = 3000;
  raw.assets[0].height = 600;
  const result = validateScene(raw);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.scene.variants[0].layers[0].placement, {
    x: 0, y: 0, width: 3000, height: 600,
  });
  assert.equal(result.scene.variants[0].layers[0].parallaxPercent, null);
});

test('parallax percentages reject invalid values and accept both endpoints and automatic mode', () => {
  for (const value of [-1, 101, NaN, Infinity, '50']) {
    const raw = createValidRawScene();
    Object.assign(raw.variants[0].layers[0], { parallaxPercent: value });
    const result = validateScene(raw);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.ok(result.errors.some((error) => error.includes('layers[0].parallaxPercent')));
  }
  for (const value of [0, 100, 33.3, null]) {
    const raw = createValidRawScene();
    Object.assign(raw.variants[0].layers[0], { parallaxPercent: value });
    const result = validateScene(raw);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.scene.variants[0].layers[0].parallaxPercent, value);
  }
});

test('formatVersion 2 returns unsupported-format-version code', () => {
  const raw = createValidRawScene();
  raw.formatVersion = 2;
  const res = validateScene(raw);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.code, 'unsupported-format-version');
  }
});

test('variant with 3 layers fails with invalid-scene (MIN_LAYERS = 4)', () => {
  const raw = createValidRawScene();
  raw.variants[0].layers.pop();
  const res = validateScene(raw);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.code, 'invalid-scene');
    assert.ok(res.errors.some((e) => e.includes('out of bounds')));
  }
});

test('variant with 12 layers fails with invalid-scene (MAX_LAYERS = 11)', () => {
  const raw = createValidRawScene();
  // add 8 more layers and assets
  for (let i = 5; i <= 12; i++) {
    raw.assets.push({
      id: `ast-${i}`,
      name: `Layer ${i}`,
      type: 'png',
      width: 1920,
      height: 1080,
      path: `assets/l${i}.png`,
    });
    raw.variants[0].layers.push({
      id: `lay-${i}`,
      assetId: `ast-${i}`,
      order: i - 1,
    });
  }
  const res = validateScene(raw);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.code, 'invalid-scene');
    assert.ok(res.errors.some((e) => e.includes('out of bounds')));
  }
});

test('non-existent assetId in layer fails with invalid-scene', () => {
  const raw = createValidRawScene();
  raw.variants[0].layers[0].assetId = 'non-existent-asset';
  const res = validateScene(raw);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.code, 'invalid-scene');
    assert.ok(res.errors.some((e) => e.includes('does not exist in assets')));
  }
});

test('aperture 1.0 fails with invalid-scene (min aperture is 1.4)', () => {
  const raw = createValidRawScene();
  /** @type {Record<string, unknown>} */ (raw.variants[0]).optics = { aperture: 1.0 };
  const res = validateScene(raw);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.code, 'invalid-scene');
    assert.ok(res.errors.some((e) => e.includes('aperture: out of range')));
  }
});

test('path with parent directory ../x.png fails with invalid-scene', () => {
  const raw = createValidRawScene();
  raw.assets[0].path = '../x.png';
  const res = validateScene(raw);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.code, 'invalid-scene');
    assert.ok(res.errors.some((e) => e.includes('invalid relative path')));
  }
});

test('input object is not mutated during validation', () => {
  const raw = createValidRawScene();
  const snapshot = structuredClone(raw);
  validateScene(raw);
  assert.deepEqual(raw, snapshot);
});
