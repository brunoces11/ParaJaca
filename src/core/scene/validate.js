// Pure validation module for ParaJaca scene format v1.
// Never throws, never mutates input.

import {
  FORMAT_VERSION,
  MIN_LAYERS,
  MAX_LAYERS,
  APERTURE_MIN,
  APERTURE_MAX,
  BREATHING_MAX,
  MAX_BLUR_CEILING_REF,
  INTENSITY_CEILING_REF,
  DEFAULT_OPTICS,
  DEFAULT_MOTION,
  DEFAULT_QUALITY,
} from './model.js';

/**
 * @typedef {import('./model.js').Scene} Scene
 * @typedef {import('./model.js').Asset} Asset
 * @typedef {import('./model.js').Variant} Variant
 * @typedef {import('./model.js').Layer} Layer
 * @typedef {import('./model.js').Optics} Optics
 * @typedef {import('./model.js').Motion} Motion
 * @typedef {import('./model.js').Quality} Quality
 * @typedef {import('./model.js').AssetType} AssetType
 * @typedef {import('./model.js').FocusMode} FocusMode
 * @typedef {import('./model.js').QualityPresetName} QualityPresetName
 * @typedef {import('./model.js').FpsTarget} FpsTarget
 */

/**
 * @typedef {{ ok: true, scene: Scene }
 *         | { ok: false, code: 'invalid-scene' | 'unsupported-format-version',
 *             errors: string[] }} ValidationResult
 */

const VALID_ASSET_TYPES = new Set(['png', 'webp', 'svg', 'jpg', 'lottie', 'dotlottie']);
const VALID_FOCUS_MODES = new Set(['dynamic', 'fixed', 'sharp']);
const VALID_PRESETS = new Set(['auto', 'high', 'mid', 'low']);
const VALID_FPS_TARGETS = new Set([60, 30, 'free']);
const VALID_ANCHORS = new Set(['infinity', 'focus']);

/**
 * Validates a scene input, discards unknown fields, applies defaults.
 * @param {unknown} input
 * @returns {ValidationResult}
 */
