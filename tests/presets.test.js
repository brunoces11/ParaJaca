import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUALITY_PRESETS, RENDER_SCALE_STEPS } from '../src/core/quality/presets.js';

test('QUALITY_PRESETS defines frozen high, mid, and low presets', () => {
  assert.equal(QUALITY_PRESETS.high.renderScale, 1.0);
  assert.equal(QUALITY_PRESETS.high.textureMaxHeight, 2160);

  assert.equal(QUALITY_PRESETS.mid.renderScale, 0.85);
  assert.equal(QUALITY_PRESETS.mid.textureMaxHeight, 1440);

  assert.equal(QUALITY_PRESETS.low.renderScale, 0.7);
  assert.equal(QUALITY_PRESETS.low.textureMaxHeight, 1080);

  assert.ok(Object.isFrozen(QUALITY_PRESETS));
});

test('RENDER_SCALE_STEPS contains standard descending scale factors', () => {
  assert.deepEqual(RENDER_SCALE_STEPS, [1.0, 0.85, 0.7, 0.5]);
  assert.ok(Object.isFrozen(RENDER_SCALE_STEPS));
});
