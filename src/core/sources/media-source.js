// Optional vector adapters. Heavy renderers are imported only when their format is used.
import { inspectLottie, MAX_MEDIA_BYTES } from './lottie-source.js';
import { inspectSvg } from './svg-source.js';
import { ParaJacaError, ERROR_CODES } from '../errors.js';

/** @typedef {Awaited<ReturnType<typeof inspectSvg>> | Awaited<ReturnType<typeof inspectLottie>>} VectorInfo */
/**
 * @typedef {Object} AnimatedSource
 * @property {HTMLCanvasElement} canvas
 * @property {(elapsedMs: number) => boolean} update
 * @property {() => void} dispose
 */

/** Cache by immutable Blob identity; weak keys do not retain discarded imports. @type {WeakMap<Blob, {type: string, info: VectorInfo}>} */
const inspected = new WeakMap();

/** @param {Blob} blob @param {'svg' | 'lottie' | 'dotlottie'} type @param {AbortSignal} signal */
export async function inspectVector(blob, type, signal) {
  signal.throwIfAborted();
  const cached = inspected.get(blob);
  if (cached?.type === type) return cached.info;
  const result = type === 'svg' ? await inspectSvg(blob, signal) : await inspectLottie(blob, type === 'dotlottie', signal);
  signal.throwIfAborted();
  inspected.set(blob, { type, info: result });
  return result;
}

/** Validates user imports before replacing a working scene.
 * @param {File} file @param {AbortSignal} signal */
export async function inspectMediaFile(file, signal) {
  signal.throwIfAborted();
  if (file.size > MAX_MEDIA_BYTES) throw new Error('File exceeds 100 MB');
  const extension = file.name.split('.').pop()?.toLowerCase();
  const types = /** @type {Record<string, import('../scene/model.js').AssetType>} */ ({
    png: 'png', jpg: 'jpg', jpeg: 'jpg', webp: 'webp', svg: 'svg', json: 'lottie', lottie: 'dotlottie',
  });
  const type = extension ? types[extension] : undefined;
  if (!type) throw new Error('Supported formats: PNG, JPG, WebP, SVG, Lottie JSON and .lottie');
  if (type === 'svg' || type === 'lottie' || type === 'dotlottie') {
    const info = await inspectVector(file, type, signal);
    return { type, width: info.width, height: info.height };
  }
  const bitmap = await createImageBitmap(file);
  try { signal.throwIfAborted(); return { type, width: bitmap.width, height: bitmap.height }; }
  finally { bitmap.close(); }
}

/** @param {VectorInfo} info @param {number} widthTex @param {number} heightTex @param {AbortSignal} signal
 * @returns {Promise<AnimatedSource>} */
