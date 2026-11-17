import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createId,
  createDefaultVariant,
  createLayer,
  getVariant,
  cloneScene,
  DEFAULT_OPTICS,
  DEFAULT_MOTION,
  DEFAULT_QUALITY,
} from '../src/core/scene/model.js';

test('createId returns a valid UUID string', () => {
  const id1 = createId();
  const id2 = createId();
  assert.equal(typeof id1, 'string');
  assert.notEqual(id1, id2);
  assert.match(id1, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});

test('createLayer creates layer with composition placement and defaults', () => {
  const ref = { width: 1920, height: 1080 };
  const layer = createLayer('asset-1', 2, ref);
  assert.equal(layer.assetId, 'asset-1');
  assert.equal(layer.order, 2);
  assert.deepEqual(layer.placement, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.equal(layer.depth, null);
  assert.equal(layer.focusMode, 'dynamic');
  assert.equal(layer.fixedBlur, 0);
  assert.ok(layer.id);
});

test('createDefaultVariant initializes with cloned defaults', () => {
  const ref = { width: 800, height: 600 };
  const layers = [
    createLayer('a1', 0, ref),
    createLayer('a2', 1, ref),
    createLayer('a3', 2, ref),
    createLayer('a4', 3, ref),
  ];
  const variant = createDefaultVariant('Main', layers);
  assert.equal(variant.name, 'Main');
  assert.equal(variant.layers.length, 4);
  assert.deepEqual(variant.optics, DEFAULT_OPTICS);
  assert.deepEqual(variant.motion, DEFAULT_MOTION);
  assert.deepEqual(variant.quality, DEFAULT_QUALITY);
});

test('getVariant finds existing variant or returns null', () => {
  const ref = { width: 800, height: 600 };
  const layers = [
    createLayer('a1', 0, ref),
    createLayer('a2', 1, ref),
    createLayer('a3', 2, ref),
    createLayer('a4', 3, ref),
  ];
  const v1 = createDefaultVariant('V1', layers);
  /** @type {import('../src/core/scene/model.js').Scene} */
  const scene = {
    formatVersion: 1,
    id: 'scene-1',
    name: 'Scene 1',
    reference: ref,
    pointOfInterest: { x: 0.5, y: 0.5 },
    posterAssetId: null,
    defaultVariantId: v1.id,
    assets: [
      { id: 'a1', name: 'a1', type: 'png', width: 800, height: 600, path: 'assets/a1.png' },
      { id: 'a2', name: 'a2', type: 'png', width: 800, height: 600, path: 'assets/a2.png' },
      { id: 'a3', name: 'a3', type: 'png', width: 800, height: 600, path: 'assets/a3.png' },
      { id: 'a4', name: 'a4', type: 'png', width: 800, height: 600, path: 'assets/a4.png' },
    ],
    variants: [v1],
  };

  assert.equal(getVariant(scene, v1.id), v1);
  assert.equal(getVariant(scene, 'non-existent'), null);
});

test('cloneScene produces a deep clone without mutating the original', () => {
  const ref = { width: 800, height: 600 };
  const layers = [
    createLayer('a1', 0, ref),
    createLayer('a2', 1, ref),
    createLayer('a3', 2, ref),
    createLayer('a4', 3, ref),
  ];
  const v1 = createDefaultVariant('V1', layers);
  /** @type {import('../src/core/scene/model.js').Scene} */
  const scene = {
    formatVersion: 1,
    id: 'scene-1',
    name: 'Scene 1',
    reference: ref,
    pointOfInterest: { x: 0.5, y: 0.5 },
    posterAssetId: null,
    defaultVariantId: v1.id,
    assets: [
      { id: 'a1', name: 'a1', type: 'png', width: 800, height: 600, path: 'assets/a1.png' },
      { id: 'a2', name: 'a2', type: 'png', width: 800, height: 600, path: 'assets/a2.png' },
      { id: 'a3', name: 'a3', type: 'png', width: 800, height: 600, path: 'assets/a3.png' },
      { id: 'a4', name: 'a4', type: 'png', width: 800, height: 600, path: 'assets/a4.png' },
    ],
    variants: [v1],
  };

  const cloned = cloneScene(scene);
  assert.deepEqual(cloned, scene);
  cloned.name = 'Modified Scene';
  assert.notEqual(cloned.name, scene.name);
});
