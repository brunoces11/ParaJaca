// Scene model and factory functions for ParaJaca scene format v1.
// Pure module, zero execution dependencies.

/** @typedef {{ width: number, height: number }} Size */
/** @typedef {{ x: number, y: number }} Point */
/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */
/** @typedef {'png' | 'webp' | 'svg' | 'jpg'} AssetType */
/** @typedef {'dynamic' | 'fixed' | 'sharp'} FocusMode */
/** @typedef {'auto' | 'high' | 'mid' | 'low'} QualityPresetName */
/** @typedef {60 | 30 | 'free'} FpsTarget */

/**
 * @typedef {Object} Asset
 * @property {string} id
 * @property {string} name
 * @property {AssetType} type
 * @property {number} width
 * @property {number} height
 * @property {string} path
 */

/**
 * @typedef {Object} Optics
 * @property {number} focus
 * @property {number} aperture
 * @property {number} tolerance
 * @property {number} maxBlur
 * @property {[number, number]} focusRange
 * @property {number} focusSpeed
 * @property {number} breathing
 */

/**
 * @typedef {Object} Motion
 * @property {number} intensity
 * @property {number} smoothing
 * @property {boolean} axisY
 * @property {'infinity' | 'focus'} anchor
 * @property {boolean} drift
 */

/**
 * @typedef {Object} Quality
 * @property {QualityPresetName} preset
 * @property {FpsTarget} fpsTarget
 */

/**
 * @typedef {Object} Layer
 * @property {string} id
 * @property {string} assetId
 * @property {Rect} placement
 * @property {number | null} depth
 * @property {number | null} [parallaxPercent] 0-100; null or absent = evenly spaced by order
 * @property {FocusMode} focusMode
 * @property {number} fixedBlur
 * @property {number} order
 */

/**
 * @typedef {Object} Variant
 * @property {string} id
 * @property {string} name
 * @property {Layer[]} layers
 * @property {Optics} optics
 * @property {Motion} motion
 * @property {Quality} quality
 */

/**
 * @typedef {Object} Scene
 * @property {1} formatVersion
 * @property {string} id
 * @property {string} name
 * @property {Size} reference
 * @property {Point} pointOfInterest
 * @property {string | null} posterAssetId
 * @property {string} defaultVariantId
 * @property {Asset[]} assets
 * @property {Variant[]} variants
 */

export const FORMAT_VERSION = 1;
export const MIN_LAYERS = 4;
export const MAX_LAYERS = 11;
export const APERTURE_MIN = 1.4;
export const APERTURE_MAX = 16;
export const BREATHING_MAX = 0.02;
export const MAX_BLUR_CEILING_REF = 48; // calibrate
export const INTENSITY_CEILING_REF = 120; // calibrate

/** @type {Optics} */
export const DEFAULT_OPTICS = Object.freeze({
  focus: 50,
  aperture: 2.8,
  tolerance: 5,
  maxBlur: 24,
  focusRange: /** @type {[number, number]} */ ([0, 100]),
  focusSpeed: 0.5,
  breathing: 0,
}); // calibrate

/** @type {Motion} */
export const DEFAULT_MOTION = Object.freeze({
  intensity: 40,
  smoothing: 0.5,
  axisY: true,
  anchor: 'infinity',
  drift: false,
}); // calibrate

/** @type {Quality} */
export const DEFAULT_QUALITY = Object.freeze({
  preset: 'auto',
  fpsTarget: 60,
});

export const IMPORT_SUFFIX_REGEX = /_(\d{1,2})\.(png|webp|svg|jpe?g)$/i;

/**
 * Generates a unique UUID v4.
 * @returns {string}
 */
export function createId() {
  return globalThis.crypto.randomUUID();
}

/**
 * Creates a default Variant with cloned default parameters.
 * @param {string} name
 * @param {Layer[]} layers
 * @returns {Variant}
 */
export function createDefaultVariant(name, layers) {
  return {
    id: createId(),
    name,
    layers: structuredClone(layers),
    optics: structuredClone(DEFAULT_OPTICS),
    motion: structuredClone(DEFAULT_MOTION),
    quality: structuredClone(DEFAULT_QUALITY),
  };
}

/**
 * Creates a Layer with default placement matching reference size.
 * @param {string} assetId
 * @param {number} order
 * @param {Size} reference
 * @returns {Layer}
 */
export function createLayer(assetId, order, reference) {
  return {
    id: createId(),
    assetId,
    placement: {
      x: 0,
      y: 0,
      width: reference.width,
      height: reference.height,
    },
    depth: null,
    focusMode: 'dynamic',
    fixedBlur: 0,
    order,
  };
}

/**
 * Retrieves a Variant by its id from a Scene.
 * @param {Scene} scene
 * @param {string} variantId
 * @returns {Variant | null}
 */
export function getVariant(scene, variantId) {
  return scene.variants.find((v) => v.id === variantId) ?? null;
}

/**
 * Clones a Scene deeply without mutating the input.
 * @param {Scene} scene
 * @returns {Scene}
 */
export function cloneScene(scene) {
  return structuredClone(scene);
}