export async function createAnimatedSource(info, widthTex, heightTex, signal) {
  signal.throwIfAborted();
  const canvas = document.createElement('canvas');
  canvas.width = widthTex;
  canvas.height = heightTex;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ParaJacaError(ERROR_CODES.ASSET_LOAD_FAILED, 'Canvas 2D unavailable');
  if (info.kind === 'lottie') {
    const module = await import('lottie-web/build/player/lottie_light_canvas.js');
    signal.throwIfAborted();
    // lottie-web supports a caller-owned canvas without a container; its declaration requires one.
    const loadAnimation = /** @type {(settings: {name: string, renderer: 'canvas', animationData: object, autoplay: boolean, loop: boolean,
     * rendererSettings: {context: CanvasRenderingContext2D, clearCanvas: boolean, preserveAspectRatio: string, dpr: number, runExpressions: boolean}}) => import('lottie-web').AnimationItem} */ (
      /** @type {unknown} */ (module.default.loadAnimation));
    const name = `parajaca-${crypto.randomUUID()}`;
    /** @type {import('lottie-web').AnimationItem} */
    let animation;
    try {
      animation = loadAnimation({ name, renderer: 'canvas', animationData: structuredClone(info.data), autoplay: false, loop: true,
        rendererSettings: { context: ctx, clearCanvas: true, preserveAspectRatio: 'xMidYMid meet', dpr: 1, runExpressions: false } });
    } catch (error) { module.default.destroy(name); throw error; }
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => finish(new Error('Lottie loading timed out')), 15000);
        /** @param {unknown} [error] */
        function finish(error) {
          clearTimeout(timeout);
          signal.removeEventListener('abort', aborted);
          animation.removeEventListener('DOMLoaded', ready);
          animation.removeEventListener('data_failed', failed);
          if (error) reject(error); else resolve(undefined);
        }
        function ready() { finish(); }
        function failed() { finish(new Error('Lottie loading failed')); }
        function aborted() { finish(signal.reason); }
        animation.addEventListener('DOMLoaded', ready);
        animation.addEventListener('data_failed', failed);
        signal.addEventListener('abort', aborted, { once: true });
        if (animation.isLoaded) finish();
        if (signal.aborted) aborted();
      });
      signal.throwIfAborted();
      animation.setSubframe(false);
      animation.goToAndStop(0, true);
      let previousFrame = 0;
      return { canvas,
        update(elapsedMs) {
          const frame = Math.floor(elapsedMs * info.fps / 1000) % Math.max(1, animation.totalFrames);
          if (frame === previousFrame) return false;
          animation.goToAndStop(frame, true);
          previousFrame = frame;
          return true;
        },
        dispose() { animation.destroy(); canvas.width = 1; canvas.height = 1; },
      };
    } catch (error) { animation.destroy(); throw error; }
  }
  const { Canvg } = await import('canvg');
  signal.throwIfAborted();
  let imageFailed = false;
  const engine = Canvg.fromString(ctx, info.text, { ignoreMouse: true, ignoreAnimation: true,
    ignoreDimensions: true, fetch: async () => { throw new Error('External SVG resources are disabled'); },
    createImage: async (src) => {
      try {
        if (!/^data:image\/(png|jpeg|webp|svg\+xml|gif)[;,]/i.test(src)) throw new Error('External SVG images are disabled');
        const image = new Image(); image.src = src; await image.decode(); signal.throwIfAborted(); return image;
      } catch (error) { imageFailed = true; throw error; }
    },
  });
  try {
    // canvg 4.0.3 divides by zero at an exact `values` boundary (e.g. 50%).
    // Equal endpoints require zero interpolation, not NaN; keep the workaround local to this adapter.
    for (const animation of engine.screen.animations) {
      const getProgress = animation.getProgress.bind(animation);
      animation.getProgress = () => {
        const progress = getProgress();
        if (!Number.isFinite(progress.progress)) progress.progress = 0;
        return progress;
      };
    }
    engine.resize(widthTex, heightTex, true);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('SVG loading timed out')), 15000);
      /** @param {unknown} [error] */
      function finish(error) {
        clearTimeout(timeout);
        signal.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve(undefined);
      }
      function aborted() { finish(signal.reason); }
      signal.addEventListener('abort', aborted, { once: true });
      engine.render({ ignoreAnimation: true, ignoreMouse: true, ignoreDimensions: true }).then(() => finish(), finish);
      if (signal.aborted) aborted();
    });
    signal.throwIfAborted();
    if (imageFailed) throw new Error('An embedded SVG image could not be decoded');
    const root = engine.document.documentElement;
    if (!root) throw new Error('SVG rendering failed');
    let previousMs = 0;
    return { canvas,
      update(elapsedMs) {
        const deltaMs = elapsedMs - previousMs;
        if (deltaMs < 1000 / 60) return false;
        previousMs = elapsedMs;
        let changed = false;
        for (let i = 0; i < engine.screen.animations.length; i++) {
          if (engine.screen.animations[i].update(deltaMs)) changed = true;
        }
        if (!changed) return false;
        engine.screen.viewPort.clear();
        engine.screen.viewPort.setCurrent(widthTex, heightTex);
        ctx.clearRect(0, 0, widthTex, heightTex);
        root.render(ctx);
        return true;
      },
      dispose() { engine.stop(); canvas.width = 1; canvas.height = 1; },
    };
  } catch (error) { engine.stop(); throw error; }
}
