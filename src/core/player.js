// Main player facade: lifecycle, DOM, loading, layout, animated loop, pointer input, and diagnostics.
// Implements R§16, R§10.1, R§12.6-R§12.12. Core frame buffers are reused;
// optional animation engines manage their own bounded working data.

import { ParaJacaError, ERROR_CODES, isAbortError } from './errors.js';
import { cloneScene, getVariant } from './scene/model.js';
import { validateScene } from './scene/validate.js';
import {
  computeRefFactor,
  resolveDepths,
  computeDrawOrder,
  computeLayerSigmaRef,
  computeLod,
  computeBreathingZoom,
} from './optics.js';
import {
  resolveParallaxPercents,
  computeLayerParallaxOffsetRef,
  clampDt,
  computeInputK,
  computeFocusK,
  smoothStep,
  isConverged,
} from './motion.js';
import { computeFrameLayout } from './framing.js';
import { QUALITY_PRESETS } from './quality/presets.js';
import { computeRequirements } from './quality/requirements.js';
import { analyzeSource, decodeSource } from './sources/image-source.js';
import { createRenderer, createFrameState } from './render/renderer.js';
import { createAnimatedSource } from './sources/media-source.js';

export const DIRTY_FRAME = 1;
export const DIRTY_ORDER = 2;
export const DIRTY_LAYOUT = 4;
export const DIRTY_REQUIREMENTS = 8;
export const WHEEL_FOCUS_STEP = 2;

/**
 * @typedef {import('./scene/model.js').Scene} Scene
 * @typedef {import('./scene/model.js').Variant} Variant
 * @typedef {import('./scene/model.js').Optics} Optics
 * @typedef {import('./scene/model.js').Motion} Motion
 * @typedef {import('./scene/model.js').Quality} Quality
 * @typedef {import('./scene/model.js').Layer} Layer
 * @typedef {import('./scene/model.js').QualityPresetName} QualityPresetName
 * @typedef {import('./scene/model.js').FpsTarget} FpsTarget
 * @typedef {import('./errors.js').ErrorCode} ErrorCode
 * @typedef {import('./sources/image-source.js').AssetResolver} AssetResolver
 * @typedef {import('./render/renderer.js').FrameState} FrameState
 * @typedef {import('./framing.js').FrameLayout} FrameLayout
 * @typedef {import('./quality/requirements.js').LayerRequirements} LayerRequirements
 */

/**
 * @typedef {Object} DiagnosticsSample
 * @property {number} fps
 * @property {number} frameDurationMs
 * @property {number | null} gpuDurationMs
 * @property {number} drawCallCount
 * @property {number} activeLayers
 * @property {number} renderScale
 * @property {'high' | 'mid' | 'low'} preset
 * @property {number} memoryEstimateBytes
 * @property {boolean} isConverged
 * @property {boolean} isMarginInsufficient
 */

/**
 * @typedef {Object} PlayerOptions
 * @property {AssetResolver} [assetResolver]
 * @property {string} [variantId]
 * @property {QualityPresetName} [quality]
 * @property {FpsTarget} [fpsTarget]
 * @property {(sample: DiagnosticsSample) => void} [diagnostics]
 */

/**
 * @typedef {Object} PlayerCommand
 * @property {'set-optics' | 'set-motion' | 'set-variant-quality' | 'set-layer' | 'set-point-of-interest' | 'replace-scene'} type
 * @property {Partial<Optics>} [changesOptics]
 * @property {Partial<Motion>} [changesMotion]
 * @property {Partial<Quality>} [changesQuality]
 * @property {string} [layerId]
 * @property {Partial<Pick<Layer, 'depth'|'focusMode'|'fixedBlur'|'order'|'placement'|'parallaxPercent'>>} [changesLayer]
 * @property {number} [x]
 * @property {number} [y]
 * @property {Scene} [scene]
 */

/**
 * @typedef {Object} Player
 * @property {(source: string | Scene) => Promise<void>} load
 * @property {(id: string) => Promise<void>} setVariant
 * @property {(d: number, opts?: { animate?: boolean }) => void} setFocus
 * @property {(preset: QualityPresetName) => void} setQuality
 * @property {(intensity: number, intensityY?: number) => void} setIntensity
 * @property {() => void} resize
 * @property {(paused: boolean) => void} setAnimationPaused
 * @property {(event: string, handler: (payload: any) => void) => () => void} on
 * @property {() => void} dispose
 * @property {(command: PlayerCommand) => Promise<void>} edit
 * @property {(type?: string, quality?: number) => Promise<Blob>} capturePoster
 * @property {(layerId: string | null) => void} setRevealMode
 * @property {(scale: number | null) => void} setRenderScaleOverride
 * @property {() => Scene} getScene
 * @property {() => { isMarginInsufficient: boolean, renderScale: number, preset: 'high' | 'mid' | 'low' }} getLayoutInfo
 */

