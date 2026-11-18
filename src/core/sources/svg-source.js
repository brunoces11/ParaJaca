// SVG is parsed as an inert XML document; its markup is never attached to the page.
import { ParaJacaError, ERROR_CODES } from '../errors.js';
import { MAX_MEDIA_BYTES } from './lottie-source.js';

/** @param {string} message @returns {never} */
function fail(message) { throw new ParaJacaError(ERROR_CODES.ASSET_LOAD_FAILED, message); }

/** @param {string | null} text */
function lengthCss(text) {
  if (!text) return null;
  const match = /^\s*(\d*\.?\d+(?:e[+-]?\d+)?)\s*(px|pt|pc|in|cm|mm|q)?\s*$/i.exec(text);
  if (!match) return null;
  const units = /** @type {Record<string, number>} */ ({ px: 1, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 });
  const value = Number(match[1]) * units[(match[2] || 'px').toLowerCase()];
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** @param {Blob} blob @param {AbortSignal} signal */
export async function inspectSvg(blob, signal) {
  signal.throwIfAborted();
  if (blob.size > MAX_MEDIA_BYTES) fail('SVG file exceeds 100 MB');
  const text = await blob.text();
  signal.throwIfAborted();
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(text)) fail('External SVG documents and entities are not supported');
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  if (doc.querySelector('parsererror') || root.localName !== 'svg') fail('Invalid SVG document');
  const viewBox = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const hasViewBox = viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0;
  const style = root.getAttribute('style') || '';
  let width = lengthCss(root.getAttribute('width') || /(?:^|;)\s*width\s*:\s*([^;]+)/i.exec(style)?.[1] || null);
  let height = lengthCss(root.getAttribute('height') || /(?:^|;)\s*height\s*:\s*([^;]+)/i.exec(style)?.[1] || null);
  if (hasViewBox) {
    if (width && !height) height = width * viewBox[3] / viewBox[2];
    else if (height && !width) width = height * viewBox[2] / viewBox[3];
    else if (!width && !height) { width = viewBox[2]; height = viewBox[3]; }
  }
  if (!width || !height) fail('SVG needs positive dimensions or a viewBox');
  let animated = false;
  const warnings = [];
  const nodes = doc.querySelectorAll('*');
  if (nodes.length > 100000) fail('SVG contains too many elements');
  for (const node of nodes) {
    const name = node.localName;
    if (['script', 'foreignObject', 'iframe', 'object', 'embed', 'audio', 'video'].includes(name)) {
      fail(`Unsupported active SVG content: ${name}`);
    }
    if (['animateMotion', 'set', 'discard'].includes(name)) fail(`SVG ${name} is not supported by the animation renderer; export as Lottie`);
    if (['animate', 'animateColor', 'animateTransform'].includes(name)) {
      animated = true;
      if (node.hasAttribute('keySplines') || node.hasAttribute('keyTimes')) warnings.push('SVG animation timing uses the canvas renderer interpretation');
    }
    for (const attribute of node.attributes) {
      const value = attribute.value.trim();
      if (/^on/i.test(attribute.name)) fail('SVG event handlers are not supported');
      if (attribute.localName === 'href' && value && !value.startsWith('#') && !/^data:image\/(png|jpeg|webp|svg\+xml|gif)[;,]/i.test(value)) {
        fail('SVG external resources are not loaded; embed images and fonts');
      }
      if (/url\(\s*['"]?(?!#)/i.test(value) && !/url\(\s*['"]?data:/i.test(value)) {
        // Match each URL separately: quoted internal references are allowed.
        for (const match of value.matchAll(/url\(\s*['"]?([^)'"\s]+)/gi)) {
          if (!match[1].startsWith('#') && !match[1].startsWith('data:')) fail('External SVG CSS resources are not loaded');
        }
      }
    }
    const css = name === 'style' ? node.textContent || '' : node.getAttribute('style') || '';
    if (/@import|@font-face/i.test(css)) fail('External SVG styles and fonts are not loaded; export text as paths');
    if (/@keyframes|\banimation(?:-name)?\s*:/i.test(css)) fail('CSS SVG animations are not supported in the composition; export as Lottie or SMIL');
    for (const match of css.matchAll(/url\(\s*['"]?([^)'"\s]+)/gi)) {
      if (!match[1].startsWith('#') && !match[1].startsWith('data:')) fail('External SVG CSS resources are not loaded');
    }
  }
  root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  return { kind: /** @type {const} */ ('svg'), width, height, animated,
    text: new XMLSerializer().serializeToString(root), warnings };
}

/** @param {string} text @param {number} widthTex @param {number} heightTex @param {AbortSignal} signal */
export async function rasterizeSvg(text, widthTex, heightTex, signal) {
  signal.throwIfAborted();
  const image = new Image();
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
  const cancel = () => { image.src = ''; };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    image.src = url;
    await image.decode();
    signal.throwIfAborted();
    const canvas = document.createElement('canvas');
    canvas.width = widthTex;
    canvas.height = heightTex;
    const ctx = canvas.getContext('2d');
    if (!ctx) fail('Canvas 2D unavailable');
    ctx.drawImage(image, 0, 0, widthTex, heightTex);
    const bitmap = await createImageBitmap(canvas, { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'default' });
    if (signal.aborted) { bitmap.close(); signal.throwIfAborted(); }
    return bitmap;
  } finally {
    signal.removeEventListener('abort', cancel);
    URL.revokeObjectURL(url);
  }
}
