// Pure layer requirements computation for texture sizing, padding, and mip levels.
// Implements R§13.2. Zero execution dependencies.

export const PADDING_SIGMA_FACTOR = 3; // calibrate
export const PADDING_RECON_TEX = 2; // calibrate
export const LOD_RESERVE_LEVELS = 1; // calibrate

const REFERENCE_HEIGHT = 1080; // keep in sync with optics.js
const APERTURE_K = 0.35; // keep in sync with optics.js
const APERTURE_REF_N = 2.8; // keep in sync with optics.js

/** @typedef {{ width: number, height: number }} Size */
/** @typedef {{ left: boolean, top: boolean, right: boolean, bottom: boolean }} CroppedSides */

/**
 * @typedef {Object} LayerRequirements
 * @property {number} texScale
 * @property {Size} contentSizeTex
 * @property {{ left: number, top: number, right: number, bottom: number }} paddingTex
 * @property {Size} textureSize
 * @property {number} levels
 * @property {number} maxLod
 * @property {number} sigmaMaxRef
 */

/**
 * Computes layer requirements for GPU texture allocation, paddings, and mip levels.
 * @param {Object} params
 * @param {import('../scene/model.js').Layer} params.layer
 * @param {number} params.resolvedDepth
 * @param {import('../scene/model.js').Asset} params.asset
 * @param {{ x: number, y: number, width: number, height: number }} params.contentRectComp
 * @param {CroppedSides} params.croppedSides
 * @param {import('../scene/model.js').Variant} params.variant
 * @param {Size} params.reference
 * @param {number} params.renderPxPerCompPxAtScale1
 * @param {{ renderScale: number, textureMaxHeight: number }} params.preset
 * @param {number} params.maxTextureSize
 * @returns {LayerRequirements}
 */
export function computeRequirements({
  layer,
  resolvedDepth,
  asset,
  contentRectComp,
  croppedSides,
  variant,
  reference,
  renderPxPerCompPxAtScale1,
  preset,
  maxTextureSize,
}) {
  const { optics } = variant;

  // 1. sigmaMaxRef
  let sigmaMaxRef = 0;
  if (layer.focusMode === 'sharp') {
    sigmaMaxRef = 0;
  } else if (layer.focusMode === 'fixed') {
    sigmaMaxRef = Math.min(layer.fixedBlur, optics.maxBlur);
  } else {
    // 'dynamic' -> computeSigmaRef at worst focus distance within focusRange
    // kAperture = 0.35 × (2.8 / N) // keep in sync with optics.js
    const kAperture = APERTURE_K * (APERTURE_REF_N / optics.aperture);
    const fMin = optics.focusRange[0];
    const fMax = optics.focusRange[1];
    const distToMin = Math.abs(resolvedDepth - fMin);
    const distToMax = Math.abs(resolvedDepth - fMax);
    const worstDist = Math.max(distToMin, distToMax);
    const excessMax = Math.max(0, worstDist - optics.tolerance);
    sigmaMaxRef = Math.min(optics.maxBlur, excessMax * kAperture);
  }

  // 2. texScale
  let texScale = Math.min(
    renderPxPerCompPxAtScale1 * (1 + optics.breathing),
    asset.width / layer.placement.width,
    preset.textureMaxHeight / reference.height,
  );

  // 3-5. Iterative sizing with texture bounds clamping
  let sigmaMaxTex = 0;
  let paddingTex = { left: 0, top: 0, right: 0, bottom: 0 };
  let contentSizeTex = { width: 1, height: 1 };
  let textureSize = { width: 1, height: 1 };

  for (let iter = 0; iter < 4; iter++) {
    // 3. sigmaMaxTex and paddings
    sigmaMaxTex = sigmaMaxRef * (reference.height / REFERENCE_HEIGHT) * texScale;
    const padOne = sigmaMaxRef > 0
      ? Math.ceil(PADDING_SIGMA_FACTOR * sigmaMaxTex + PADDING_RECON_TEX)
      : 0;

    paddingTex = {
      left: croppedSides.left ? padOne : 0,
      top: croppedSides.top ? padOne : 0,
      right: croppedSides.right ? padOne : 0,
      bottom: croppedSides.bottom ? padOne : 0,
    };

    // 4. contentSizeTex & textureSize
    contentSizeTex = {
      width: Math.max(1, Math.round(contentRectComp.width * texScale)),
      height: Math.max(1, Math.round(contentRectComp.height * texScale)),
    };

    textureSize = {
      width: contentSizeTex.width + paddingTex.left + paddingTex.right,
      height: contentSizeTex.height + paddingTex.top + paddingTex.bottom,
    };

    // 5. If exceeding maxTextureSize, reduce texScale proportionately (up to 3 iterations)
    if (textureSize.width > maxTextureSize || textureSize.height > maxTextureSize) {
      if (iter < 3) {
        const largestSide = Math.max(textureSize.width, textureSize.height);
        texScale *= (maxTextureSize / largestSide);
        continue;
      }
    }
    break;
  }

  // 6. lodBlurMax and mipmap levels
  const lodBlurMax = 0.5 * Math.log2(3 * sigmaMaxTex * sigmaMaxTex + 1);
  const fullChain = Math.floor(Math.log2(Math.max(textureSize.width, textureSize.height))) + 1;
  let levels = Math.min(
    fullChain,
    Math.ceil(Math.max(lodBlurMax, 1)) + 1 + LOD_RESERVE_LEVELS,
  );

  // 'sharp' also gets mipmaps: levels >= 2 when fullChain >= 2
  if (fullChain >= 2 && levels < 2) {
    levels = 2;
  }
  levels = Math.max(1, Math.min(fullChain, levels));
  const maxLod = levels - 1;

  return {
    texScale,
    contentSizeTex,
    paddingTex,
    textureSize,
    levels,
    maxLod,
    sigmaMaxRef,
  };
}

/**
 * Checks whether current allocated resources satisfy needed requirements.
 * @param {LayerRequirements} current
 * @param {LayerRequirements} needed
 * @returns {boolean}
 */
export function satisfiesRequirements(current, needed) {
  return current.texScale >= needed.texScale * (1 - 1e-6)
      && current.sigmaMaxRef >= needed.sigmaMaxRef - 1e-6
      && current.levels >= needed.levels;
}
