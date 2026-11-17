// Quality presets and render scale steps for ParaJaca.
// Implements R§13.1 (presets and scale steps). Zero execution dependencies.

export const QUALITY_PRESETS = Object.freeze(/** @type {const} */ ({
  high: { renderScale: 1.0, textureMaxHeight: 2160 }, // calibrate
  mid: { renderScale: 0.85, textureMaxHeight: 1440 }, // calibrate
  low: { renderScale: 0.7, textureMaxHeight: 1080 }, // calibrate
}));

export const RENDER_SCALE_STEPS = Object.freeze([1.0, 0.85, 0.7, 0.5]);