export function validateScene(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      ok: false,
      code: 'invalid-scene',
      errors: ['input: expected object'],
    };
  }

  /** @type {Record<string, unknown>} */
  const raw = /** @type {Record<string, unknown>} */ (input);
  const errors = [];

  // 1. Check formatVersion
  if (typeof raw.formatVersion !== 'number' || !Number.isInteger(raw.formatVersion)) {
    errors.push('formatVersion: expected integer');
  } else if (raw.formatVersion > FORMAT_VERSION) {
    return {
      ok: false,
      code: 'unsupported-format-version',
      errors: [`formatVersion: ${raw.formatVersion} is greater than supported version ${FORMAT_VERSION}`],
    };
  } else if (raw.formatVersion < 1) {
    errors.push('formatVersion: expected 1');
  }

  // 2. Scene id & name
  if (typeof raw.id !== 'string' || raw.id.trim() === '') {
    errors.push('id: expected non-empty string');
  }
  if (typeof raw.name !== 'string') {
    errors.push('name: expected string');
  }

  // 3. Reference size
  let refWidth = 0;
  let refHeight = 0;
  if (typeof raw.reference !== 'object' || raw.reference === null || Array.isArray(raw.reference)) {
    errors.push('reference: expected object');
  } else {
    const rawRef = /** @type {Record<string, unknown>} */ (raw.reference);
    if (typeof rawRef.width !== 'number' || !Number.isFinite(rawRef.width) || rawRef.width <= 0) {
      errors.push('reference.width: expected positive finite number');
    } else {
      refWidth = rawRef.width;
    }
    if (typeof rawRef.height !== 'number' || !Number.isFinite(rawRef.height) || rawRef.height <= 0) {
      errors.push('reference.height: expected positive finite number');
    } else {
      refHeight = rawRef.height;
    }
  }

  // 4. Point of interest
  let poiX = 0.5;
  let poiY = 0.5;
  if (typeof raw.pointOfInterest !== 'object' || raw.pointOfInterest === null || Array.isArray(raw.pointOfInterest)) {
    errors.push('pointOfInterest: expected object');
  } else {
    const rawPoi = /** @type {Record<string, unknown>} */ (raw.pointOfInterest);
    if (typeof rawPoi.x !== 'number' || !Number.isFinite(rawPoi.x) || rawPoi.x < 0 || rawPoi.x > 1) {
      errors.push('pointOfInterest.x: expected number between 0 and 1');
    } else {
      poiX = rawPoi.x;
    }
    if (typeof rawPoi.y !== 'number' || !Number.isFinite(rawPoi.y) || rawPoi.y < 0 || rawPoi.y > 1) {
      errors.push('pointOfInterest.y: expected number between 0 and 1');
    } else {
      poiY = rawPoi.y;
    }
  }

  // 5. Assets validation
  /** @type {Asset[]} */
  const cleanAssets = [];
  /** @type {Set<string>} */
  const assetIdSet = new Set();

  if (!Array.isArray(raw.assets)) {
    errors.push('assets: expected array');
  } else {
    for (let i = 0; i < raw.assets.length; i++) {
      const a = raw.assets[i];
      if (typeof a !== 'object' || a === null || Array.isArray(a)) {
        errors.push(`assets[${i}]: expected object`);
        continue;
      }
      const rawAsset = /** @type {Record<string, unknown>} */ (a);
      let assetOk = true;

      if (typeof rawAsset.id !== 'string' || rawAsset.id.trim() === '') {
        errors.push(`assets[${i}].id: expected non-empty string`);
        assetOk = false;
      } else if (assetIdSet.has(rawAsset.id)) {
        errors.push(`assets[${i}].id: duplicate asset id "${rawAsset.id}"`);
        assetOk = false;
      }

      if (typeof rawAsset.name !== 'string') {
        errors.push(`assets[${i}].name: expected string`);
        assetOk = false;
      }

      if (typeof rawAsset.type !== 'string' || !VALID_ASSET_TYPES.has(rawAsset.type)) {
        errors.push(`assets[${i}].type: expected PNG, WebP, SVG, JPG, Lottie JSON, or dotLottie`);
        assetOk = false;
      }

      if (typeof rawAsset.width !== 'number' || !Number.isFinite(rawAsset.width) || rawAsset.width <= 0) {
        errors.push(`assets[${i}].width: expected positive finite number`);
        assetOk = false;
      }

      if (typeof rawAsset.height !== 'number' || !Number.isFinite(rawAsset.height) || rawAsset.height <= 0) {
        errors.push(`assets[${i}].height: expected positive finite number`);
        assetOk = false;
      }

      if (typeof rawAsset.path !== 'string') {
        errors.push(`assets[${i}].path: expected string`);
        assetOk = false;
      } else {
        const p = rawAsset.path;
        if (p.includes('://') || p.startsWith('/') || p.includes('..') || p.trim() === '') {
          errors.push(`assets[${i}].path: invalid relative path "${p}" (must not start with /, contain ://, or ..)`);
          assetOk = false;
        }
      }

      if (assetOk) {
        const validId = /** @type {string} */ (rawAsset.id);
        assetIdSet.add(validId);
        cleanAssets.push({
          id: validId,
          name: /** @type {string} */ (rawAsset.name),
          type: /** @type {AssetType} */ (rawAsset.type),
          width: /** @type {number} */ (rawAsset.width),
          height: /** @type {number} */ (rawAsset.height),
          path: /** @type {string} */ (rawAsset.path),
        });
      }
    }
  }

  // 6. posterAssetId
  let posterAssetId = null;
  if (raw.posterAssetId !== undefined && raw.posterAssetId !== null) {
    if (typeof raw.posterAssetId !== 'string') {
      errors.push('posterAssetId: expected string or null');
    } else if (!assetIdSet.has(raw.posterAssetId)) {
      errors.push(`posterAssetId: asset "${raw.posterAssetId}" does not exist in assets`);
    } else {
      posterAssetId = raw.posterAssetId;
    }
  }

  // 7. Variants validation
  /** @type {Variant[]} */
  const cleanVariants = [];
  /** @type {Set<string>} */
  const variantIdSet = new Set();
  /** @type {Set<string>} */
  const allLayerIds = new Set();

  if (!Array.isArray(raw.variants)) {
    errors.push('variants: expected array');
  } else {
    for (let vIdx = 0; vIdx < raw.variants.length; vIdx++) {
      const v = raw.variants[vIdx];
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        errors.push(`variants[${vIdx}]: expected object`);
        continue;
      }
      const rawVariant = /** @type {Record<string, unknown>} */ (v);
      const vPrefix = `variants[${vIdx}]`;

      if (typeof rawVariant.id !== 'string' || rawVariant.id.trim() === '') {
        errors.push(`${vPrefix}.id: expected non-empty string`);
      } else if (variantIdSet.has(rawVariant.id)) {
        errors.push(`${vPrefix}.id: duplicate variant id "${rawVariant.id}"`);
      } else {
        variantIdSet.add(rawVariant.id);
      }

      if (typeof rawVariant.name !== 'string') {
        errors.push(`${vPrefix}.name: expected string`);
      }

      // Layers
      /** @type {Layer[]} */
      const cleanLayers = [];
      if (!Array.isArray(rawVariant.layers)) {
        errors.push(`${vPrefix}.layers: expected array`);
      } else {
        if (rawVariant.layers.length < MIN_LAYERS || rawVariant.layers.length > MAX_LAYERS) {
          errors.push(`${vPrefix}.layers: layer count ${rawVariant.layers.length} out of bounds (${MIN_LAYERS} to ${MAX_LAYERS})`);
        }

        for (let lIdx = 0; lIdx < rawVariant.layers.length; lIdx++) {
          const l = rawVariant.layers[lIdx];
          const lPrefix = `${vPrefix}.layers[${lIdx}]`;
          if (typeof l !== 'object' || l === null || Array.isArray(l)) {
            errors.push(`${lPrefix}: expected object`);
            continue;
          }
          const rawLayer = /** @type {Record<string, unknown>} */ (l);

          let layerId = '';
          if (typeof rawLayer.id !== 'string' || rawLayer.id.trim() === '') {
            errors.push(`${lPrefix}.id: expected non-empty string`);
          } else if (allLayerIds.has(rawLayer.id)) {
            errors.push(`${lPrefix}.id: duplicate layer id "${rawLayer.id}"`);
          } else {
            layerId = rawLayer.id;
            allLayerIds.add(layerId);
          }

          let assetId = '';
          if (typeof rawLayer.assetId !== 'string') {
            errors.push(`${lPrefix}.assetId: expected string`);
          } else if (!assetIdSet.has(rawLayer.assetId)) {
            errors.push(`${lPrefix}.assetId: asset "${rawLayer.assetId}" does not exist in assets`);
          } else {
            assetId = rawLayer.assetId;
          }

          // Validate the authored rectangle; native asset dimensions are applied below.
          let placement = { x: 0, y: 0, width: refWidth, height: refHeight };
          if (rawLayer.placement !== undefined) {
            if (typeof rawLayer.placement !== 'object' || rawLayer.placement === null || Array.isArray(rawLayer.placement)) {
              errors.push(`${lPrefix}.placement: expected object`);
            } else {
              const p = /** @type {Record<string, unknown>} */ (rawLayer.placement);
              const px = typeof p.x === 'number' && Number.isFinite(p.x) ? p.x : null;
              const py = typeof p.y === 'number' && Number.isFinite(p.y) ? p.y : null;
              const pw = typeof p.width === 'number' && Number.isFinite(p.width) && p.width > 0 ? p.width : null;
              const ph = typeof p.height === 'number' && Number.isFinite(p.height) && p.height > 0 ? p.height : null;
              if (px === null || py === null || pw === null || ph === null) {
                errors.push(`${lPrefix}.placement: invalid rect values`);
              } else {
                placement = { x: px, y: py, width: pw, height: ph };
              }
            }
          }

          // Geometry uses native asset pixels; X/Y remain author-controlled.
          const asset = cleanAssets.find((a) => a.id === assetId);
          if (asset) {
            placement.width = asset.width;
            placement.height = asset.height;
          }

          let parallaxPercent = null;
          if (rawLayer.parallaxPercent !== undefined && rawLayer.parallaxPercent !== null) {
            if (typeof rawLayer.parallaxPercent !== 'number'
              || !Number.isFinite(rawLayer.parallaxPercent)
              || rawLayer.parallaxPercent < 0 || rawLayer.parallaxPercent > 100) {
              errors.push(`${lPrefix}.parallaxPercent: out of range (0-100 or null)`);
            } else {
              parallaxPercent = rawLayer.parallaxPercent;
            }
          }

          // Depth: null or 0..100
          let depth = null;
          if (rawLayer.depth !== undefined && rawLayer.depth !== null) {
            if (typeof rawLayer.depth !== 'number' || !Number.isFinite(rawLayer.depth) || rawLayer.depth < 0 || rawLayer.depth > 100) {
              errors.push(`${lPrefix}.depth: out of range (0-100 or null)`);
            } else {
              depth = rawLayer.depth;
            }
          }

          // FocusMode: 'dynamic' | 'fixed' | 'sharp' (default 'dynamic')
          let focusMode = /** @type {FocusMode} */ ('dynamic');
          if (rawLayer.focusMode !== undefined) {
            if (typeof rawLayer.focusMode !== 'string' || !VALID_FOCUS_MODES.has(rawLayer.focusMode)) {
              errors.push(`${lPrefix}.focusMode: expected 'dynamic', 'fixed', or 'sharp'`);
            } else {
              focusMode = /** @type {FocusMode} */ (rawLayer.focusMode);
            }
          }

          // FixedBlur: 0..MAX_BLUR_CEILING_REF (default 0)
          let fixedBlur = 0;
          if (rawLayer.fixedBlur !== undefined) {
            if (typeof rawLayer.fixedBlur !== 'number' || !Number.isFinite(rawLayer.fixedBlur) || rawLayer.fixedBlur < 0 || rawLayer.fixedBlur > MAX_BLUR_CEILING_REF) {
              errors.push(`${lPrefix}.fixedBlur: out of range (0-${MAX_BLUR_CEILING_REF})`);
            } else {
              fixedBlur = rawLayer.fixedBlur;
            }
          }

          // Order: number
          let order = 0;
          if (typeof rawLayer.order !== 'number' || !Number.isFinite(rawLayer.order)) {
            errors.push(`${lPrefix}.order: expected finite number`);
          } else {
            order = rawLayer.order;
          }

          cleanLayers.push({
            id: layerId,
            assetId,
            placement,
            parallaxPercent,
            depth,
            focusMode,
            fixedBlur,
            order,
          });
        }
      }

      // Optics
      const optics = structuredClone(DEFAULT_OPTICS);
      if (rawVariant.optics !== undefined) {
        if (typeof rawVariant.optics !== 'object' || rawVariant.optics === null || Array.isArray(rawVariant.optics)) {
          errors.push(`${vPrefix}.optics: expected object`);
        } else {
          const o = /** @type {Record<string, unknown>} */ (rawVariant.optics);
          if (o.focus !== undefined) {
            if (typeof o.focus !== 'number' || !Number.isFinite(o.focus) || o.focus < 0 || o.focus > 100) {
              errors.push(`${vPrefix}.optics.focus: out of range (0-100)`);
            } else {
              optics.focus = o.focus;
            }
          }
          if (o.aperture !== undefined) {
            if (typeof o.aperture !== 'number' || !Number.isFinite(o.aperture) || o.aperture < APERTURE_MIN || o.aperture > APERTURE_MAX) {
              errors.push(`${vPrefix}.optics.aperture: out of range (${APERTURE_MIN}-${APERTURE_MAX})`);
            } else {
              optics.aperture = o.aperture;
            }
          }
          if (o.tolerance !== undefined) {
            if (typeof o.tolerance !== 'number' || !Number.isFinite(o.tolerance) || o.tolerance < 0 || o.tolerance > 100) {
              errors.push(`${vPrefix}.optics.tolerance: out of range (0-100)`);
            } else {
              optics.tolerance = o.tolerance;
            }
          }
          if (o.maxBlur !== undefined) {
            if (typeof o.maxBlur !== 'number' || !Number.isFinite(o.maxBlur) || o.maxBlur < 0 || o.maxBlur > MAX_BLUR_CEILING_REF) {
              errors.push(`${vPrefix}.optics.maxBlur: out of range (0-${MAX_BLUR_CEILING_REF})`);
            } else {
              optics.maxBlur = o.maxBlur;
            }
          }
          if (o.focusRange !== undefined) {
            if (!Array.isArray(o.focusRange) || o.focusRange.length !== 2 ||
                typeof o.focusRange[0] !== 'number' || !Number.isFinite(o.focusRange[0]) || o.focusRange[0] < 0 || o.focusRange[0] > 100 ||
                typeof o.focusRange[1] !== 'number' || !Number.isFinite(o.focusRange[1]) || o.focusRange[1] < 0 || o.focusRange[1] > 100 ||
                o.focusRange[0] > o.focusRange[1]) {
              errors.push(`${vPrefix}.optics.focusRange: expected [min, max] with 0 <= min <= max <= 100`);
            } else {
              optics.focusRange = [o.focusRange[0], o.focusRange[1]];
            }
          }
          if (o.focusSpeed !== undefined) {
            if (typeof o.focusSpeed !== 'number' || !Number.isFinite(o.focusSpeed) || o.focusSpeed < 0 || o.focusSpeed > 1) {
              errors.push(`${vPrefix}.optics.focusSpeed: out of range (0-1)`);
            } else {
              optics.focusSpeed = o.focusSpeed;
            }
          }
          if (o.breathing !== undefined) {
            if (typeof o.breathing !== 'number' || !Number.isFinite(o.breathing) || o.breathing < 0 || o.breathing > BREATHING_MAX) {
              errors.push(`${vPrefix}.optics.breathing: out of range (0-${BREATHING_MAX})`);
            } else {
              optics.breathing = o.breathing;
            }
          }
        }
      }

      // Motion
      const motion = structuredClone(DEFAULT_MOTION);
      if (rawVariant.motion !== undefined) {
        if (typeof rawVariant.motion !== 'object' || rawVariant.motion === null || Array.isArray(rawVariant.motion)) {
          errors.push(`${vPrefix}.motion: expected object`);
        } else {
          const m = /** @type {Record<string, unknown>} */ (rawVariant.motion);
          if (m.intensity !== undefined) {
            if (typeof m.intensity !== 'number' || !Number.isFinite(m.intensity) || m.intensity < 0 || m.intensity > INTENSITY_CEILING_REF) {
              errors.push(`${vPrefix}.motion.intensity: out of range (0-${INTENSITY_CEILING_REF})`);
            } else {
              motion.intensity = m.intensity;
            }
          }
          if (m.smoothing !== undefined) {
            if (typeof m.smoothing !== 'number' || !Number.isFinite(m.smoothing) || m.smoothing < 0 || m.smoothing > 1) {
              errors.push(`${vPrefix}.motion.smoothing: out of range (0-1)`);
            } else {
              motion.smoothing = m.smoothing;
            }
          }
          if (m.axisY !== undefined) {
            if (typeof m.axisY !== 'boolean') {
              errors.push(`${vPrefix}.motion.axisY: expected boolean`);
            } else {
              motion.axisY = m.axisY;
            }
          }
          if (m.anchor !== undefined) {
            if (typeof m.anchor !== 'string' || !VALID_ANCHORS.has(m.anchor)) {
              errors.push(`${vPrefix}.motion.anchor: expected 'infinity' or 'focus'`);
            } else {
              motion.anchor = /** @type {'infinity' | 'focus'} */ (m.anchor);
            }
          }
          if (m.drift !== undefined) {
            if (typeof m.drift !== 'boolean') {
              errors.push(`${vPrefix}.motion.drift: expected boolean`);
            } else {
              motion.drift = m.drift;
            }
          }
        }
      }

      // Quality
      const quality = structuredClone(DEFAULT_QUALITY);
      if (rawVariant.quality !== undefined) {
        if (typeof rawVariant.quality !== 'object' || rawVariant.quality === null || Array.isArray(rawVariant.quality)) {
          errors.push(`${vPrefix}.quality: expected object`);
        } else {
          const q = /** @type {Record<string, unknown>} */ (rawVariant.quality);
          if (q.preset !== undefined) {
            if (typeof q.preset !== 'string' || !VALID_PRESETS.has(q.preset)) {
              errors.push(`${vPrefix}.quality.preset: expected one of 'auto', 'high', 'mid', 'low'`);
            } else {
              quality.preset = /** @type {QualityPresetName} */ (q.preset);
            }
          }
          if (q.fpsTarget !== undefined) {
            if (!VALID_FPS_TARGETS.has(/** @type {FpsTarget} */ (q.fpsTarget))) {
              errors.push(`${vPrefix}.quality.fpsTarget: expected 60, 30, or 'free'`);
            } else {
              quality.fpsTarget = /** @type {FpsTarget} */ (q.fpsTarget);
            }
          }
        }
      }

      cleanVariants.push({
        id: typeof rawVariant.id === 'string' ? rawVariant.id : '',
        name: typeof rawVariant.name === 'string' ? rawVariant.name : '',
        layers: cleanLayers,
        optics,
        motion,
        quality,
      });
    }
  }

  // 8. defaultVariantId
  if (typeof raw.defaultVariantId !== 'string' || raw.defaultVariantId.trim() === '') {
    errors.push('defaultVariantId: expected non-empty string');
  } else if (!variantIdSet.has(raw.defaultVariantId)) {
    errors.push(`defaultVariantId: variant "${raw.defaultVariantId}" does not exist in variants`);
  }

  if (errors.length > 0) {
    return {
      ok: false,
      code: 'invalid-scene',
      errors,
    };
  }

  /** @type {Scene} */
  const cleanScene = {
    formatVersion: 1,
    id: /** @type {string} */ (raw.id),
    name: /** @type {string} */ (raw.name),
    reference: { width: refWidth, height: refHeight },
    pointOfInterest: { x: poiX, y: poiY },
    posterAssetId,
    defaultVariantId: /** @type {string} */ (raw.defaultVariantId),
    assets: cleanAssets,
    variants: cleanVariants,
  };

  return {
    ok: true,
    scene: cleanScene,
  };
}
