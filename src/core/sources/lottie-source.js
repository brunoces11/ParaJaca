// Bounded dotLottie extraction and expression-free Lottie validation.
import { ParaJacaError, ERROR_CODES } from '../errors.js';

export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 64;

/** @param {string} message @returns {never} */
function fail(message) {
  throw new ParaJacaError(ERROR_CODES.ASSET_LOAD_FAILED, message);
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected a JSON object');
  return /** @type {Record<string, unknown>} */ (value);
}

/** Reject expensive or executable structures before handing data to the player.
 * @param {unknown} input */
function checkTree(input) {
  const pending = [{ value: input, depth: 0 }];
  let count = 0;
  let hasEffects = false;
  let has3D = false;
  while (pending.length) {
    const entry = pending.pop();
    if (!entry) break;
    if (++count > 1000000 || entry.depth > 128) fail('Animation JSON is too complex');
    if (entry.value && typeof entry.value === 'object') {
      for (const [key, value] of Object.entries(entry.value)) {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') fail('Unsafe JSON property');
        if (key === 'x' && typeof value === 'string' && value.trim()) {
          fail('Lottie expressions are not supported; export expressions as keyframes');
        }
        if (key === 'ef' && Array.isArray(value) && value.length) hasEffects = true;
        if (key === 'ddd' && value === 1) has3D = true;
        pending.push({ value, depth: entry.depth + 1 });
      }
    }
  }
  return { hasEffects, has3D };
}

/** @param {string} path */
function safePath(path) {
  return path.length > 0 && !path.startsWith('/') && !path.includes('\\')
    && !path.includes(':') && !path.split('/').some((part) => part === '..' || part === '.');
}

/** Streaming output is bounded by actual decompressed bytes, not ZIP metadata.
 * @param {Uint8Array} input @param {AbortSignal} signal */