/**
 * Creates and initializes a ParaJaca player instance.
 * @param {HTMLElement} container
 * @param {PlayerOptions} [options]
 * @returns {Player}
 */
export function createPlayer(container, options = {}) {
  // 1. Create DOM (R§16.3)
  container.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'parajaca-root';
  root.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden';

  const poster = document.createElement('img');
  poster.className = 'parajaca-poster';
  poster.alt = '';
  poster.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none';

  const canvas = document.createElement('canvas');
  canvas.className = 'parajaca-canvas';
  canvas.tabIndex = 0;
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:pan-y';

  root.appendChild(poster);
  root.appendChild(canvas);
  container.appendChild(root);

  // 2. Event emitter
  /** @type {Map<string, Set<(payload: any) => void>>} */
  const eventHandlers = new Map();

  /**
   * @param {string} event
   * @param {(payload: any) => void} handler
   * @returns {() => void}
   */
  function on(event, handler) {
    let set = eventHandlers.get(event);
    if (!set) {
      set = new Set();
      eventHandlers.set(event, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  /**
   * @param {string} event
   * @param {any} payload
   */
  function emit(event, payload) {
    const handlers = eventHandlers.get(event);
    if (!handlers) return;
    for (const h of Array.from(handlers)) {
      try {
        h(payload);
      } catch (err) {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  }

  /**
   * @param {unknown} err
   */
  function handleError(err) {
    if (isAbortError(err)) return;
    if (err instanceof ParaJacaError) {
      emit('error', {
        code: err.code,
        message: err.message,
        ...(err.assetId ? { assetId: err.assetId } : {}),
      });
    } else {
      emit('error', {
        code: ERROR_CODES.INVALID_SCENE,
        message: err instanceof Error ? err.message : String(err),
      });
      queueMicrotask(() => {
        throw err;
      });
    }
  }

  // 3. Renderer initialization
  /** @type {ReturnType<typeof createRenderer> | null} */
  let renderer = null;
  try {
    renderer = createRenderer(canvas, { isDiagnostics: !!options.diagnostics });
  } catch (err) {
    queueMicrotask(() => {
      emit('error', {
        code: ERROR_CODES.WEBGL_UNAVAILABLE,
        message: err instanceof Error ? err.message : 'WebGL unavailable',
      });
    });
  }

  // 4. Config & Runtime states (R§10.1)
  /** @type {{ scene: Scene | null, variantId: string | null }} */
  const config = {
    scene: null,
    variantId: null,
  };

  const frameState = createFrameState();
  const motionPreference = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  /** @type {Array<{ id: string, source: import('./sources/media-source.js').AnimatedSource }>} */
  const animatedSources = [];
  let animationTimeMs = 0;
  /** @type {boolean | null} */
  let animationPauseOverride = null;
  let isSceneLoaded = false;

  function clearAnimations() {
    for (const entry of animatedSources) entry.source.dispose();
    animatedSources.length = 0;
  }

  function animationsPaused() { return animationPauseOverride ?? motionPreference?.matches ?? false; }

  /** @param {boolean} paused */
  function setAnimationPaused(paused) {
    animationPauseOverride = paused;
    runtime.lastTimestamp = null;
    emit('animation-state', { paused: animationsPaused(), count: animatedSources.length });
    requestFrame();
  }

  function onMotionPreferenceChange() {
    runtime.lastTimestamp = null;
    emit('animation-state', { paused: animationsPaused(), count: animatedSources.length });
    requestFrame();
  }
  motionPreference?.addEventListener('change', onMotionPreferenceChange);

  /** @type {DiagnosticsSample} */
  const diagnosticsSample = {
    fps: 0,
    frameDurationMs: 0,
    gpuDurationMs: null,
    drawCallCount: 0,
    activeLayers: 0,
    renderScale: 1.0,
    preset: 'high',
    memoryEstimateBytes: 0,
    isConverged: false,
    isMarginInsufficient: false,
  };

  const runtime = {
    generation: 0,
    /** @type {AbortController | null} */
    abortController: null,
    /** @type {Variant | null} */
    variant: null,
    /** @type {Float32Array | null} */
    resolvedDepths: null,
    /** @type {Float32Array} */
    parallaxPercents: new Float32Array(0),
    /** @type {number[]} */
    drawOrder: [],
    /** @type {QualityPresetName} */
    presetName: options.quality ?? 'auto',
    /** @type {'high' | 'mid' | 'low'} */
    effectivePreset: 'high',
    /** @type {FrameLayout | null} */
    layout: null,
    /** @type {Map<string, LayerRequirements>} */
    layerRequirements: new Map(),
    /** @type {Map<string, { x: number, y: number, width: number, height: number }>} */
    layerRectComp: new Map(),
    dirtyFlags: 0,
    focusCurrent: 50,
    focusTarget: 50,
    inputTargetX: 0,
    inputTargetY: 0,
    inputCurrentX: 0,
    inputCurrentY: 0,
    // Runtime-only Y-axis intensity (Ref px); the scene stores a single intensity (X, and Y by default).
    intensityY: 0,
    isPaused: false,
    documentHidden: document.visibilityState === 'hidden',
    intersectionHidden: false,
    lastTimestamp: /** @type {number | null} */ (null),
    lastDrawTimestamp: 0,
  };

  let rafId = 0;

  /**
   * Main hot-path render step: evaluates motion, depth of field, framing, convergence, and draws.
   * @param {number} timestamp
   * @param {boolean} [forceDraw=false]
   */
  function renderFrame(timestamp, forceDraw = false) {
    if (!isSceneLoaded || !renderer || !config.scene || !runtime.variant || !runtime.layout || !runtime.resolvedDepths) {
      return;
    }

    if (runtime.isPaused && !forceDraw) {
      return;
    }

    const { scene } = config;
    const { variant, layout, drawOrder, resolvedDepths } = runtime;
    const { optics, motion, quality } = variant;

    // Check fpsTarget (30 vs 60/free)
    const effectiveFpsTarget = options.fpsTarget ?? quality.fpsTarget ?? 60;
    if (!forceDraw && effectiveFpsTarget === 30) {
      const elapsedSinceDraw = timestamp - runtime.lastDrawTimestamp;
      if (elapsedSinceDraw < 1000 / 30 - 4) {
        requestFrame();
        return;
      }
    }

    // Delta time in seconds
    const animationDtMs = runtime.lastTimestamp !== null ? Math.max(0, timestamp - runtime.lastTimestamp) : 0;
    const dtSec = runtime.lastTimestamp !== null
      ? clampDt((timestamp - runtime.lastTimestamp) / 1000)
      : 0;
    runtime.lastTimestamp = timestamp;
    if (!animationsPaused()) {
      animationTimeMs += animationDtMs;
      for (let i = 0; i < animatedSources.length; i++) {
        const entry = animatedSources[i];
        try {
          if (entry.source.update(animationTimeMs)) renderer.updateLayer(entry.id);
        } catch (error) {
          // Stop a failed source once; errors are reported through the normal player channel.
          animationPauseOverride = true;
          handleError(error);
          emit('animation-state', { paused: true, count: animatedSources.length });
          break;
        }
      }
    }

    // Smooth inputs
    const inputK = computeInputK(motion.smoothing);
    runtime.inputCurrentX = smoothStep(runtime.inputCurrentX, runtime.inputTargetX, inputK, dtSec);
    runtime.inputCurrentY = smoothStep(runtime.inputCurrentY, runtime.inputTargetY, inputK, dtSec);

    // Smooth focus
    const focusK = computeFocusK(optics.focusSpeed);
    runtime.focusCurrent = smoothStep(runtime.focusCurrent, runtime.focusTarget, focusK, dtSec);
    const focusCurrent = runtime.focusCurrent;

    // Breathing zoom & scales
    const zoom = computeBreathingZoom(focusCurrent, optics.breathing);
    const s = layout.renderPxPerCompPx * zoom;
    const refFactor = computeRefFactor(scene.reference.height, layout.renderPxPerCompPx);

    const canvasWidthRender = canvas.width;
    const canvasHeightRender = canvas.height;

    let maxRemainingOffsetRender = 0;
    let maxRemainingSigmaRender = 0;

    frameState.layerCount = drawOrder.length;

    for (let i = 0; i < drawOrder.length; i++) {
      const layerIdx = drawOrder[i];
      const layer = variant.layers[layerIdx];
      const depth = resolvedDepths[layerIdx];
      const parallaxPercent = runtime.parallaxPercents[layerIdx];

      // Current blur sigma
      const sigmaRef = computeLayerSigmaRef(layer.focusMode, depth, focusCurrent, layer.fixedBlur, optics);
      const sigmaRender = sigmaRef * refFactor;

      // Target blur sigma for convergence test
      const targetSigmaRef = computeLayerSigmaRef(layer.focusMode, depth, runtime.focusTarget, layer.fixedBlur, optics);
      const targetSigmaRender = targetSigmaRef * refFactor;
      const sigmaDiffRender = Math.abs(targetSigmaRender - sigmaRender);
      if (sigmaDiffRender > maxRemainingSigmaRender) {
        maxRemainingSigmaRender = sigmaDiffRender;
      }

      // Layer resource & texels
      const req = runtime.layerRequirements.get(layer.id);
      const rectComp = runtime.layerRectComp.get(layer.id);
      if (!req || !rectComp) continue;

      const texelsPerPixel = req.texScale / (layout.renderPxPerCompPx * zoom);
      const lod = computeLod(sigmaRender, texelsPerPixel, req.levels - 1);

      // Current parallax offsets
      const offsetRefX = computeLayerParallaxOffsetRef(
        runtime.inputCurrentX, motion.intensity, parallaxPercent,
      );
      const offsetRefY = motion.axisY
        ? computeLayerParallaxOffsetRef(runtime.inputCurrentY, runtime.intensityY, parallaxPercent)
        : 0;

      // Target parallax offsets for convergence test
      const targetOffsetRefX = computeLayerParallaxOffsetRef(
        runtime.inputTargetX, motion.intensity, parallaxPercent,
      );
      const targetOffsetRefY = motion.axisY
        ? computeLayerParallaxOffsetRef(runtime.inputTargetY, runtime.intensityY, parallaxPercent)
        : 0;

      const offsetDiffRenderX = Math.abs(targetOffsetRefX - offsetRefX) * refFactor;
      const offsetDiffRenderY = Math.abs(targetOffsetRefY - offsetRefY) * refFactor;
      const maxOffsetDiffRender = Math.max(offsetDiffRenderX, offsetDiffRenderY);
      if (maxOffsetDiffRender > maxRemainingOffsetRender) {
        maxRemainingOffsetRender = maxOffsetDiffRender;
      }

      const offsetXRender = offsetRefX * refFactor;
      const offsetYRender = offsetRefY * refFactor;

      const xRender = (rectComp.x - layout.cameraXComp) * s + canvasWidthRender / 2 + offsetXRender;
      const yRender = (rectComp.y - layout.cameraYComp) * s + canvasHeightRender / 2 + offsetYRender;
      const wRender = rectComp.width * s;
      const hRender = rectComp.height * s;

      frameState.layerIds[i] = layer.id;
      const rIdx = i * 4;
      frameState.rects[rIdx] = xRender;
      frameState.rects[rIdx + 1] = yRender;
      frameState.rects[rIdx + 2] = wRender;
      frameState.rects[rIdx + 3] = hRender;
      frameState.lods[i] = lod;
      frameState.opacities[i] = 1.0;
      frameState.outlineFlags[i] = 0;
    }

    // Convergence check (R§12.9)
    const converged = isConverged(maxRemainingOffsetRender, maxRemainingSigmaRender);

    renderer.draw(frameState);
    runtime.lastDrawTimestamp = timestamp;
    runtime.dirtyFlags = 0;

    // Diagnostics callback (R§19.2)
    if (options.diagnostics) {
      diagnosticsSample.drawCallCount = drawOrder.length;
      diagnosticsSample.activeLayers = drawOrder.length;
      diagnosticsSample.renderScale = QUALITY_PRESETS[runtime.effectivePreset].renderScale;
      diagnosticsSample.preset = runtime.effectivePreset;
      diagnosticsSample.isConverged = converged;
      diagnosticsSample.isMarginInsufficient = layout.isMarginInsufficient;
      diagnosticsSample.frameDurationMs = dtSec * 1000;
      diagnosticsSample.fps = dtSec > 0 ? 1 / dtSec : 60;
      options.diagnostics(diagnosticsSample);
    }

    if (converged) {
      runtime.inputCurrentX = runtime.inputTargetX;
      runtime.inputCurrentY = runtime.inputTargetY;
      runtime.focusCurrent = runtime.focusTarget;
      // Loop halts until triggered by new input or command
    }
    if (!converged || (animatedSources.length > 0 && !animationsPaused())) {
      requestFrame();
    }
  }

  function requestFrame() {
    if (rafId !== 0 || runtime.isPaused || !isSceneLoaded) return;
    rafId = requestAnimationFrame(onAnimationFrame);
  }

  /** @param {number} timestamp */
  function onAnimationFrame(timestamp) { rafId = 0; renderFrame(timestamp); }

  // Pointer event handlers (R§16.5)
  /**
   * @param {PointerEvent} e
   */
  function onPointerMove(e) {
    const rect = canvas.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const halfW = rect.width / 2;
    const halfH = rect.height / 2;

    runtime.inputTargetX = halfW > 0 ? Math.min(Math.max((e.clientX - centerX) / halfW, -1), 1) : 0;
    runtime.inputTargetY = halfH > 0 ? Math.min(Math.max((e.clientY - centerY) / halfH, -1), 1) : 0;

    runtime.dirtyFlags |= DIRTY_FRAME;
    requestFrame();
  }

  function onPointerLeave() {
    runtime.inputTargetX = 0;
    runtime.inputTargetY = 0;
    runtime.dirtyFlags |= DIRTY_FRAME;
    requestFrame();
  }

  /**
   * Alt + wheel adjusts focus by WHEEL_FOCUS_STEP (R§16.5).
   * @param {WheelEvent} e
   */
  function onWheel(e) {
    if (e.altKey) {
      e.preventDefault();
      const step = e.deltaY > 0 ? WHEEL_FOCUS_STEP : -WHEEL_FOCUS_STEP;
      setFocus(runtime.focusTarget + step, { animate: true });
    }
  }

  // Pointer input is tracked on the window (not the canvas) so overlays above the canvas, such as a
  // control panel, neither reset nor freeze the parallax target. Only leaving the page resets it.
  window.addEventListener('pointermove', onPointerMove);
  document.documentElement.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  // Visibility & Intersection observers for pause/resume (R§16.4)
  function refreshVisibility() {
    runtime.isPaused = runtime.documentHidden || runtime.intersectionHidden;
    if (runtime.isPaused) {
      if (rafId !== 0) { cancelAnimationFrame(rafId); rafId = 0; }
    } else {
      runtime.lastTimestamp = null;
      requestFrame();
    }
  }
  function onVisibilityChange() {
    runtime.documentHidden = document.visibilityState === 'hidden';
    refreshVisibility();
  }
  document.addEventListener('visibilitychange', onVisibilityChange);

  /** @type {IntersectionObserver | null} */
  let intersectionObserver = null;
  if (typeof IntersectionObserver !== 'undefined') {
    intersectionObserver = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      runtime.intersectionHidden = !entry.isIntersecting;
      refreshVisibility();
    });
    intersectionObserver.observe(container);
  }

  /**
   * Resizes viewport and requests frame.
   */
  function resize() {
    if (!renderer || !config.scene || !runtime.variant) return;

    const cssW = container.clientWidth || 300;
    const cssH = container.clientHeight || 150;
    const dpr = window.devicePixelRatio || 1;

    const presetObj = QUALITY_PRESETS[runtime.effectivePreset];
    const { widthRender, heightRender } = renderer.setViewport(cssW, cssH, dpr, presetObj.renderScale);

    runtime.layout = computeFrameLayout({
      reference: config.scene.reference,
      pointOfInterest: config.scene.pointOfInterest,
      canvasWidthRender: widthRender,
      canvasHeightRender: heightRender,
      edgeLayers: [],
    });

    runtime.dirtyFlags |= DIRTY_LAYOUT;
    requestFrame();
  }

  /**
   * Sets focus position smoothly or instantly.
   * @param {number} d
   * @param {{ animate?: boolean }} [opts]
   */
  function setFocus(d, opts = {}) {
    if (!runtime.variant) return;
    const range = runtime.variant.optics.focusRange;
    const clamped = Math.min(Math.max(d, range[0]), range[1]);
    runtime.focusTarget = clamped;
    if (opts.animate === false) {
      runtime.focusCurrent = clamped;
    }
    emit('focus-change', { d: clamped });
    runtime.dirtyFlags |= DIRTY_FRAME;
    requestFrame();
  }

  /**
   * Sets parallax motion intensity dynamically: `intensity` for the X axis and `intensityY` for the
   * Y axis (defaults to `intensity`). The camera does not zoom or constrain layer movement.
   * @param {number} intensity
   * @param {number} [intensityY]
   */
  function setIntensity(intensity, intensityY = intensity) {
    if (!runtime.variant || !Number.isFinite(intensity) || !Number.isFinite(intensityY)) return;
    runtime.variant.motion.intensity = Math.max(0, intensity);
    runtime.intensityY = Math.max(0, intensityY);
    runtime.dirtyFlags |= DIRTY_FRAME;
    requestFrame();
  }

  /**
   * Edits layer translation and/or motion percentage without rebuilding textures or optical depths.
   * @param {PlayerCommand} command
   * @returns {Promise<void>}
   */
  async function edit(command) {
    if (command.type !== 'set-layer' || !runtime.variant || !config.scene) return;

    const layer = runtime.variant.layers.find((l) => l.id === command.layerId);
    const rectComp = layer ? runtime.layerRectComp.get(layer.id) : undefined;
    const target = command.changesLayer?.placement;
    const percent = command.changesLayer?.parallaxPercent;
    if (
      !layer
      || !rectComp
      || (!target && percent === undefined)
      || (target && (
        !Number.isFinite(target.x) || !Number.isFinite(target.y)
        || target.width !== layer.placement.width || target.height !== layer.placement.height
      ))
      || (percent !== undefined && percent !== null
        && (!Number.isFinite(percent) || percent < 0 || percent > 100))
    ) {
      handleError(new ParaJacaError(
        ERROR_CODES.INVALID_SCENE,
        `set-layer requires valid x/y translation or parallaxPercent (layer ${command.layerId})`,
      ));
      return;
    }

    const configLayer = getVariant(config.scene, runtime.variant.id)?.layers.find((l) => l.id === layer.id);
    if (target) {
      const dxComp = target.x - layer.placement.x;
      const dyComp = target.y - layer.placement.y;
      layer.placement.x = target.x;
      layer.placement.y = target.y;
      rectComp.x += dxComp;
      rectComp.y += dyComp;
      if (configLayer) {
        configLayer.placement.x = target.x;
        configLayer.placement.y = target.y;
      }
    }
    if (percent !== undefined) {
      layer.parallaxPercent = percent;
      if (configLayer) configLayer.parallaxPercent = percent;
      runtime.parallaxPercents = resolveParallaxPercents(runtime.variant.layers);
    }

    runtime.dirtyFlags |= DIRTY_FRAME;
    requestFrame();
  }

  /**
   * Changes quality preset manually.
   * @param {QualityPresetName} preset
   */
  function setQuality(preset) {
    runtime.presetName = preset;
    const effective = preset === 'auto' ? 'high' : preset;
    runtime.effectivePreset = effective;
    const presetObj = QUALITY_PRESETS[effective];

    if (renderer && config.scene && runtime.variant) {
      const cssW = container.clientWidth || 300;
      const cssH = container.clientHeight || 150;
      const dpr = window.devicePixelRatio || 1;
      const { widthRender, heightRender } = renderer.setViewport(cssW, cssH, dpr, presetObj.renderScale);
      runtime.layout = computeFrameLayout({
        reference: config.scene.reference,
        pointOfInterest: config.scene.pointOfInterest,
        canvasWidthRender: widthRender,
        canvasHeightRender: heightRender,
        edgeLayers: [],
      });
      runtime.dirtyFlags |= DIRTY_LAYOUT;
      requestFrame();
    }

    emit('quality-change', {
      preset,
      renderScale: presetObj.renderScale,
      reason: 'manual',
    });
  }

  /**
   * Loads a scene from a URL or Scene object.
   * @param {string | Scene} source
   * @returns {Promise<void>}
   */
  async function load(source) {
    if (!renderer) return;

    const generation = ++runtime.generation;
    runtime.abortController?.abort();
    const controller = new AbortController();
    runtime.abortController = controller;
    const { signal } = controller;
    isSceneLoaded = false;
    if (rafId !== 0) { cancelAnimationFrame(rafId); rafId = 0; }
    clearAnimations();
    animationTimeMs = 0;
    runtime.lastTimestamp = null;
    if (runtime.variant) {
      for (const layer of runtime.variant.layers) renderer.releaseLayer(layer.id);
    }
    runtime.layerRequirements.clear();
    runtime.layerRectComp.clear();

    try {
      signal.throwIfAborted();

      let rawData;
      let manifestUrl;

      if (typeof source === 'string') {
        manifestUrl = new URL(source, document.baseURI);
        const res = await fetch(source, { signal });
        signal.throwIfAborted();
        if (!res.ok) {
          throw new ParaJacaError(ERROR_CODES.ASSET_LOAD_FAILED, `HTTP ${res.status} for scene`);
        }
        rawData = await res.json();
      } else {
        manifestUrl = new URL(document.baseURI);
        rawData = source;
      }
      signal.throwIfAborted();

      // Validate scene
      const validation = validateScene(rawData);
      if (!validation.ok) {
        throw new ParaJacaError(validation.code, validation.errors.join('; '));
      }
      const scene = validation.scene;

      // Select variant
      const targetVariantId = options.variantId ?? scene.defaultVariantId;
      const variant = getVariant(scene, targetVariantId);
      if (!variant) {
        throw new ParaJacaError(ERROR_CODES.INVALID_SCENE, `Variant ${targetVariantId} not found`);
      }

      // Update config
      config.scene = cloneScene(scene);
      config.variantId = variant.id;
      runtime.variant = variant;
      runtime.intensityY = variant.motion.intensity;
      runtime.focusCurrent = variant.optics.focus;
      runtime.focusTarget = variant.optics.focus;
      runtime.inputCurrentX = 0;
      runtime.inputCurrentY = 0;
      runtime.inputTargetX = 0;
      runtime.inputTargetY = 0;

      // Resolve depths & draw order
      const resolvedDepths = resolveDepths(variant.layers);
      const drawOrder = computeDrawOrder(variant.layers, resolvedDepths);
      runtime.resolvedDepths = resolvedDepths;
      runtime.parallaxPercents = resolveParallaxPercents(variant.layers);
      runtime.drawOrder = drawOrder;

      // Effective preset (Phase A: 'auto' -> 'high')
      runtime.effectivePreset = runtime.presetName === 'auto' ? 'high' : runtime.presetName;
      const presetObj = QUALITY_PRESETS[runtime.effectivePreset];

      // Viewport & Scale 1 layout
      const cssW = container.clientWidth || 300;
      const cssH = container.clientHeight || 150;
      const dpr = window.devicePixelRatio || 1;

      renderer.setViewport(cssW, cssH, dpr, presetObj.renderScale);

      const layoutScale1 = computeFrameLayout({
        reference: scene.reference,
        pointOfInterest: scene.pointOfInterest,
        canvasWidthRender: cssW * dpr,
        canvasHeightRender: cssH * dpr,
        edgeLayers: [],
      });

      const limits = renderer.getLimits();
      /** @type {AssetResolver} */
      const resolver = options.assetResolver ?? ((asset) => new URL(asset.path, manifestUrl).href);

      // Sequentially load layers in draw order
      for (const layerIdx of drawOrder) {
        const layer = variant.layers[layerIdx];
        const asset = scene.assets.find((a) => a.id === layer.assetId);
        if (!asset) {
          throw new ParaJacaError(ERROR_CODES.INVALID_SCENE, `Asset ${layer.assetId} missing`);
        }

        const analysis = await analyzeSource(asset, layer, resolver, signal);
        if (generation !== runtime.generation) return;

        const req = computeRequirements({
          layer,
          resolvedDepth: resolvedDepths[layerIdx],
          asset,
          contentRectComp: analysis.contentRectComp,
          croppedSides: analysis.croppedSides,
          variant,
          reference: scene.reference,
          renderPxPerCompPxAtScale1: layoutScale1.renderPxPerCompPx,
          preset: presetObj,
          maxTextureSize: limits.maxTextureSize,
        });

        if (req.textureSize.width > limits.maxTextureSize || req.textureSize.height > limits.maxTextureSize) {
          throw new ParaJacaError(
            ERROR_CODES.TEXTURE_TOO_LARGE,
            `Texture size ${req.textureSize.width}x${req.textureSize.height} exceeds maximum ${limits.maxTextureSize}`,
            { assetId: asset.id },
          );
        }

        /** @type {import('./sources/media-source.js').AnimatedSource | null} */
        let animated = null;
        /** @type {ImageBitmap} */
        let bitmap;
        try {
          if (analysis.vector && (analysis.vector.kind === 'lottie' || analysis.vector.animated)) {
            animated = await createAnimatedSource(analysis.vector, req.contentSizeTex.width, req.contentSizeTex.height, signal);
            bitmap = await createImageBitmap(animated.canvas, { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'default' });
          } else bitmap = await decodeSource(analysis, asset, layer, req.contentSizeTex, signal);
        } catch (error) { animated?.dispose(); throw error; }
        if (generation !== runtime.generation) {
          bitmap.close();
          animated?.dispose();
          return;
        }

        try { await renderer.prepareLayer(
          layer.id,
          {
            bitmap,
            contentRectComp: analysis.contentRectComp,
            opaque: analysis.opaque,
            canvas: animated?.canvas,
          },
          req,
          signal,
        ); } catch (error) { animated?.dispose(); throw error; }
        if (generation !== runtime.generation) { animated?.dispose(); return; }
        if (animated) animatedSources.push({ id: layer.id, source: animated });
        if (analysis.vector) {
          for (const message of analysis.vector.warnings) emit('warning', { assetId: asset.id, message });
        }

        // Calculate rectComp (R§12.12)
        const texPerCompX = req.contentSizeTex.width / analysis.contentRectComp.width;
        const texPerCompY = req.contentSizeTex.height / analysis.contentRectComp.height;
        const rectComp = {
          x: analysis.contentRectComp.x - req.paddingTex.left / texPerCompX,
          y: analysis.contentRectComp.y - req.paddingTex.top / texPerCompY,
          width: req.textureSize.width / texPerCompX,
          height: req.textureSize.height / texPerCompY,
        };

        runtime.layerRequirements.set(layer.id, req);
        runtime.layerRectComp.set(layer.id, rectComp);
      }

      // Final layout calculation
      const { widthRender, heightRender } = renderer.setViewport(cssW, cssH, dpr, presetObj.renderScale);
      runtime.layout = computeFrameLayout({
        reference: scene.reference,
        pointOfInterest: scene.pointOfInterest,
        canvasWidthRender: widthRender,
        canvasHeightRender: heightRender,
        edgeLayers: [],
      });

      isSceneLoaded = true;
      runtime.isPaused = runtime.documentHidden || runtime.intersectionHidden;
      emit('ready', {});
      emit('animation-state', { paused: animationsPaused(), count: animatedSources.length });
      runtime.dirtyFlags |= DIRTY_FRAME;
      requestFrame();
    } catch (err) {
      if (generation === runtime.generation) {
        clearAnimations();
        handleError(err);
      }
    }
  }

  // Setup ResizeObserver
  /** @type {ResizeObserver | null} */
  let resizeObserver = null;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      resize();
    });
    resizeObserver.observe(container);
  }

  /**
   * Releases player resources and DOM elements.
   */
  function dispose() {
    runtime.generation++;
    runtime.abortController?.abort();
    isSceneLoaded = false;
    clearAnimations();
    motionPreference?.removeEventListener('change', onMotionPreferenceChange);
    if (rafId !== 0) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    if (intersectionObserver) {
      intersectionObserver.disconnect();
      intersectionObserver = null;
    }
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pointermove', onPointerMove);
    document.documentElement.removeEventListener('pointerleave', onPointerLeave);
    canvas.removeEventListener('wheel', onWheel);

    renderer?.dispose();
    renderer = null;
    container.innerHTML = '';
    eventHandlers.clear();
  }

  // Return Player interface conforming to R§16.1 & R§16.2
  return {
    load,
    setAnimationPaused,
    async setVariant() {},
    setFocus,
    setQuality,
    setIntensity,
    resize,
    on,
    dispose,
    // @internal API
    edit,
    async capturePoster() {
      return new Blob([]);
    },
    setRevealMode() {},
    setRenderScaleOverride() {},
    getScene() {
      return config.scene ? cloneScene(config.scene) : /** @type {Scene} */ ({});
    },
    getLayoutInfo() {
      return {
        isMarginInsufficient: runtime.layout?.isMarginInsufficient ?? false,
        renderScale: QUALITY_PRESETS[runtime.effectivePreset].renderScale,
        preset: runtime.effectivePreset,
      };
    },
  };
}
