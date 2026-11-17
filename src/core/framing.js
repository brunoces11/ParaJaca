// Pure framing and camera layout module for ParaJaca.
// Implements R§12.11. Zero execution dependencies.

export const FRAMING_MAX_ZOOM = 1.25; // calibrate
const REFERENCE_HEIGHT = 1080;

/**
 * @typedef {Object} FrameLayout
 * @property {number} renderPxPerCompPx
 * @property {number} cameraXComp
 * @property {number} cameraYComp
 * @property {number} marginXComp
 * @property {number} marginYComp
 * @property {number} offsetLimitXRef
 * @property {number} offsetLimitYRef
 * @property {boolean} isMarginInsufficient
 */

/**
 * @param {number} val
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(val, min, max) {
  if (min > max) {
    return (min + max) / 2;
  }
  return Math.min(Math.max(val, min), max);
}

/**
 * Computes frame layout and camera placement based on composition, canvas, and parallax margins.
 * Follows the 8 steps of R§12.11.
 * @param {Object} options
 * @param {{ width: number, height: number }} options.reference
 * @param {{ x: number, y: number }} options.pointOfInterest
 * @param {number} options.canvasWidthRender
 * @param {number} options.canvasHeightRender
 * @param {Array<{ maxOffsetXRef: number, maxOffsetYRef: number }>} options.edgeLayers
 * @returns {FrameLayout}
 */
export function computeFrameLayout({
  reference,
  pointOfInterest,
  canvasWidthRender,
  canvasHeightRender,
  edgeLayers,
}) {
  // 1. refToComp
  const refToComp = reference.height / REFERENCE_HEIGHT;

  // 2. needXComp, needYComp
  let maxOffsetXRef = 0;
  let maxOffsetYRef = 0;
  for (let i = 0; i < edgeLayers.length; i++) {
    const el = edgeLayers[i];
    if (el.maxOffsetXRef > maxOffsetXRef) maxOffsetXRef = el.maxOffsetXRef;
    if (el.maxOffsetYRef > maxOffsetYRef) maxOffsetYRef = el.maxOffsetYRef;
  }
  const needXComp = maxOffsetXRef * refToComp;
  const needYComp = maxOffsetYRef * refToComp;

  // 3. limitXComp, limitYComp
  const limitXComp = (reference.width * (1 - 1 / FRAMING_MAX_ZOOM)) / 2;
  const limitYComp = (reference.height * (1 - 1 / FRAMING_MAX_ZOOM)) / 2;

  // 4. marginXComp, marginYComp, isMarginInsufficient, offsetLimits
  const marginXComp = Math.min(needXComp, limitXComp);
  const marginYComp = Math.min(needYComp, limitYComp);
  const isMarginInsufficient = needXComp > limitXComp || needYComp > limitYComp;
  const offsetLimitXRef = needXComp > limitXComp ? limitXComp / refToComp : Infinity;
  const offsetLimitYRef = needYComp > limitYComp ? limitYComp / refToComp : Infinity;

  // 5. visibleW, visibleH
  const visibleW = reference.width - 2 * marginXComp;
  const visibleH = reference.height - 2 * marginYComp;

  // 6. renderPxPerCompPx (cover)
  const renderPxPerCompPx = Math.max(
    canvasWidthRender / visibleW,
    canvasHeightRender / visibleH,
  );

  // 7. halfViewW, halfViewH
  const halfViewW = canvasWidthRender / (2 * renderPxPerCompPx);
  const halfViewH = canvasHeightRender / (2 * renderPxPerCompPx);

  // 8. cameraXComp, cameraYComp
  const cameraXComp = clamp(
    pointOfInterest.x * reference.width,
    marginXComp + halfViewW,
    reference.width - marginXComp - halfViewW,
  );
  const cameraYComp = clamp(
    pointOfInterest.y * reference.height,
    marginYComp + halfViewH,
    reference.height - marginYComp - halfViewH,
  );

  return {
    renderPxPerCompPx,
    cameraXComp,
    cameraYComp,
    marginXComp,
    marginYComp,
    offsetLimitXRef,
    offsetLimitYRef,
    isMarginInsufficient,
  };
}