export async function unpackLottie(input, signal) {
  signal.throwIfAborted();
  if (input.byteLength > MAX_MEDIA_BYTES) fail('dotLottie file exceeds 100 MB');
  const { Unzip, UnzipInflate } = await import('fflate');
  signal.throwIfAborted();
  /** @type {Map<string, Uint8Array>} */
  const entries = new Map();
  let totalBytes = 0;
  let entryCount = 0;
  let completed = 0;
  const unzip = new Unzip((file) => {
    if (++entryCount > MAX_ARCHIVE_ENTRIES || !safePath(file.name) || entries.has(file.name)) {
      fail('Invalid dotLottie paths, duplicate entries, or too many entries');
    }
    if (file.compression !== 0 && file.compression !== 8) fail('Unsupported ZIP compression');
    if (file.originalSize !== undefined && file.originalSize > MAX_MEDIA_BYTES) fail('ZIP entry exceeds 100 MB');
    const name = file.name;
    entries.set(name, new Uint8Array(0));
    /** @type {Uint8Array[]} */
    const chunks = [];
    let sizeBytes = 0;
    file.ondata = (error, data, final) => {
      if (error) throw error;
      signal.throwIfAborted();
      sizeBytes += data.byteLength;
      totalBytes += data.byteLength;
      if (sizeBytes > MAX_MEDIA_BYTES || totalBytes > MAX_ARCHIVE_BYTES) {
        file.terminate();
        fail('Decompressed dotLottie exceeds the memory budget');
      }
      chunks.push(data);
      if (final) {
        const output = new Uint8Array(sizeBytes);
        let offset = 0;
        for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
        entries.set(name, output);
        completed++;
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < input.length; offset += 8192) {
    signal.throwIfAborted();
    unzip.push(input.subarray(offset, offset + 8192), offset + 8192 >= input.length);
  }
  if (completed !== entryCount || !entries.has('manifest.json')) fail('Incomplete dotLottie archive');
  return entries;
}

/** @param {Uint8Array} bytes @returns {Record<string, unknown>} */
function readJson(bytes) {
  return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}

/** @param {Uint8Array} bytes */
function base64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

/** @param {string} path */
function imageMime(path) {
  const extension = path.split('.').pop()?.toLowerCase();
  const types = /** @type {Record<string, string>} */ ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml', gif: 'image/gif' });
  return extension ? types[extension] : undefined;
}

/** @param {Blob} blob @param {boolean} packaged @param {AbortSignal} signal */
export async function inspectLottie(blob, packaged, signal) {
  signal.throwIfAborted();
  if (blob.size > MAX_MEDIA_BYTES) fail('Animation file exceeds 100 MB');
  /** @type {Map<string, Uint8Array> | null} */
  let entries = null;
  /** @type {Record<string, unknown>} */
  let data;
  const warnings = [];
  if (packaged) {
    entries = await unpackLottie(new Uint8Array(await blob.arrayBuffer()), signal);
    const manifestBytes = entries.get('manifest.json');
    if (!manifestBytes) fail('Missing dotLottie manifest');
    const manifest = readJson(manifestBytes);
    if (manifest.version !== '1' && manifest.version !== '2') fail('Unsupported dotLottie manifest version');
    if (!Array.isArray(manifest.animations) || !manifest.animations.length) fail('dotLottie contains no animations');
    const initial = manifest.initial ? record(manifest.initial) : {};
    if (initial.stateMachine && !initial.animation) fail('dotLottie state machines are not supported; export an animation');
    const first = record(manifest.animations[0]);
    const id = initial.animation ?? manifest.activeAnimationId ?? first.id;
    if (typeof id !== 'string' || !safePath(id) || id.includes('/')) fail('Invalid dotLottie animation ID');
    const selected = manifest.animations.map(record).find((animation) => animation.id === id);
    if (!selected) fail('Initial dotLottie animation is not listed in the manifest');
    if (selected.initialTheme) fail('dotLottie themes are not supported; export the resolved colors');
    const path = `${manifest.version === '2' ? 'a' : 'animations'}/${id}.json`;
    const bytes = entries.get(path);
    if (!bytes) fail(`Missing animation: ${path}`);
    data = readJson(bytes);
  } else {
    data = record(JSON.parse(await blob.text()));
  }
  signal.throwIfAborted();
  const features = checkTree(data);
  if (features.hasEffects) warnings.push('Some After Effects effects are not supported by the canvas renderer; review the animation preview');
  if (features.has3D) warnings.push('Lottie 3D layers are interpreted by the 2D canvas renderer; review the animation preview');
  const width = data.w;
  const height = data.h;
  const fps = data.fr;
  const firstFrame = data.ip;
  const lastFrame = data.op;
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0
    || typeof height !== 'number' || !Number.isFinite(height) || height <= 0
    || typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0 || fps > 240
    || typeof firstFrame !== 'number' || !Number.isFinite(firstFrame)
    || typeof lastFrame !== 'number' || !Number.isFinite(lastFrame) || lastFrame <= firstFrame
    || !Array.isArray(data.layers)) fail('Invalid Lottie composition dimensions, timing, or layers');
  if (Array.isArray(data.assets)) {
    for (const item of data.assets) {
      const asset = record(item);
      if (typeof asset.p !== 'string') continue;
      if (/^data:image\/(png|jpeg|webp|svg\+xml|gif)[;,]/i.test(asset.p)) continue;
      const path = `${typeof asset.u === 'string' ? asset.u : ''}${asset.p}`;
      if (!entries || !safePath(path)) fail(`Missing embedded image: ${asset.p}. Include images in the export`);
      const bytes = entries.get(path);
      const mime = imageMime(path);
      if (!bytes || !mime) fail(`Missing or unsupported dotLottie image: ${path}`);
      asset.u = '';
      asset.p = `data:${mime};base64,${base64(bytes)}`;
      asset.e = 1;
    }
  }
  if (data.fonts) {
    const fonts = record(data.fonts);
    if (Array.isArray(fonts.list)) {
      for (const item of fonts.list) {
        const font = record(item);
        if (font.fPath && (typeof font.fPath !== 'string' || !/^data:(font\/|application\/(font-|x-font-|octet-stream))/.test(font.fPath))) {
          fail('External Lottie fonts are not loaded; embed fonts or export text as shapes');
        }
      }
      if (!Array.isArray(data.chars)) warnings.push('Lottie text uses fonts available on this computer; use glyphs for identical typography');
    }
  }
  if (Array.isArray(data.layers) && data.layers.some((item) => record(item).ty === 6)) fail('Lottie audio is not supported');
  return { kind: /** @type {const} */ ('lottie'), width, height, fps, firstFrame, lastFrame, data, warnings };
}
