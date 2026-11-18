// Image source loader for PNG/WebP/JPEG into premultiplied ImageBitmaps.
// Implements R§15. Minimal version for Phase A.

import { ParaJacaError, ERROR_CODES, isAbortError } from '../errors.js';
import { inspectVector } from './media-source.js';
import { rasterizeSvg } from './svg-source.js';

/**
 * @typedef {{ width: number, height: number, data: Uint8Array }} AlphaMask
 */

/**
 * @typedef {Object} LoadedSource
 * @property {ImageBitmap} bitmap
 * @property {import('../scene/model.js').Rect} contentRectComp
 * @property {{ left: boolean, top: boolean, right: boolean, bottom: boolean }} croppedSides
 * @property {boolean} opaque
 * @property {AlphaMask | null} alphaMask
 */

/**
 * @typedef {(asset: import('../scene/model.js').Asset) => string | Blob | Promise<string | Blob>} AssetResolver
 */

/**
 * @typedef {Object} SourceAnalysis
 * @property {Blob} blob
 * @property {import('../scene/model.js').Rect} contentRectComp
 * @property {{ left: boolean, top: boolean, right: boolean, bottom: boolean }} croppedSides
 * @property {boolean} opaque
 * @property {AlphaMask | null} alphaMask
 * @property {import('./media-source.js').VectorInfo} [vector]
 */

/**
 * Resolves an asset to a Blob using the provided resolver or fetch.
 * @param {import('../scene/model.js').Asset} asset
 * @param {AssetResolver} resolver
 * @param {AbortSignal} signal
 * @returns {Promise<Blob>}
 */
async function resolveBlob(asset, resolver, signal) {
  signal.throwIfAborted();
  let resolved;
  try {
    resolved = await resolver(asset);
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new ParaJacaError(ERROR_CODES.ASSET_LOAD_FAILED, `Resolver failed for ${asset.path}`, {
      assetId: asset.id,
      cause: err,
    });
  }
  signal.throwIfAborted();

  if (typeof resolved === 'string') {
    let response;
    try {
      response = await fetch(resolved, { signal });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new ParaJacaError(ERROR_CODES.ASSET_LOAD_FAILED, `Fetch failed for ${asset.path}`, {
        assetId: asset.id,
        cause: err,
      });
    }
    signal.throwIfAborted();

    if (!response.ok) {
      throw new ParaJacaError(
        ERROR_CODES.ASSET_LOAD_FAILED,
        `HTTP ${response.status} for ${asset.path}`,
        { assetId: asset.id },
      );
    }
    try {
      const blob = await response.blob();
      signal.throwIfAborted();
      return blob;
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new ParaJacaError(ERROR_CODES.ASSET_LOAD_FAILED, `Failed to read blob for ${asset.path}`, {
        assetId: asset.id,
        cause: err,
      });
    }
  }

  // Files supplied by a parent window/iframe belong to a different Blob constructor.
  const tag = Object.prototype.toString.call(resolved);
  if (resolved instanceof Blob || tag === '[object Blob]' || tag === '[object File]') {
    return resolved;
  }

  throw new ParaJacaError(
    ERROR_CODES.ASSET_LOAD_FAILED,
    `Expected Blob or URL string from resolver for ${asset.path}`,
    { assetId: asset.id },
  );
}

/**
 * Phase A minimal version of analyzeSource: acquires blob and placement rect.
 * @param {import('../scene/model.js').Asset} asset
 * @param {import('../scene/model.js').Layer} layer
 * @param {AssetResolver} resolver
 * @param {AbortSignal} signal
 * @returns {Promise<SourceAnalysis>}
 */
export async function analyzeSource(asset, layer, resolver, signal) {
  signal.throwIfAborted();
  const blob = await resolveBlob(asset, resolver, signal);
  signal.throwIfAborted();
  const vector = asset.type === 'svg' || asset.type === 'lottie' || asset.type === 'dotlottie'
    ? await inspectVector(blob, asset.type, signal) : undefined;
  if (vector && (Math.abs(vector.width - asset.width) > 1e-4 || Math.abs(vector.height - asset.height) > 1e-4)) {
    throw new ParaJacaError(ERROR_CODES.ASSET_LOAD_FAILED, 'Asset dimensions differ from the file; reimport the asset', { assetId: asset.id });
  }

  return {
    blob,
    contentRectComp: layer.placement,
    croppedSides: { left: false, top: false, right: false, bottom: false },
    opaque: asset.type === 'jpg',
    alphaMask: null,
    vector,
  };
}

/**
 * Decodes raster blob into a premultiplied ImageBitmap sized to contentSizeTex.
 * @param {SourceAnalysis} analysis
 * @param {import('../scene/model.js').Asset} asset
 * @param {import('../scene/model.js').Layer} layer
 * @param {import('../scene/model.js').Size} contentSizeTex
 * @param {AbortSignal} signal
 * @returns {Promise<ImageBitmap>}
 */
export async function decodeSource(analysis, asset, layer, contentSizeTex, signal) {
  signal.throwIfAborted();

  if (analysis.vector?.kind === 'svg' && !analysis.vector.animated) {
    return rasterizeSvg(analysis.vector.text, contentSizeTex.width, contentSizeTex.height, signal);
  }
  if (analysis.vector) {
    throw new ParaJacaError(ERROR_CODES.ASSET_LOAD_FAILED, 'Animated assets require the animation adapter', { assetId: asset.id });
  }

  try {
    const bitmap = await createImageBitmap(analysis.blob, 0, 0, asset.width, asset.height, {
      resizeWidth: contentSizeTex.width,
      resizeHeight: contentSizeTex.height,
      resizeQuality: 'high',
      premultiplyAlpha: 'premultiply',
      colorSpaceConversion: 'default',
    });
    if (signal.aborted) { bitmap.close(); signal.throwIfAborted(); }
    return bitmap;
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new ParaJacaError(ERROR_CODES.ASSET_LOAD_FAILED, `Failed to decode bitmap for ${asset.path}`, {
      assetId: asset.id,
      cause: err,
    });
  }
}

/**
 * Combined loader helper for manual testing.
 * @param {import('../scene/model.js').Asset} asset
 * @param {import('../scene/model.js').Layer} layer
 * @param {AssetResolver} resolver
 * @param {AbortSignal} signal
 * @returns {Promise<LoadedSource>}
 */
export async function loadSource(asset, layer, resolver, signal) {
  const analysis = await analyzeSource(asset, layer, resolver, signal);
  const bitmap = await decodeSource(
    analysis,
    asset,
    layer,
    { width: asset.width, height: asset.height },
    signal,
  );
  return {
    bitmap,
    contentRectComp: analysis.contentRectComp,
    croppedSides: analysis.croppedSides,
    opaque: analysis.opaque,
    alphaMask: analysis.alphaMask,
  };
}
