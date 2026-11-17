import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParaJacaError, ERROR_CODES, isAbortError } from '../src/core/errors.js';

test('ParaJacaError stores code, message, and defaults assetId to null', () => {
  const err = new ParaJacaError(ERROR_CODES.INVALID_SCENE, 'Invalid scene structure');
  assert.equal(err.name, 'ParaJacaError');
  assert.equal(err.code, 'invalid-scene');
  assert.equal(err.message, 'Invalid scene structure');
  assert.equal(err.assetId, null);
  assert.ok(err instanceof Error);
});

test('ParaJacaError stores custom assetId and cause when provided', () => {
  const cause = new Error('Network error');
  const err = new ParaJacaError(ERROR_CODES.ASSET_LOAD_FAILED, 'Failed to load asset', {
    assetId: 'layer-bg',
    cause,
  });
  assert.equal(err.name, 'ParaJacaError');
  assert.equal(err.code, 'asset-load-failed');
  assert.equal(err.assetId, 'layer-bg');
  assert.equal(err.cause, cause);
});

test('isAbortError returns true for DOMException with name AbortError', () => {
  const domAbort = new DOMException('Operation aborted', 'AbortError');
  assert.equal(isAbortError(domAbort), true);
});

test('isAbortError returns false for generic Error', () => {
  const genericErr = new Error('Some error');
  assert.equal(isAbortError(genericErr), false);
});

test('isAbortError returns false for null and undefined', () => {
  assert.equal(isAbortError(null), false);
  assert.equal(isAbortError(undefined), false);
});
