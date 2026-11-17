// Pure motion formulas for ParaJaca: parallax, smoothing, drift, convergence, and reduced motion.
// Implements R§12.6-R§12.10. Zero execution dependencies.

export const MAX_DT_SEC = 0.1;
export const INPUT_K_MIN = 2; // calibrate
export const INPUT_K_MAX = 30; // calibrate
export const FOCUS_K_MIN = 1; // calibrate
export const FOCUS_K_MAX = 20; // calibrate

export const DRIFT_IDLE_SEC = 3;
export const DRIFT_AMPLITUDE_X = 0.15; // calibrate
export const DRIFT_AMPLITUDE_Y = 0.1; // calibrate
export const DRIFT_PERIOD_X_SEC = 11; // calibrate
export const DRIFT_PERIOD_Y_SEC = 7; // calibrate

export const CONVERGENCE_OFFSET_RENDER = 0.1; // calibrate
export const CONVERGENCE_SIGMA_RENDER = 0.05; // calibrate

export const REDUCED_MOTION_INTENSITY_FACTOR = 0.2;
export const REDUCED_MOTION_FOCUS_K_FACTOR = 3;

/**
 * Computes anchor depth: 'infinity' -> 100, 'focus' -> focus.
 * @param {'infinity' | 'focus'} anchor
 * @param {number} focus
 * @returns {number}
 */
export function computeAnchorDepth(anchor, focus) {
  // 'infinity' → 100; 'focus' → focus
  return anchor === 'focus' ? focus : 100;
}

/**
 * Computes parallax offset in reference pixels.
 * offset = −input × intensity × ((dAnchor − d) / 100)
 * @param {number} input
 * @param {number} intensityRef
 * @param {number} anchorDepth
 * @param {number} depth
 * @returns {number}
 */
export function computeParallaxOffsetRef(input, intensityRef, anchorDepth, depth) {
  // offset = −input × intensity × ((dAnchor − d) / 100)
  return -input * intensityRef * ((anchorDepth - depth) / 100);
}

/**
 * Resolves independent motion weights, back to front, without changing optical depths.
 * @param {import('./scene/model.js').Layer[]} layers
 * @returns {Float32Array}
 */
export function resolveParallaxPercents(layers) {
  const indices = layers.map((_, index) => index);
  indices.sort((a, b) => layers[a].order - layers[b].order || a - b);
  const percents = new Float32Array(layers.length);
  indices.forEach((index, position) => {
    const autoPercent = layers.length === 1 ? 0 : position * 100 / (layers.length - 1);
    percents[index] = layers[index].parallaxPercent ?? autoPercent;
  });
  return percents;
}

/**
 * Full motion amplitude is intensityRef at 100%, with no framing clamp.
 * @param {number} input Normalized pointer input, -1 to 1
 * @param {number} intensityRef
 * @param {number} parallaxPercent
 * @returns {number}
 */
export function computeLayerParallaxOffsetRef(input, intensityRef, parallaxPercent) {
  return -input * intensityRef * (parallaxPercent / 100);
}

/**
 * Clamps delta time in seconds to [0, MAX_DT_SEC].
 * @param {number} dtSec
 * @returns {number}
 */
export function clampDt(dtSec) {
  return Math.min(Math.max(dtSec, 0), MAX_DT_SEC);
}

/**
 * Computes input smoothing coefficient k (higher smoothing = slower, lower k).
 * lerp(INPUT_K_MAX, INPUT_K_MIN, smoothing)
 * @param {number} smoothing
 * @returns {number}
 */
export function computeInputK(smoothing) {
  // lerp(INPUT_K_MAX, INPUT_K_MIN, smoothing)
  return INPUT_K_MAX + (INPUT_K_MIN - INPUT_K_MAX) * smoothing;
}

/**
 * Computes focus smoothing coefficient k (higher focusSpeed = faster, higher k).
 * lerp(FOCUS_K_MIN, FOCUS_K_MAX, focusSpeed)
 * @param {number} focusSpeed
 * @returns {number}
 */
export function computeFocusK(focusSpeed) {
  // lerp(FOCUS_K_MIN, FOCUS_K_MAX, focusSpeed)
  return FOCUS_K_MIN + (FOCUS_K_MAX - FOCUS_K_MIN) * focusSpeed;
}

/**
 * Smooth exponential step towards target.
 * cur += (target − cur) × (1 − exp(−k × dt))
 * @param {number} current
 * @param {number} target
 * @param {number} k
 * @param {number} dtSec
 * @returns {number}
 */
export function smoothStep(current, target, k, dtSec) {
  // cur += (target − cur) × (1 − exp(−k × dt))
  return current + (target - current) * (1 - Math.exp(-k * dtSec));
}

/**
 * Computes harmonic drift input for X axis.
 * AMP_X × sin(2π t / PERIOD_X)
 * @param {number} timeSec
 * @returns {number}
 */
export function computeDriftInputX(timeSec) {
  // AMP_X × sin(2π t / PERIOD_X)
  return DRIFT_AMPLITUDE_X * Math.sin((2 * Math.PI * timeSec) / DRIFT_PERIOD_X_SEC);
}

/**
 * Computes harmonic drift input for Y axis.
 * AMP_Y × sin(2π t / PERIOD_Y)
 * @param {number} timeSec
 * @returns {number}
 */
export function computeDriftInputY(timeSec) {
  // AMP_Y × sin(2π t / PERIOD_Y)
  return DRIFT_AMPLITUDE_Y * Math.sin((2 * Math.PI * timeSec) / DRIFT_PERIOD_Y_SEC);
}

/**
 * Determines whether animation has converged within visual thresholds.
 * @param {number} maxRemainingOffsetRender
 * @param {number} maxRemainingSigmaRender
 * @returns {boolean}
 */
export function isConverged(maxRemainingOffsetRender, maxRemainingSigmaRender) {
  return maxRemainingOffsetRender <= CONVERGENCE_OFFSET_RENDER &&
         maxRemainingSigmaRender <= CONVERGENCE_SIGMA_RENDER;
}
