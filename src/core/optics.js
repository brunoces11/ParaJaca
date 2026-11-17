// Pure optics formulas for ParaJaca: units, depth resolution, blur, LOD, and breathing.
// Implements R§12.1-R§12.5. Zero execution dependencies.

/**
 * @typedef {import('./scene/model.js').Layer} Layer
 * @typedef {import('./scene/model.js').Optics} Optics
 * @typedef {import('./scene/model.js').FocusMode} FocusMode
 */

export const REFERENCE_HEIGHT_REF = 1080;
export const AUTO_DEPTH_BACK = 90; // calibrate
export const AUTO_DEPTH_FRONT = 10; // calibrate
export const APERTURE_K = 0.35; // calibrate
export const APERTURE_REF_N = 2.8;

/**
 * Computes refFactor relating displayed render px to reference 1080p px.
 * refFactor = displayedSceneHeightRender / 1080
 * @param {number} compHeightComp
 * @param {number} renderPxPerCompPx
 * @returns {number}
 */
export function computeRefFactor(compHeightComp, renderPxPerCompPx) {
  // refFactor = displayedSceneHeightRender / 1080
  return (compHeightComp * renderPxPerCompPx) / REFERENCE_HEIGHT_REF;
}

/**
 * Resolves depths for all layers, filling null depths with linear interpolation by order.
 * @param {Layer[]} layers
 * @returns {Float32Array}
 */
export function resolveDepths(layers) {
  const n = layers.length;
  const result = new Float32Array(n);
  if (n === 0) return result;

  // Sort index copies by order ascending
  const sortedIndices = Array.from({ length: n }, (_, i) => i);
  sortedIndices.sort((a, b) => {
    const diff = layers[a].order - layers[b].order;
    return diff !== 0 ? diff : a - b;
  });

  for (let pos = 0; pos < n; pos++) {
    const idx = sortedIndices[pos];
    const autoDepth = n === 1
      ? AUTO_DEPTH_BACK
      : AUTO_DEPTH_BACK - (pos * (AUTO_DEPTH_BACK - AUTO_DEPTH_FRONT)) / (n - 1);
    result[idx] = layers[idx].depth !== null ? /** @type {number} */ (layers[idx].depth) : autoDepth;
  }

  return result;
}

/**
 * Computes drawing order indices: resolved depth descending (back to front),
 * tie-breaking by order ascending, then original index.
 * @param {Layer[]} layers
 * @param {Float32Array | number[]} resolvedDepths
 * @returns {number[]}
 */
export function computeDrawOrder(layers, resolvedDepths) {
  const n = layers.length;
  const indices = Array.from({ length: n }, (_, i) => i);

  indices.sort((a, b) => {
    const depthDiff = resolvedDepths[b] - resolvedDepths[a];
    if (Math.abs(depthDiff) > 1e-6) {
      return depthDiff;
    }
    const orderDiff = layers[a].order - layers[b].order;
    if (orderDiff !== 0) {
      return orderDiff;
    }
    return a - b;
  });

  return indices;
}

/**
 * Computes aperture scale factor kAperture.
 * kAperture = 0.35 × (2.8 / N)
 * @param {number} aperture
 * @returns {number}
 */
export function computeApertureK(aperture) {
  // kAperture = 0.35 × (2.8 / N)
  return APERTURE_K * (APERTURE_REF_N / aperture);
}

/**
 * Computes blur radius in reference pixels for a given depth and focus setting.
 * excess = max(0, |d − dFocus| − tolerance)
 * sigmaRef = min(maxBlur, excess × kAperture)
 * @param {number} depth
 * @param {number} focus
 * @param {Optics} optics
 * @returns {number}
 */
export function computeSigmaRef(depth, focus, optics) {
  const kAperture = computeApertureK(optics.aperture);
  // excess = max(0, |d − dFocus| − tolerance)
  const excess = Math.max(0, Math.abs(depth - focus) - optics.tolerance);
  // sigmaRef = min(maxBlur, excess × kAperture)
  return Math.min(optics.maxBlur, excess * kAperture);
}

/**
 * Computes effective blur radius in reference pixels for a layer considering its focusMode.
 * @param {FocusMode} focusMode
 * @param {number} depth
 * @param {number} focus
 * @param {number} fixedBlur
 * @param {Optics} optics
 * @returns {number}
 */
export function computeLayerSigmaRef(focusMode, depth, focus, fixedBlur, optics) {
  switch (focusMode) {
    case 'sharp':
      return 0;
    case 'fixed':
      return Math.min(fixedBlur, optics.maxBlur);
    case 'dynamic':
    default:
      return computeSigmaRef(depth, focus, optics);
  }
}

/**
 * Computes mipmap LOD level from blur sigma, texel density, and maximum level.
 * sigmaTex = sigmaRender × texelsPerPixel
 * lodBlur  = 0.5 × log2(3 × sigmaTex² + 1)
 * lodMin   = log2(max(1, texelsPerPixel))
 * lod      = clamp(max(lodBlur, lodMin), 0, lastLevel)
 * @param {number} sigmaRender
 * @param {number} texelsPerPixel
 * @param {number} lastLevel
 * @returns {number}
 */
export function computeLod(sigmaRender, texelsPerPixel, lastLevel) {
  // sigmaTex = sigmaRender × texelsPerPixel
  const sigmaTex = sigmaRender * texelsPerPixel;
  // lodBlur  = 0.5 × log2(3 × sigmaTex² + 1)
  const lodBlur = 0.5 * Math.log2(3 * sigmaTex * sigmaTex + 1);
  // lodMin   = log2(max(1, texelsPerPixel))
  const lodMin = Math.log2(Math.max(1, texelsPerPixel));
  // lod      = clamp(max(lodBlur, lodMin), 0, lastLevel)
  const rawLod = Math.max(lodBlur, lodMin);
  return Math.min(Math.max(rawLod, 0), lastLevel);
}

/**
 * Computes equivalent sigmaTex for a given mip level k.
 * sigma_k ≈ sqrt((4^k − 1) / 3)
 * @param {number} k
 * @returns {number}
 */
export function computeLevelSigmaTex(k) {
  // sigma_k ≈ sqrt((4^k − 1) / 3)
  return Math.sqrt((Math.pow(4, k) - 1) / 3);
}

/**
 * Computes global breathing zoom scale based on focus distance and breathing coefficient.
 * zoom = 1 + breathing × (1 − focus / 100)
 * @param {number} focus
 * @param {number} breathing
 * @returns {number}
 */
export function computeBreathingZoom(focus, breathing) {
  // zoom = 1 + breathing × (1 − focus / 100)
  return 1 + breathing * (1 - focus / 100);
}
