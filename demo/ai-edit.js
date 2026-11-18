// AI canvas expansion for demo layers: the OpenAI image edit API fills new strips around a
// layer image, then the original pixels (RGB + alpha) are restored 1:1 around the result.
// Image pixels use the Tex suffix (texels of the layer image); pointer positions use Css.

import { isAbortError } from '../src/core/errors.js';

/**
 * Straight (non-premultiplied) RGBA8 pixels; same shape as ImageData. width/height in Tex.
 * @typedef {Object} RgbaImage
 * @property {number} width
 * @property {number} height
 * @property {Uint8ClampedArray<ArrayBuffer>} data
 */

/** @typedef {{ width: number, height: number }} SizeTex */
/** @typedef {{ left: number, top: number, right: number, bottom: number }} MarginsTex */
/** @typedef {'left' | 'top' | 'right' | 'bottom'} Side */

/**
 * @typedef {Object} Stroke
 * @property {string} color brush color, '#rrggbb'
 * @property {number} widthTex
 * @property {number[]} pointsTex flat [x0, y0, x1, y1, ...] in the expanded image
 */

/**
 * @typedef {Object} DecodedPng
 * @property {RgbaImage} image
 * @property {Uint8Array<ArrayBuffer>[]} colorChunks raw gAMA/cHRM/sRGB/iCCP chunks, kept on encode
 */

/**
 * @typedef {Object} PngHeader
 * @property {number} width
 * @property {number} height
 * @property {number} depth
 * @property {number} colorType
 * @property {number} interlace
 */

/** @typedef {{ error?: { message?: unknown }, data?: Array<{ b64_json?: unknown }> }} ApiBody */

/**
 * @typedef {Object} ExpandResult
 * @property {File} file expanded PNG
 * @property {SizeTex} sizeTex
 * @property {MarginsTex} marginsTex where the original sits inside the expanded image
 */

/**
 * @typedef {Object} PanelOpenOptions
 * @property {string} title
 * @property {import('../src/core/scene/model.js').Asset} asset
 * @property {(signal: AbortSignal) => Promise<Blob>} loadSource
 * @property {(result: ExpandResult) => Promise<{ ok: boolean, message: string }>} onApply
 */

export const AI_MODEL = 'gpt-image-2.6-sunburst';
export const AI_SUPPORTED_TYPES = Object.freeze(['png', 'jpg', 'webp']);
export const DEFAULT_BAND_TEX = 32; // calibrate
export const BRUSH_COLORS = Object.freeze([
  Object.freeze({ css: '#ef4444', label: 'Vermelho', promptName: 'RED' }),
  Object.freeze({ css: '#3b82f6', label: 'Azul', promptName: 'BLUE' }),
  Object.freeze({ css: '#22c55e', label: 'Verde', promptName: 'GREEN' }),
  Object.freeze({ css: '#facc15', label: 'Amarelo', promptName: 'YELLOW' }),
]);

const EDIT_URL = '/openai/v1/images/edits'; // relayed to api.openai.com by vite.config.js
const KEY_STORAGE = 'parajaca-openai-key';
const DEFAULT_REQUEST = 'Extend the scene naturally, continuing the existing elements.';
const NON_KEY_CHARS = /[^\x21-\x7e]/g; // API keys are printable ASCII without spaces
const MS_PER_SEC = 1000;
const API_STEP_TEX = 16;
const API_MAX_EDGE_TEX = 3840;
const API_MAX_RATIO = 3;
const API_MIN_PIXELS = 655360;
const API_STABLE_PIXELS = 3686400; // 2560 × 1440; larger sizes are experimental
const MAX_TARGET_EDGE_TEX = 8192;
const GROW_RATIO = 0.25; // calibrate
const BRUSH_THIN_CSS = 4; // calibrate
const BRUSH_THICK_CSS = 28; // calibrate
const STAGE_PAD_CSS = 16;
const CHECKER_CSS = 12;
const REGISTER_RANGE_TEX = 6;
const REGISTER_STEP_TEX = 4;
const REGISTER_INSET_TEX = 12;
const SOLID_ALPHA = 230;
const TONE_ALPHA = 200;
const TONE_CELL_TEX = 32; // calibrate
const TONE_FADE_TEX = 96; // calibrate
const TONE_MIN_SAMPLES = 16;
const TONE_GAIN_MIN = 0.5;
const TONE_GAIN_MAX = 2;
const LUMA_R = 0.299;
const LUMA_G = 0.587;
const LUMA_B = 0.114;
const STROKE_GROW_TEX = 24; // calibrate
const STROKE_FEATHER_TEX = 16; // calibrate
const MARKER_RGB = Object.freeze([255, 0, 255]);
const MARKER_TOLERANCE = 20;
const MARKER_WARN_RATIO = 0.005;
const EMPTY_EDGE_RATIO = 0.02;
const OPAQUE_ALPHA = 255;
const RGBA = 4;
const BYTE_RANGE = 256;
const BYTE_HALF = 128;
const TRNS_SAMPLE_BYTES = 2;
const PNG_SIGNATURE = Object.freeze([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_COLOR_CHUNKS = Object.freeze(['gAMA', 'cHRM', 'sRGB', 'iCCP']);
const PNG_CHUNK_OVERHEAD = 12;
const PNG_TYPE_OFFSET = 4;
const PNG_DATA_OFFSET = 8;
const PNG_IHDR_LENGTH = 13;
const PNG_IHDR_DEPTH = 8;
const PNG_IHDR_COLOR = 9;
const PNG_IHDR_INTERLACE = 12;
const PNG_BIT_DEPTH = 8;
const COLOR_GRAY = 0;
const COLOR_RGB = 2;
const COLOR_PALETTE = 3;
const COLOR_GRAY_ALPHA = 4;
const COLOR_RGBA = 6;
const PNG_CHANNELS = new Map([[COLOR_GRAY, 1], [COLOR_RGB, 3], [COLOR_PALETTE, 1],
  [COLOR_GRAY_ALPHA, 2], [COLOR_RGBA, RGBA]]);
const FILTER_SUB = 1;
const FILTER_UP = 2;
const FILTER_AVERAGE = 3;
const FILTER_PAETH = 4;
const FILTER_COUNT = 5;
const BYTE_BITS = 8;
const CRC_POLY = 0xedb88320;
const CRC_TABLE = computeCrcTable();
const DIRECTION_CELLS = Object.freeze([
  { glyph: '↖', sides: /** @type {Side[]} */ (['top', 'left']), label: 'cima e esquerda' },
  { glyph: '↑', sides: /** @type {Side[]} */ (['top']), label: 'cima' },
  { glyph: '↗', sides: /** @type {Side[]} */ (['top', 'right']), label: 'cima e direita' },
  { glyph: '←', sides: /** @type {Side[]} */ (['left']), label: 'esquerda' },
  { glyph: '▣', sides: /** @type {Side[]} */ ([]), label: 'imagem original' },
  { glyph: '→', sides: /** @type {Side[]} */ (['right']), label: 'direita' },
  { glyph: '↙', sides: /** @type {Side[]} */ (['bottom', 'left']), label: 'baixo e esquerda' },
  { glyph: '↓', sides: /** @type {Side[]} */ (['bottom']), label: 'baixo' },
  { glyph: '↘', sides: /** @type {Side[]} */ (['bottom', 'right']), label: 'baixo e direita' },
]);
const SIDE_NAMES = Object.freeze({ left: 'LEFT', top: 'TOP', right: 'RIGHT', bottom: 'BOTTOM' });
const SIDE_LABELS = Object.freeze({ left: 'esquerda', top: 'cima', right: 'direita',
  bottom: 'baixo' });

/**
 * Decodes an 8-bit, non-interlaced PNG exactly (no canvas: browsers premultiply alpha there).
 * @param {Uint8Array<ArrayBuffer>} bytes
 * @param {AbortSignal} signal
 * @returns {Promise<DecodedPng>}
 */
export async function decodePng(bytes, signal) {
  if (bytes.length < PNG_SIGNATURE.length || PNG_SIGNATURE.some((v, i) => bytes[i] !== v)) {
    throw new Error('Arquivo PNG inválido.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  /** @type {PngHeader | null} */
  let header = null;
  /** @type {Uint8Array<ArrayBuffer> | null} */
  let palette = null;
  /** @type {Uint8Array<ArrayBuffer> | null} */
  let transparency = null;
  /** @type {Uint8Array<ArrayBuffer>[]} */
  const dataParts = [];
  /** @type {Uint8Array<ArrayBuffer>[]} */
  const colorChunks = [];
  while (offset + PNG_CHUNK_OVERHEAD <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + PNG_TYPE_OFFSET,
      offset + PNG_DATA_OFFSET));
    const start = offset + PNG_DATA_OFFSET;
    const end = offset + PNG_CHUNK_OVERHEAD + length;
    if (end > bytes.length) throw new Error('Arquivo PNG truncado.');
    const body = bytes.subarray(start, start + length);
    if (type === 'IHDR' && length === PNG_IHDR_LENGTH) {
      header = { width: view.getUint32(start), height: view.getUint32(start + PNG_TYPE_OFFSET),
        depth: body[PNG_IHDR_DEPTH], colorType: body[PNG_IHDR_COLOR],
        interlace: body[PNG_IHDR_INTERLACE] };
    } else if (type === 'PLTE') {
      palette = body;
    } else if (type === 'tRNS') {
      transparency = body;
    } else if (type === 'IDAT') {
      dataParts.push(body);
    } else if (PNG_COLOR_CHUNKS.includes(type)) {
      colorChunks.push(bytes.slice(offset, end));
    } else if (type === 'IEND') {
      break;
    }
    offset = end;
  }
  const channels = header ? PNG_CHANNELS.get(header.colorType) : undefined;
  if (!header || !channels || header.depth !== PNG_BIT_DEPTH || header.interlace !== 0
    || header.width === 0 || header.height === 0) {
    throw new Error('PNG não suportado: use 8 bits por canal e sem entrelaçamento.');
  }
  if (header.colorType === COLOR_PALETTE && !palette) throw new Error('PNG sem paleta.');
  const raw = await transformBytes(concatBytes(dataParts), new DecompressionStream('deflate'),
    signal);
  const pixels = unfilterRows(raw, header.width, header.height, channels);
  const image = expandToRgba({ pixels, width: header.width, height: header.height,
    colorType: header.colorType, palette, transparency });
  return { image, colorChunks };
}

/**
 * Encodes RGBA8 as PNG with per-row adaptive filtering.
 * @param {RgbaImage} image
 * @param {Uint8Array<ArrayBuffer>[]} colorChunks chunks copied verbatim after IHDR
 * @param {AbortSignal} signal
 * @returns {Promise<Uint8Array<ArrayBuffer>>}
 */
export async function encodePng(image, colorChunks, signal) {
  const stride = image.width * RGBA;
  const raw = new Uint8Array(image.height * (stride + 1));
  const candidates = Array.from({ length: FILTER_COUNT }, () => new Uint8Array(stride));
  const pixels = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  for (let y = 0; y < image.height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    let bestFilter = 0;
    let bestCost = Infinity;
    for (let filter = 0; filter < FILTER_COUNT; filter++) {
      const cost = filterRow(row, previous, filter, candidates[filter]);
      if (cost < bestCost) {
        bestCost = cost;
        bestFilter = filter;
      }
    }
    const at = y * (stride + 1);
    raw[at] = bestFilter;
    raw.set(candidates[bestFilter], at + 1);
  }
  const compressed = await transformBytes(raw, new CompressionStream('deflate'), signal);
  const ihdr = new Uint8Array(PNG_IHDR_LENGTH);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, image.width);
  ihdrView.setUint32(PNG_TYPE_OFFSET, image.height);
  ihdr[PNG_IHDR_DEPTH] = PNG_BIT_DEPTH;
  ihdr[PNG_IHDR_COLOR] = COLOR_RGBA;
  return concatBytes([Uint8Array.from(PNG_SIGNATURE), createChunk('IHDR', ihdr), ...colorChunks,
    createChunk('IDAT', compressed), createChunk('IEND', new Uint8Array(0))]);
}

/**
 * Keeps the source aspect ratio when one side of the target size changes.
 * @param {SizeTex} sourceTex
 * @param {'width' | 'height'} side
 * @param {number} valueTex
 * @returns {SizeTex}
 */
export function resolveLinkedSize(sourceTex, side, valueTex) {
  if (side === 'width') {
    return { width: valueTex, height: Math.round(valueTex * sourceTex.height / sourceTex.width) };
  }
  return { width: Math.round(valueTex * sourceTex.width / sourceTex.height), height: valueTex };
}

/**
 * The expanded image never crops the original and stays within a safe memory size.
 * @param {SizeTex} sourceTex
 * @param {SizeTex} targetTex
 * @returns {SizeTex}
 */
export function clampTargetSize(sourceTex, targetTex) {
  /** @param {number} value @param {number} min */
  const clampSide = (value, min) => Math.min(MAX_TARGET_EDGE_TEX,
    Math.max(min, Math.round(Number.isFinite(value) ? value : min)));
  return { width: clampSide(targetTex.width, sourceTex.width),
    height: clampSide(targetTex.height, sourceTex.height) };
}

/**
 * Distributes the extra size over the active sides; an axis with no active side grows evenly.
 * @param {SizeTex} sourceTex
 * @param {SizeTex} targetTex
 * @param {ReadonlySet<Side>} activeSides
 * @returns {MarginsTex}
 */
export function computeMarginsTex(sourceTex, targetTex, activeSides) {
  const [left, right] = splitExtra(targetTex.width - sourceTex.width,
    activeSides.has('left'), activeSides.has('right'));
  const [top, bottom] = splitExtra(targetTex.height - sourceTex.height,
    activeSides.has('top'), activeSides.has('bottom'));
  return { left, top, right, bottom };
}

/**
 * Size sent to the model: multiples of 16, ratio up to 3:1, 655,360..3,686,400 pixels.
 * @param {SizeTex} targetTex
 * @returns {SizeTex}
 */
export function computeApiSizeTex(targetTex) {
  const ratioLimitError = `A proporção da imagem expandida deve ficar entre 1:${API_MAX_RATIO} `
    + `e ${API_MAX_RATIO}:1.`;
  if (Math.max(targetTex.width / targetTex.height, targetTex.height / targetTex.width)
    > API_MAX_RATIO) {
    throw new Error(ratioLimitError);
  }
  const pixels = targetTex.width * targetTex.height;
  let scale = Math.min(1, Math.sqrt(API_STABLE_PIXELS / pixels),
    API_MAX_EDGE_TEX / Math.max(targetTex.width, targetTex.height));
  const isUpscaled = pixels * scale * scale < API_MIN_PIXELS;
  if (isUpscaled) scale = Math.sqrt(API_MIN_PIXELS / pixels);
  /** @param {number} value */
  const snap = (value) => Math.max(API_STEP_TEX,
    (isUpscaled ? Math.ceil(value / API_STEP_TEX) : Math.round(value / API_STEP_TEX))
    * API_STEP_TEX);
  const sizeTex = { width: snap(targetTex.width * scale), height: snap(targetTex.height * scale) };
  if (Math.max(sizeTex.width / sizeTex.height, sizeTex.height / sizeTex.width) > API_MAX_RATIO) {
    throw new Error(ratioLimitError);
  }
  return sizeTex;
}

/**
 * Instruction text: directions in model pixels, alpha rules, color legend and the user request.
 * @param {Object} options
 * @param {MarginsTex} options.marginsTex
 * @param {SizeTex} options.targetTex expanded image
 * @param {SizeTex} options.apiSizeTex model image
 * @param {boolean} options.isOpaque
 * @param {string} options.userText
 * @param {string[]} options.colorNames prompt names of the brush colors used
 * @returns {string}
 */
export function buildPrompt({ marginsTex, targetTex, apiSizeTex, isOpaque, userText,
  colorNames }) {
  const sides = /** @type {Side[]} */ (['left', 'right', 'top', 'bottom'])
    .filter((side) => marginsTex[side] > 0);
  const strips = sides.map((side) => {
    const isHorizontal = side === 'left' || side === 'right';
    const apiPerTarget = isHorizontal ? apiSizeTex.width / targetTex.width
      : apiSizeTex.height / targetTex.height;
    const stripApiTex = Math.round(marginsTex[side] * apiPerTarget);
    return `${stripApiTex} px on the ${SIDE_NAMES[side]}`;
  }).join(', ');
  const lines = [
    isOpaque
      ? 'Outpaint (extend the canvas of) this image. It is ONE LAYER of a 2D parallax scene: '
        + 'a fully opaque painted background.'
      : 'Outpaint (extend the canvas of) this image. It is ONE LAYER of a 2D parallax scene: '
        + 'painted cut-out elements on a fully transparent background.',
    `The canvas was enlarged with new empty strips: ${strips}. Expansion directions: `
      + `${sides.map((side) => SIDE_NAMES[side]).join(' + ')}. In the annotation layer, the `
      + 'solid MAGENTA (#FF00FF) areas mark exactly these new empty strips. Never draw magenta '
      + 'in the output.',
    'Fill the new strips by seamlessly continuing the existing content across the old borders, '
      + 'with the same art style, palette, lighting, perspective, scale and level of detail.',
    'Content that is cut by an old border must keep going all the way to the NEW outer edge of '
      + 'the canvas and be cut there; never let it end, taper or fade out inside the new strips.',
    'Do NOT alter, move, rescale, crop or redraw anything that already exists; the original '
      + 'area must stay pixel-identical.',
    isOpaque
      ? 'The result must be fully opaque, with no frame, border or vignette.'
      : 'TRANSPARENCY: everything that is transparent now must stay fully transparent. In the '
        + 'new strips, continue opaque content only where it crosses the old borders, and keep '
        + 'transparent every area that continues an empty region. Do not add sky, background, '
        + 'fog, frame, border, vignette or ground shadow. Keep the alpha channel.',
  ];
  if (colorNames.length > 0) {
    lines.push(`Colored annotation marks (${colorNames.join(', ')}) show where to apply the `
      + 'parts of the user request that mention each color. Remove every annotation color from '
      + 'the result.');
  }
  lines.push(`User request: ${userText.trim() || DEFAULT_REQUEST}`);
  return lines.join('\n');
}

/**
 * Model input: the original placed inside the expanded canvas, resized to the model size.
 * @param {RgbaImage} source
 * @param {MarginsTex} marginsTex
 * @param {SizeTex} apiSizeTex
 * @returns {RgbaImage}
 */
export function composeInput(source, marginsTex, apiSizeTex) {
  const canvas = createImage(source.width + marginsTex.left + marginsTex.right,
    source.height + marginsTex.top + marginsTex.bottom);
  pasteImage(canvas, source, marginsTex.left, marginsTex.top);
  return resizeImage(canvas, apiSizeTex.width, apiSizeTex.height);
}

/**
 * Annotation layer at model size: magenta new strips plus the user's brush strokes.
 * @param {Object} options
 * @param {SizeTex} options.sourceTex
 * @param {MarginsTex} options.marginsTex
 * @param {SizeTex} options.apiSizeTex
 * @param {Stroke[]} options.strokes
 * @returns {RgbaImage}
 */
export function composeMarkup({ sourceTex, marginsTex, apiSizeTex, strokes }) {
  const targetTex = expandedSize(sourceTex, marginsTex);
  const scaleX = apiSizeTex.width / targetTex.width;
  const scaleY = apiSizeTex.height / targetTex.height;
  const markup = createImage(apiSizeTex.width, apiSizeTex.height);
  const marker = Uint8ClampedArray.of(...MARKER_RGB, OPAQUE_ALPHA);
  for (let y = 0; y < markup.height; y++) {
    const yTex = (y + 0.5) / scaleY;
    const isRowOutside = yTex < marginsTex.top || yTex >= marginsTex.top + sourceTex.height;
    for (let x = 0; x < markup.width; x++) {
      const xTex = (x + 0.5) / scaleX;
      if (isRowOutside || xTex < marginsTex.left || xTex >= marginsTex.left + sourceTex.width) {
        markup.data.set(marker, (y * markup.width + x) * RGBA);
      }
    }
  }
  for (const stroke of strokes) {
    const color = Uint8ClampedArray.of(...parseHexColor(stroke.color), OPAQUE_ALPHA);
    paintStroke({ image: markup, stroke, scaleX, scaleY, growTex: 0,
      paint: (i) => markup.data.set(color, i * RGBA) });
  }
  return markup;
}

/**
 * Final layer: model pixels in the new strips and painted areas, original pixels elsewhere.
 * The model drifts by a few pixels and tone, so it is registered and tone matched first; the
 * optional band blends the last bandTex pixels of each expanded edge to hide the seam.
 * @param {Object} options
 * @param {RgbaImage} options.source
 * @param {RgbaImage} options.aiImage model output, any size
 * @param {MarginsTex} options.marginsTex
 * @param {Stroke[]} options.strokes
 * @param {number} options.bandTex
 * @returns {{ image: RgbaImage, warnings: string[] }}
 */
export function composeResult({ source, aiImage, marginsTex, strokes, bandTex }) {
  const targetTex = expandedSize(source, marginsTex);
  const resized = resizeImage(aiImage, targetTex.width, targetTex.height);
  const shift = estimateShift(source, resized, marginsTex);
  const ai = matchTone(source, shiftImage(resized, shift.dxTex, shift.dyTex), marginsTex);
  const keepStroke = computeStrokeKeep(strokes, targetTex);
  const image = { width: ai.width, height: ai.height, data: new Uint8ClampedArray(ai.data) };
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const xTex = x + marginsTex.left;
      const yTex = y + marginsTex.top;
      const keepBand = computeBandWeight({ x, y, sourceTex: source, marginsTex, bandTex });
      const keep = keepStroke ? Math.min(keepBand, keepStroke[yTex * targetTex.width + xTex])
        : keepBand;
      blendPixel({ out: image.data, at: (yTex * targetTex.width + xTex) * RGBA,
        original: source.data, originalAt: (y * source.width + x) * RGBA, keep });
    }
  }
  return { image, warnings: collectWarnings(source, image, marginsTex) };
}

/**
 * Calls the OpenAI image edit endpoint with the annotation layer and returns the PNG bytes.
 * @param {Object} options
 * @param {string} options.apiKey
 * @param {string} options.prompt
 * @param {Uint8Array<ArrayBuffer>} options.inputPng
 * @param {Uint8Array<ArrayBuffer>} options.markupPng
 * @param {SizeTex} options.apiSizeTex
 * @param {boolean} options.isOpaque
 * @param {AbortSignal} signal
 * @returns {Promise<Uint8Array<ArrayBuffer>>}
 */
export async function requestAiExpansion(options, signal) {
  const form = new FormData();
  form.append('model', AI_MODEL);
  form.append('prompt', options.prompt);
  form.append('image', new Blob([options.inputPng], { type: 'image/png' }), 'input.png');
  form.append('markup', new Blob([options.markupPng], { type: 'image/png' }), 'markup.png');
  form.append('size', `${options.apiSizeTex.width}x${options.apiSizeTex.height}`);
  form.append('quality', 'high');
  form.append('background', options.isOpaque ? 'opaque' : 'transparent');
  form.append('output_format', 'png');
  form.append('n', '1');
  // Pasted keys may carry invisible characters, which make the header invalid.
  const apiKey = options.apiKey.replace(NON_KEY_CHARS, '');
  const startedAtMs = Date.now();
  let response;
  try {
    response = await fetch(EDIT_URL, { method: 'POST', body: form, signal,
      headers: { Authorization: `Bearer ${apiKey}` } });
  } catch (error) {
    if (isAbortError(error)) throw error;
    const elapsedMs = Date.now() - startedAtMs;
    const elapsedSec = Math.round(elapsedMs / MS_PER_SEC);
    const detail = errorText(error);
    throw new Error(`Sem resposta após ${elapsedSec} s (${detail}). Confira se o npm run dev `
      + 'continua rodando; a geração pode ter sido cobrada, veja o uso da API.',
    { cause: error });
  }
  signal.throwIfAborted();
  /** @type {unknown} */
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error(`Resposta inválida da API (HTTP ${response.status}).`, { cause: error });
  }
  signal.throwIfAborted();
  const body = /** @type {ApiBody | null} */ (payload);
  if (!response.ok) {
    const detail = typeof body?.error?.message === 'string' ? body.error.message : 'erro';
    throw new Error(`API da OpenAI: ${detail} (HTTP ${response.status}).`);
  }
  const encoded = body?.data?.[0]?.b64_json;
  if (typeof encoded !== 'string') throw new Error('A API não devolveu imagem.');
  return base64ToBytes(encoded);
}

/**
 * @param {RgbaImage} image
 * @returns {boolean}
 */
export function isOpaqueImage(image) {
  for (let i = RGBA - 1; i < image.data.length; i += RGBA) {
    if (image.data[i] !== OPAQUE_ALPHA) return false;
  }
  return true;
}

/**
 * Editor dialog: large preview, direction grid, size lock, brushes, generation and review.
 * The DOM is read on creation, so create it only when the dialog is first opened.
 * @returns {{ open: (options: PanelOpenOptions) => void }}
 */
export function createAiExpandPanel() {
  /** @param {string} id */
  const byId = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const dialog = /** @type {HTMLDialogElement} */ (byId('ai-dialog'));
  const stage = /** @type {HTMLCanvasElement} */ (byId('ai-stage'));
  const title = byId('ai-title');
  const info = byId('ai-source-info');
  const directions = byId('ai-directions');
  const widthInput = /** @type {HTMLInputElement} */ (byId('ai-width'));
  const heightInput = /** @type {HTMLInputElement} */ (byId('ai-height'));
  const lockButton = /** @type {HTMLButtonElement} */ (byId('ai-lock'));
  const marginsInfo = byId('ai-margins');
  const thinButton = /** @type {HTMLButtonElement} */ (byId('ai-brush-thin'));
  const thickButton = /** @type {HTMLButtonElement} */ (byId('ai-brush-thick'));
  const colors = byId('ai-colors');
  const undoButton = /** @type {HTMLButtonElement} */ (byId('ai-undo'));
  const clearButton = /** @type {HTMLButtonElement} */ (byId('ai-clear'));
  const promptInput = /** @type {HTMLTextAreaElement} */ (byId('ai-prompt'));
  const bandInput = /** @type {HTMLInputElement} */ (byId('ai-band'));
  const bandValue = byId('ai-band-val');
  const keyInput = /** @type {HTMLInputElement} */ (byId('ai-key'));
  const status = byId('ai-status');
  const closeButton = /** @type {HTMLButtonElement} */ (byId('ai-close'));
  const backButton = /** @type {HTMLButtonElement} */ (byId('ai-back'));
  const compareButton = /** @type {HTMLButtonElement} */ (byId('ai-compare'));
  const downloadButton = /** @type {HTMLButtonElement} */ (byId('ai-download'));
  const generateButton = /** @type {HTMLButtonElement} */ (byId('ai-generate'));
  const applyButton = /** @type {HTMLButtonElement} */ (byId('ai-apply'));
  const context = /** @type {CanvasRenderingContext2D} */ (stage.getContext('2d'));

  const state = {
    generation: 0,
    /** @type {AbortController | null} */ controller: null,
    /** @type {'edit' | 'busy' | 'review'} */ mode: 'edit',
    /** @type {PanelOpenOptions | null} */ options: null,
    /** @type {RgbaImage | null} */ source: null,
    /** @type {Uint8Array<ArrayBuffer>[]} */ colorChunks: [],
    /** @type {ImageBitmap | null} */ sourceBitmap: null,
    isSourceOpaque: false,
    /** @type {SizeTex} */ targetTex: { width: 1, height: 1 },
    /** @type {Set<Side>} */ activeSides: new Set(),
    isLocked: true,
    /** @type {Stroke[]} */ strokes: [],
    /** @type {Stroke | null} */ drawing: null,
    brushColor: BRUSH_COLORS[0].css,
    brushWidthCss: BRUSH_THIN_CSS,
    /** @type {RgbaImage | null} */ aiImage: null,
    /** @type {MarginsTex | null} */ reviewMarginsTex: null,
    /** @type {Stroke[]} */ reviewStrokes: [],
    /** @type {Blob | null} */ resultBlob: null,
    /** @type {ImageBitmap | null} */ resultBitmap: null,
    isComparing: false,
    isApplied: false,
    view: { scaleCssPerTex: 1, offsetXCss: 0, offsetYCss: 0 },
  };

  /** @type {HTMLButtonElement[]} */
  const directionButtons = DIRECTION_CELLS.map((cell) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.textContent = cell.glyph;
    button.setAttribute('aria-label', cell.sides.length > 0 ? `Expandir para ${cell.label}`
      : 'Imagem original (referência)');
    button.disabled = cell.sides.length === 0;
    button.addEventListener('click', () => toggleSides(cell.sides));
    directions.appendChild(button);
    return button;
  });
  /** @type {HTMLButtonElement[]} */
  const colorButtons = BRUSH_COLORS.map((color) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ai-swatch';
    button.style.background = color.css;
    button.setAttribute('aria-label', `Pincel ${color.label}`);
    button.addEventListener('click', () => {
      state.brushColor = color.css;
      syncControls();
    });
    colors.appendChild(button);
    return button;
  });

  /**
   * @param {string} message
   * @param {boolean} [isError]
   */
  function setStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle('error', isError);
  }

  function currentMarginsTex() {
    if (!state.source) return { left: 0, top: 0, right: 0, bottom: 0 };
    return computeMarginsTex(state.source, state.targetTex, state.activeSides);
  }

  function syncControls() {
    const isEdit = state.mode === 'edit';
    const isReview = state.mode === 'review';
    const hasSource = state.source !== null;
    directionButtons.forEach((button, index) => {
      const sides = DIRECTION_CELLS[index].sides;
      button.setAttribute('aria-pressed', String(sides.length > 0
        && sides.every((side) => state.activeSides.has(side))));
      button.disabled = !isEdit || !hasSource || sides.length === 0;
    });
    colorButtons.forEach((button, index) => {
      button.setAttribute('aria-pressed', String(BRUSH_COLORS[index].css === state.brushColor));
      button.disabled = !isEdit;
    });
    thinButton.setAttribute('aria-pressed', String(state.brushWidthCss === BRUSH_THIN_CSS));
    thickButton.setAttribute('aria-pressed', String(state.brushWidthCss === BRUSH_THICK_CSS));
    lockButton.setAttribute('aria-pressed', String(state.isLocked));
    lockButton.textContent = state.isLocked ? '🔒' : '🔓';
    for (const control of [widthInput, heightInput, lockButton, thinButton, thickButton,
      undoButton, clearButton, promptInput, keyInput]) {
      control.disabled = !isEdit || !hasSource;
    }
    undoButton.disabled ||= state.strokes.length === 0;
    clearButton.disabled ||= state.strokes.length === 0;
    bandInput.disabled = state.mode === 'busy' || !hasSource;
    bandValue.textContent = `${bandInput.value} px`;
    widthInput.value = String(state.targetTex.width);
    heightInput.value = String(state.targetTex.height);
    generateButton.textContent = isReview ? 'Gerar de novo' : 'Gerar';
    generateButton.disabled = state.mode === 'busy' || !hasSource;
    closeButton.textContent = state.mode === 'busy' ? 'Cancelar' : 'Fechar';
    for (const button of [backButton, compareButton, downloadButton, applyButton]) {
      button.hidden = !isReview;
    }
    applyButton.disabled = state.isApplied;
    applyButton.textContent = state.isApplied ? 'Aplicado' : 'Aplicar na camada';
    backButton.disabled = state.isApplied;
    compareButton.textContent = state.isComparing ? 'Ver resultado' : 'Ver original';
    stage.classList.toggle('drawing', isEdit);
    if (state.source) {
      const marginsTex = currentMarginsTex();
      const parts = /** @type {Side[]} */ (['left', 'top', 'right', 'bottom'])
        .map((side) => `${SIDE_LABELS[side]} ${marginsTex[side]}`);
      let apiText;
      try {
        const apiSizeTex = computeApiSizeTex(state.targetTex);
        apiText = `IA gera em ${apiSizeTex.width}×${apiSizeTex.height} px.`;
      } catch (error) {
        apiText = error instanceof Error ? error.message : String(error);
      }
      marginsInfo.textContent = `Margens (px): ${parts.join(' · ')}. ${apiText}`;
    }
  }

  function computeView() {
    const rect = stage.getBoundingClientRect();
    const pixelRatio = window.devicePixelRatio || 1;
    const widthRender = Math.max(1, Math.round(rect.width * pixelRatio));
    const heightRender = Math.max(1, Math.round(rect.height * pixelRatio));
    if (stage.width !== widthRender || stage.height !== heightRender) {
      stage.width = widthRender;
      stage.height = heightRender;
    }
    const scaleCssPerTex = Math.max(Number.EPSILON, Math.min(
      (rect.width - 2 * STAGE_PAD_CSS) / state.targetTex.width,
      (rect.height - 2 * STAGE_PAD_CSS) / state.targetTex.height));
    const frameWidthCss = state.targetTex.width * scaleCssPerTex;
    const frameHeightCss = state.targetTex.height * scaleCssPerTex;
    state.view = { scaleCssPerTex, offsetXCss: (rect.width - frameWidthCss) / 2,
      offsetYCss: (rect.height - frameHeightCss) / 2 };
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    return rect;
  }

  function render() {
    const rect = computeView();
    const { scaleCssPerTex, offsetXCss, offsetYCss } = state.view;
    context.clearRect(0, 0, rect.width, rect.height);
    if (!state.source) return;
    const frameWidthCss = state.targetTex.width * scaleCssPerTex;
    const frameHeightCss = state.targetTex.height * scaleCssPerTex;
    drawChecker(context, { xCss: offsetXCss, yCss: offsetYCss, widthCss: frameWidthCss,
      heightCss: frameHeightCss });
    const showResult = state.mode === 'review' && !state.isComparing && state.resultBitmap;
    const marginsTex = state.mode === 'review' && state.reviewMarginsTex ? state.reviewMarginsTex
      : currentMarginsTex();
    const leftCss = marginsTex.left * scaleCssPerTex;
    const topCss = marginsTex.top * scaleCssPerTex;
    const sourceWidthCss = state.source.width * scaleCssPerTex;
    const sourceHeightCss = state.source.height * scaleCssPerTex;
    if (showResult && state.resultBitmap) {
      context.drawImage(state.resultBitmap, offsetXCss, offsetYCss, frameWidthCss,
        frameHeightCss);
    } else if (state.sourceBitmap) {
      context.drawImage(state.sourceBitmap, offsetXCss + leftCss, offsetYCss + topCss,
        sourceWidthCss, sourceHeightCss);
    }
    context.save();
    context.strokeStyle = 'rgba(56, 189, 248, 0.9)';
    context.setLineDash([6, 4]);
    context.strokeRect(offsetXCss + leftCss, offsetYCss + topCss, sourceWidthCss, sourceHeightCss);
    context.setLineDash([]);
    context.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    context.strokeRect(offsetXCss, offsetYCss, frameWidthCss, frameHeightCss);
    context.restore();
    if (state.mode !== 'review') {
      for (const stroke of state.strokes) drawStroke(stroke);
    }
  }

  /** @param {Stroke} stroke */
  function drawStroke(stroke) {
    const { scaleCssPerTex, offsetXCss, offsetYCss } = state.view;
    const widthCss = stroke.widthTex * scaleCssPerTex;
    context.save();
    context.strokeStyle = stroke.color;
    context.fillStyle = stroke.color;
    context.lineWidth = widthCss;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    for (let i = 0; i < stroke.pointsTex.length; i += 2) {
      const xCss = offsetXCss + stroke.pointsTex[i] * scaleCssPerTex;
      const yCss = offsetYCss + stroke.pointsTex[i + 1] * scaleCssPerTex;
      if (i === 0) context.moveTo(xCss, yCss); else context.lineTo(xCss, yCss);
    }
    if (stroke.pointsTex.length === 2) {
      context.arc(offsetXCss + stroke.pointsTex[0] * scaleCssPerTex,
        offsetYCss + stroke.pointsTex[1] * scaleCssPerTex, widthCss / 2, 0, 2 * Math.PI);
      context.fill();
    } else {
      context.stroke();
    }
    context.restore();
  }

  /** @param {Side[]} sides */
  function toggleSides(sides) {
    if (!state.source) return;
    const isActive = sides.every((side) => state.activeSides.has(side));
    for (const side of sides) {
      if (isActive) state.activeSides.delete(side); else state.activeSides.add(side);
    }
    if (!isActive) {
      // A side switched on with no room to grow gets a starting size the user can edit.
      const growsX = sides.some((side) => side === 'left' || side === 'right')
        && state.targetTex.width === state.source.width;
      const growsY = sides.some((side) => side === 'top' || side === 'bottom')
        && state.targetTex.height === state.source.height;
      let next = { ...state.targetTex };
      if (growsX) next.width = Math.round(state.source.width * (1 + GROW_RATIO));
      if (growsY) next.height = Math.round(state.source.height * (1 + GROW_RATIO));
      if (state.isLocked && growsX !== growsY) {
        next = resolveLinkedSize(state.source, growsX ? 'width' : 'height',
          growsX ? next.width : next.height);
      }
      state.targetTex = clampTargetSize(state.source, next);
    }
    syncControls();
    render();
  }

  /** @param {'width' | 'height'} side */
  function onSizeChange(side) {
    if (!state.source) return;
    const valueTex = Number((side === 'width' ? widthInput : heightInput).value);
    const next = state.isLocked ? resolveLinkedSize(state.source, side, valueTex)
      : { ...state.targetTex, [side]: valueTex };
    state.targetTex = clampTargetSize(state.source, next);
    syncControls();
    render();
  }

  /** @param {PointerEvent} event */
  function toTex(event) {
    const rect = stage.getBoundingClientRect();
    const { scaleCssPerTex, offsetXCss, offsetYCss } = state.view;
    const xTex = (event.clientX - rect.left - offsetXCss) / scaleCssPerTex;
    const yTex = (event.clientY - rect.top - offsetYCss) / scaleCssPerTex;
    return [Math.min(state.targetTex.width, Math.max(0, xTex)),
      Math.min(state.targetTex.height, Math.max(0, yTex))];
  }

  stage.addEventListener('pointerdown', (event) => {
    if (state.mode !== 'edit' || !state.source || event.button !== 0) return;
    stage.setPointerCapture(event.pointerId);
    const widthTex = state.brushWidthCss / state.view.scaleCssPerTex;
    state.drawing = { color: state.brushColor, widthTex, pointsTex: toTex(event) };
    state.strokes.push(state.drawing);
    render();
  });
  stage.addEventListener('pointermove', (event) => {
    if (!state.drawing) return;
    state.drawing.pointsTex.push(...toTex(event));
    render();
  });
  for (const type of ['pointerup', 'pointercancel']) {
    stage.addEventListener(type, () => {
      if (!state.drawing) return;
      state.drawing = null;
      syncControls();
    });
  }

  directions.setAttribute('role', 'group');
  widthInput.addEventListener('change', () => onSizeChange('width'));
  heightInput.addEventListener('change', () => onSizeChange('height'));
  lockButton.addEventListener('click', () => {
    state.isLocked = !state.isLocked;
    syncControls();
  });
  thinButton.addEventListener('click', () => {
    state.brushWidthCss = BRUSH_THIN_CSS;
    syncControls();
  });
  thickButton.addEventListener('click', () => {
    state.brushWidthCss = BRUSH_THICK_CSS;
    syncControls();
  });
  undoButton.addEventListener('click', () => {
    state.strokes.pop();
    syncControls();
    render();
  });
  clearButton.addEventListener('click', () => {
    state.strokes = [];
    syncControls();
    render();
  });
  bandInput.addEventListener('input', () => {
    bandValue.textContent = `${bandInput.value} px`;
  });
  bandInput.addEventListener('change', () => {
    if (state.mode === 'review') recompose();
  });
  keyInput.addEventListener('change', () => {
    try {
      sessionStorage.setItem(KEY_STORAGE, keyInput.value.trim());
    } catch (error) {
      setStatus(`A chave vale só enquanto o painel estiver aberto (${errorText(error)}).`);
    }
  });
  generateButton.addEventListener('click', () => {
    generate();
  });
  backButton.addEventListener('click', () => {
    releaseResult();
    state.mode = 'edit';
    setStatus('');
    syncControls();
    render();
  });
  compareButton.addEventListener('click', () => {
    state.isComparing = !state.isComparing;
    syncControls();
    render();
  });
  downloadButton.addEventListener('click', () => {
    if (!state.resultBlob || !state.options) return;
    const url = URL.createObjectURL(state.resultBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = resultName(state.options.asset.name);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  applyButton.addEventListener('click', () => {
    apply();
  });
  closeButton.addEventListener('click', () => {
    if (state.mode === 'busy') {
      cancelWork();
      state.mode = state.resultBitmap ? 'review' : 'edit';
      setStatus('Geração cancelada.');
      syncControls();
      render();
    } else {
      dialog.close();
    }
  });
  dialog.addEventListener('close', () => {
    cancelWork();
    releaseResult();
    state.sourceBitmap?.close();
    state.sourceBitmap = null;
    state.source = null;
    state.options = null;
  });
  window.addEventListener('resize', () => {
    if (dialog.open) render();
  });

  function cancelWork() {
    state.generation++;
    state.controller?.abort();
    state.controller = null;
  }

  function releaseResult() {
    state.resultBitmap?.close();
    state.resultBitmap = null;
    state.resultBlob = null;
    state.aiImage = null;
    state.isComparing = false;
    state.isApplied = false;
  }

  /** Starts a cancellable task; returns its generation and signal. */
  function beginTask() {
    cancelWork();
    const generation = state.generation;
    const controller = new AbortController();
    state.controller = controller;
    return { generation, signal: controller.signal };
  }

  /**
   * @param {unknown} error
   * @param {number} generation
   * @param {'edit' | 'review'} fallbackMode
   */
  function failTask(error, generation, fallbackMode) {
    if (isAbortError(error) || generation !== state.generation) return;
    state.mode = fallbackMode;
    setStatus(errorText(error), true);
    syncControls();
    render();
  }

  /** @param {PanelOpenOptions} options */
  async function open(options) {
    cancelWork();
    releaseResult();
    state.sourceBitmap?.close();
    Object.assign(state, { options, source: null, sourceBitmap: null, colorChunks: [],
      strokes: [], drawing: null, activeSides: new Set(), isLocked: true, mode: 'busy',
      reviewMarginsTex: null, reviewStrokes: [] });
    title.textContent = `Expandir com IA — ${options.title}`;
    info.textContent = `${options.asset.name}`;
    promptInput.value = '';
    bandInput.value = String(DEFAULT_BAND_TEX);
    try {
      keyInput.value = sessionStorage.getItem(KEY_STORAGE) ?? '';
    } catch (error) {
      keyInput.value = '';
      setStatus(`Não foi possível ler a chave salva (${errorText(error)}).`);
    }
    setStatus('Carregando a imagem da camada…');
    syncControls();
    if (!dialog.open) dialog.showModal();
    const { generation, signal } = beginTask();
    try {
      const blob = await options.loadSource(signal);
      signal.throwIfAborted();
      const decoded = options.asset.type === 'png'
        ? await decodePng(new Uint8Array(await blob.arrayBuffer()), signal)
        : { image: await decodeOpaqueImage(blob, signal), colorChunks: [] };
      signal.throwIfAborted();
      const bitmap = await createImageBitmap(blob);
      if (generation !== state.generation) {
        bitmap.close();
        return;
      }
      Object.assign(state, { source: decoded.image, colorChunks: decoded.colorChunks,
        sourceBitmap: bitmap, isSourceOpaque: isOpaqueImage(decoded.image), mode: 'edit',
        targetTex: { width: decoded.image.width, height: decoded.image.height } });
      info.textContent = `${options.asset.name} — original ${decoded.image.width}×`
        + `${decoded.image.height} px${state.isSourceOpaque ? ', opaca' : ', com transparência'}`;
      setStatus('Escolha as direções, o novo tamanho e, se quiser, rabisque e descreva.');
      syncControls();
      render();
    } catch (error) {
      failTask(error, generation, 'edit');
    }
  }

  async function generate() {
    const source = state.source;
    const options = state.options;
    if (!source || !options || state.mode === 'busy') return;
    const apiKey = keyInput.value.trim();
    const marginsTex = currentMarginsTex();
    if (!apiKey) {
      setStatus('Informe a chave da API da OpenAI.', true);
      return;
    }
    if (marginsTex.left + marginsTex.top + marginsTex.right + marginsTex.bottom === 0) {
      setStatus('Escolha uma direção ou aumente o tamanho antes de gerar.', true);
      return;
    }
    let apiSizeTex;
    try {
      apiSizeTex = computeApiSizeTex(state.targetTex);
    } catch (error) {
      setStatus(errorText(error), true);
      return;
    }
    const strokes = state.strokes.map((stroke) => ({ ...stroke,
      pointsTex: [...stroke.pointsTex] }));
    const fallbackMode = state.resultBitmap ? 'review' : 'edit';
    const { generation, signal } = beginTask();
    state.mode = 'busy';
    syncControls();
    try {
      setStatus('Preparando a imagem e as marcações…');
      await yieldToBrowser(signal);
      const inputPng = await encodePng(composeInput(source, marginsTex, apiSizeTex), [], signal);
      const markupPng = await encodePng(composeMarkup({ sourceTex: source, marginsTex,
        apiSizeTex, strokes }), [], signal);
      const colorNames = BRUSH_COLORS.filter((color) => strokes.some(
        (stroke) => stroke.color === color.css)).map((color) => color.promptName);
      const prompt = buildPrompt({ marginsTex, targetTex: expandedSize(source, marginsTex),
        apiSizeTex, isOpaque: state.isSourceOpaque, userText: promptInput.value, colorNames });
      setStatus('Gerando com a IA (costuma levar de 30 a 60 s)…');
      const aiPng = await requestAiExpansion({ apiKey, prompt, inputPng, markupPng, apiSizeTex,
        isOpaque: state.isSourceOpaque }, signal);
      const { image: aiImage } = await decodePng(aiPng, signal);
      if (generation !== state.generation) return;
      releaseResult();
      Object.assign(state, { aiImage, reviewMarginsTex: marginsTex, reviewStrokes: strokes });
      await showResult(generation, signal);
    } catch (error) {
      failTask(error, generation, fallbackMode);
    }
  }

  function recompose() {
    const { generation, signal } = beginTask();
    state.mode = 'busy';
    syncControls();
    showResult(generation, signal).catch((error) => failTask(error, generation, 'review'));
  }

  /**
   * @param {number} generation
   * @param {AbortSignal} signal
   */
  async function showResult(generation, signal) {
    const { source, aiImage, reviewMarginsTex } = state;
    if (!source || !aiImage || !reviewMarginsTex) return;
    setStatus('Recompondo o original sobre o resultado…');
    await yieldToBrowser(signal);
    const bandTex = Number(bandInput.value);
    const { image, warnings } = composeResult({ source, aiImage, marginsTex: reviewMarginsTex,
      strokes: state.reviewStrokes, bandTex });
    const png = await encodePng(image, state.colorChunks, signal);
    const blob = new Blob([png], { type: 'image/png' });
    const bitmap = await createImageBitmap(blob);
    if (generation !== state.generation) {
      bitmap.close();
      return;
    }
    state.resultBitmap?.close();
    Object.assign(state, { resultBlob: blob, resultBitmap: bitmap, mode: 'review',
      isApplied: false });
    const painted = state.reviewStrokes.length > 0 ? ' e das áreas pintadas' : '';
    const kept = bandTex > 0
      ? `Original intacto fora da faixa de ${bandTex} px${painted}.`
      : `Original 100% intacto${painted ? ' fora das áreas pintadas' : ''}.`;
    setStatus([`Pronto: ${image.width}×${image.height} px. ${kept}`, ...warnings].join(' '),
      warnings.length > 0);
    syncControls();
    render();
  }

  async function apply() {
    const { options, resultBlob, reviewMarginsTex, source } = state;
    if (!options || !resultBlob || !reviewMarginsTex || !source) return;
    const sizeTex = expandedSize(source, reviewMarginsTex);
    const file = new File([resultBlob], resultName(options.asset.name), { type: 'image/png' });
    state.mode = 'busy';
    setStatus('Aplicando na camada…');
    syncControls();
    let result;
    try {
      result = await options.onApply({ file, sizeTex, marginsTex: reviewMarginsTex });
    } catch (error) {
      result = { ok: false, message: errorText(error) };
    }
    // Stays open after applying so the PNG can still be downloaded into demo/assets.
    Object.assign(state, { mode: 'review', isApplied: result.ok });
    setStatus(result.ok ? `${result.message} Use “Baixar PNG” e salve o arquivo em demo/assets `
      + 'para manter a camada na configuração.' : result.message, !result.ok);
    syncControls();
  }

  return {
    open(options) {
      open(options);
    },
  };
}

/**
 * Splits extra pixels of one axis between its two sides.
 * @param {number} extra
 * @param {boolean} hasStart
 * @param {boolean} hasEnd
 * @returns {[number, number]}
 */
function splitExtra(extra, hasStart, hasEnd) {
  if (hasStart && !hasEnd) return [extra, 0];
  if (hasEnd && !hasStart) return [0, extra];
  const start = Math.floor(extra / 2);
  return [start, extra - start];
}

/**
 * @param {SizeTex} sourceTex
 * @param {MarginsTex} marginsTex
 * @returns {SizeTex}
 */
function expandedSize(sourceTex, marginsTex) {
  return { width: sourceTex.width + marginsTex.left + marginsTex.right,
    height: sourceTex.height + marginsTex.top + marginsTex.bottom };
}

/**
 * @param {number} width
 * @param {number} height
 * @returns {RgbaImage}
 */
function createImage(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * RGBA) };
}

/**
 * Copies source into target at (x, y), replacing pixels.
 * @param {RgbaImage} target
 * @param {RgbaImage} source
 * @param {number} x
 * @param {number} y
 */
function pasteImage(target, source, x, y) {
  const stride = source.width * RGBA;
  for (let row = 0; row < source.height; row++) {
    target.data.set(source.data.subarray(row * stride, (row + 1) * stride),
      ((row + y) * target.width + x) * RGBA);
  }
}

/**
 * Separable triangle filter on premultiplied alpha (no dark halos); same size returns a copy.
 * @param {RgbaImage} image
 * @param {number} width
 * @param {number} height
 * @returns {RgbaImage}
 */
function resizeImage(image, width, height) {
  if (image.width === width && image.height === height) {
    return { width, height, data: new Uint8ClampedArray(image.data) };
  }
  const premultiplied = new Float32Array(image.data.length);
  for (let i = 0; i < image.data.length; i += RGBA) {
    const alpha = image.data[i + 3] / OPAQUE_ALPHA;
    premultiplied[i] = image.data[i] * alpha;
    premultiplied[i + 1] = image.data[i + 1] * alpha;
    premultiplied[i + 2] = image.data[i + 2] * alpha;
    premultiplied[i + 3] = image.data[i + 3];
  }
  const horizontal = resizePass({ pixels: premultiplied, width: image.width, height: image.height,
    size: width, isHorizontal: true });
  const both = resizePass({ pixels: horizontal, width, height: image.height, size: height,
    isHorizontal: false });
  const out = createImage(width, height);
  for (let i = 0; i < both.length; i += RGBA) {
    const alpha = both[i + 3];
    const unpremultiply = alpha > 0 ? OPAQUE_ALPHA / alpha : 0;
    out.data[i] = both[i] * unpremultiply;
    out.data[i + 1] = both[i + 1] * unpremultiply;
    out.data[i + 2] = both[i + 2] * unpremultiply;
    out.data[i + 3] = alpha;
  }
  return out;
}

/**
 * @param {Object} options
 * @param {Float32Array} options.pixels premultiplied RGBA
 * @param {number} options.width
 * @param {number} options.height
 * @param {number} options.size new length of the resized axis
 * @param {boolean} options.isHorizontal
 * @returns {Float32Array}
 */
function resizePass({ pixels, width, height, size, isHorizontal }) {
  const length = isHorizontal ? width : height;
  const lines = isHorizontal ? height : width;
  const outWidth = isHorizontal ? size : width;
  const out = new Float32Array((isHorizontal ? size * height : width * size) * RGBA);
  const scale = length / size;
  const support = Math.max(1, scale);
  for (let o = 0; o < size; o++) {
    const center = (o + 0.5) * scale;
    const low = Math.max(0, Math.floor(center - support));
    const high = Math.min(length - 1, Math.ceil(center + support));
    const weights = [];
    let sum = 0;
    for (let k = low; k <= high; k++) {
      const weight = Math.max(0, 1 - Math.abs(k + 0.5 - center) / support);
      weights.push(weight);
      sum += weight;
    }
    for (let line = 0; line < lines; line++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = low; k <= high; k++) {
        const weight = weights[k - low] / sum;
        if (weight === 0) continue;
        const i = (isHorizontal ? line * width + k : k * width + line) * RGBA;
        r += pixels[i] * weight;
        g += pixels[i + 1] * weight;
        b += pixels[i + 2] * weight;
        a += pixels[i + 3] * weight;
      }
      const j = (isHorizontal ? line * outWidth + o : o * outWidth + line) * RGBA;
      out[j] = r;
      out[j + 1] = g;
      out[j + 2] = b;
      out[j + 3] = a;
    }
  }
  return out;
}

/**
 * Paints a brush stroke as round capsules between consecutive points.
 * @param {Object} options
 * @param {RgbaImage | SizeTex} options.image target size
 * @param {Stroke} options.stroke
 * @param {number} options.scaleX target pixels per stroke Tex
 * @param {number} options.scaleY
 * @param {number} options.growTex extra radius, in stroke Tex
 * @param {(pixelIndex: number) => void} options.paint
 */
function paintStroke({ image, stroke, scaleX, scaleY, growTex, paint }) {
  const radiusTex = stroke.widthTex / 2 + growTex;
  const radius = radiusTex * Math.min(scaleX, scaleY);
  const points = stroke.pointsTex;
  const count = points.length / 2;
  for (let s = 0; s < Math.max(1, count - 1); s++) {
    const ax = points[2 * s] * scaleX;
    const ay = points[2 * s + 1] * scaleY;
    const bx = count > 1 ? points[2 * s + 2] * scaleX : ax;
    const by = count > 1 ? points[2 * s + 3] * scaleY : ay;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - radius));
    const x1 = Math.min(image.width - 1, Math.ceil(Math.max(ax, bx) + radius));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - radius));
    const y1 = Math.min(image.height - 1, Math.ceil(Math.max(ay, by) + radius));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5 - ax;
        const py = y + 0.5 - ay;
        const t = lengthSq > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy) / lengthSq)) : 0;
        const ex = px - t * dx;
        const ey = py - t * dy;
        if (ex * ex + ey * ey <= radius * radius) paint(y * image.width + x);
      }
    }
  }
}

/**
 * Weight of the original pixel (1 = original, 0 = model) around painted strokes, or null.
 * @param {Stroke[]} strokes
 * @param {SizeTex} targetTex
 * @returns {Float32Array | null}
 */
function computeStrokeKeep(strokes, targetTex) {
  if (strokes.length === 0) return null;
  const covered = new Float32Array(targetTex.width * targetTex.height);
  for (const stroke of strokes) {
    paintStroke({ image: targetTex, stroke, scaleX: 1, scaleY: 1, growTex: STROKE_GROW_TEX,
      paint: (i) => { covered[i] = 1; } });
  }
  const blurred = boxBlur(boxBlur(covered, targetTex, true), targetTex, false);
  for (let i = 0; i < blurred.length; i++) blurred[i] = 1 - blurred[i];
  return blurred;
}

/**
 * One-axis moving average of radius STROKE_FEATHER_TEX.
 * @param {Float32Array} values
 * @param {SizeTex} sizeTex
 * @param {boolean} isHorizontal
 * @returns {Float32Array}
 */
function boxBlur(values, sizeTex, isHorizontal) {
  const out = new Float32Array(values.length);
  const length = isHorizontal ? sizeTex.width : sizeTex.height;
  const lines = isHorizontal ? sizeTex.height : sizeTex.width;
  const span = 2 * STROKE_FEATHER_TEX + 1;
  for (let line = 0; line < lines; line++) {
    /** @param {number} k */
    const index = (k) => (isHorizontal ? line * sizeTex.width + k : k * sizeTex.width + line);
    let sum = 0;
    for (let k = -STROKE_FEATHER_TEX; k <= STROKE_FEATHER_TEX; k++) {
      sum += values[index(Math.min(length - 1, Math.max(0, k)))];
    }
    for (let k = 0; k < length; k++) {
      out[index(k)] = sum / span;
      sum += values[index(Math.min(length - 1, k + STROKE_FEATHER_TEX + 1))]
        - values[index(Math.max(0, k - STROKE_FEATHER_TEX))];
    }
  }
  return out;
}

/**
 * Original weight near the expanded edges: smoothstep from 0 at the edge to 1 at bandTex.
 * @param {Object} options
 * @param {number} options.x source pixel
 * @param {number} options.y
 * @param {SizeTex} options.sourceTex
 * @param {MarginsTex} options.marginsTex
 * @param {number} options.bandTex
 * @returns {number}
 */
function computeBandWeight({ x, y, sourceTex, marginsTex, bandTex }) {
  if (bandTex <= 0) return 1;
  const distanceTex = Math.min(
    marginsTex.left > 0 ? x : Infinity,
    marginsTex.right > 0 ? sourceTex.width - 1 - x : Infinity,
    marginsTex.top > 0 ? y : Infinity,
    marginsTex.bottom > 0 ? sourceTex.height - 1 - y : Infinity);
  const t = Math.min(1, (distanceTex + 0.5) / bandTex);
  // smoothstep(t) = t² (3 − 2t)
  return t * t * (3 - 2 * t);
}

/**
 * Premultiplied mix of the original (weight keep) over the model pixel already in out.
 * @param {Object} options
 * @param {Uint8ClampedArray} options.out
 * @param {number} options.at
 * @param {Uint8ClampedArray} options.original
 * @param {number} options.originalAt
 * @param {number} options.keep
 */
function blendPixel({ out, at, original, originalAt, keep }) {
  if (keep >= 1) {
    out.set(original.subarray(originalAt, originalAt + RGBA), at);
    return;
  }
  if (keep <= 0) return;
  const alphaOriginal = original[originalAt + 3] * keep;
  const alphaModel = out[at + 3] * (1 - keep);
  const alpha = alphaOriginal + alphaModel;
  for (let c = 0; c < 3; c++) {
    // Fully transparent pixels still carry RGB (texture filtering reads it): mix it directly.
    out[at + c] = alpha > 0
      ? (original[originalAt + c] * alphaOriginal + out[at + c] * alphaModel) / alpha
      : original[originalAt + c] * keep + out[at + c] * (1 - keep);
  }
  out[at + 3] = alpha;
}

/**
 * Integer offset that best aligns the model output with the original (solid pixels only).
 * @param {RgbaImage} source
 * @param {RgbaImage} ai same size as the expanded image
 * @param {MarginsTex} marginsTex
 * @returns {{ dxTex: number, dyTex: number }}
 */
function estimateShift(source, ai, marginsTex) {
  let best = { dxTex: 0, dyTex: 0, error: Infinity };
  for (let dyTex = -REGISTER_RANGE_TEX; dyTex <= REGISTER_RANGE_TEX; dyTex++) {
    for (let dxTex = -REGISTER_RANGE_TEX; dxTex <= REGISTER_RANGE_TEX; dxTex++) {
      let error = 0;
      let count = 0;
      for (let y = REGISTER_INSET_TEX; y < source.height - REGISTER_INSET_TEX;
        y += REGISTER_STEP_TEX) {
        for (let x = REGISTER_INSET_TEX; x < source.width - REGISTER_INSET_TEX;
          x += REGISTER_STEP_TEX) {
          const i = (y * source.width + x) * RGBA;
          if (source.data[i + 3] < SOLID_ALPHA) continue;
          const j = ((y + marginsTex.top + dyTex) * ai.width + x + marginsTex.left + dxTex) * RGBA;
          error += Math.abs(source.data[i] - ai.data[j])
            + Math.abs(source.data[i + 1] - ai.data[j + 1])
            + Math.abs(source.data[i + 2] - ai.data[j + 2]);
          count++;
        }
      }
      if (count > 0 && error / count < best.error) best = { dxTex, dyTex, error: error / count };
    }
  }
  return { dxTex: best.dxTex, dyTex: best.dyTex };
}

/**
 * out(x, y) = image(x + dx, y + dy), edge-clamped.
 * @param {RgbaImage} image
 * @param {number} dxTex
 * @param {number} dyTex
 * @returns {RgbaImage}
 */
function shiftImage(image, dxTex, dyTex) {
  if (dxTex === 0 && dyTex === 0) return image;
  const out = createImage(image.width, image.height);
  for (let y = 0; y < image.height; y++) {
    const sy = Math.min(image.height - 1, Math.max(0, y + dyTex));
    for (let x = 0; x < image.width; x++) {
      const sx = Math.min(image.width - 1, Math.max(0, x + dxTex));
      const i = (sy * image.width + sx) * RGBA;
      out.data.set(image.data.subarray(i, i + RGBA), (y * image.width + x) * RGBA);
    }
  }
  return out;
}

/**
 * Luminance gain (keeps hue) measured where both images are solid, on a coarse grid, extended
 * to the strips from the nearest original point and faded out with the distance from it.
 * @param {RgbaImage} source
 * @param {RgbaImage} ai
 * @param {MarginsTex} marginsTex
 * @returns {RgbaImage}
 */
function matchTone(source, ai, marginsTex) {
  const gridWidth = Math.ceil(source.width / TONE_CELL_TEX);
  const gridHeight = Math.ceil(source.height / TONE_CELL_TEX);
  const lumaSource = new Float32Array(gridWidth * gridHeight);
  const lumaModel = new Float32Array(gridWidth * gridHeight);
  const counts = new Float32Array(gridWidth * gridHeight);
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const i = (y * source.width + x) * RGBA;
      const j = ((y + marginsTex.top) * ai.width + x + marginsTex.left) * RGBA;
      if (source.data[i + 3] < TONE_ALPHA || ai.data[j + 3] < TONE_ALPHA) continue;
      const cell = Math.floor(y / TONE_CELL_TEX) * gridWidth + Math.floor(x / TONE_CELL_TEX);
      lumaSource[cell] += LUMA_R * source.data[i] + LUMA_G * source.data[i + 1]
        + LUMA_B * source.data[i + 2];
      lumaModel[cell] += LUMA_R * ai.data[j] + LUMA_G * ai.data[j + 1] + LUMA_B * ai.data[j + 2];
      counts[cell]++;
    }
  }
  const gains = new Float32Array(gridWidth * gridHeight).fill(NaN);
  for (let cell = 0; cell < gains.length; cell++) {
    if (counts[cell] < TONE_MIN_SAMPLES) continue;
    const gain = (lumaSource[cell] + counts[cell]) / (lumaModel[cell] + counts[cell]);
    gains[cell] = Math.min(TONE_GAIN_MAX, Math.max(TONE_GAIN_MIN, gain));
  }
  if (!fillGrid(gains, gridWidth, gridHeight)) return ai;
  const out = { width: ai.width, height: ai.height, data: new Uint8ClampedArray(ai.data) };
  for (let y = 0; y < ai.height; y++) {
    const sy = Math.min(source.height - 1, Math.max(0, y - marginsTex.top));
    for (let x = 0; x < ai.width; x++) {
      const sx = Math.min(source.width - 1, Math.max(0, x - marginsTex.left));
      const distanceTex = Math.hypot(x - marginsTex.left - sx, y - marginsTex.top - sy);
      const fade = Math.max(0, 1 - distanceTex / TONE_FADE_TEX);
      if (fade === 0) continue;
      const gain = 1 + fade * (sampleGrid(gains, gridWidth, gridHeight, sx, sy) - 1);
      const i = (y * ai.width + x) * RGBA;
      out.data[i] = ai.data[i] * gain;
      out.data[i + 1] = ai.data[i + 1] * gain;
      out.data[i + 2] = ai.data[i + 2] * gain;
    }
  }
  return out;
}

/**
 * Fills NaN cells from valid neighbours; false when the grid has no valid cell.
 * @param {Float32Array} grid
 * @param {number} width
 * @param {number} height
 * @returns {boolean}
 */
function fillGrid(grid, width, height) {
  if (grid.every((value) => Number.isNaN(value))) return false;
  while (grid.some((value) => Number.isNaN(value))) {
    const next = new Float32Array(grid);
    for (let cell = 0; cell < grid.length; cell++) {
      if (!Number.isNaN(grid[cell])) continue;
      const x = cell % width;
      const y = Math.floor(cell / width);
      let sum = 0;
      let count = 0;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const value = grid[ny * width + nx];
        if (Number.isNaN(value)) continue;
        sum += value;
        count++;
      }
      if (count > 0) next[cell] = sum / count;
    }
    grid.set(next);
  }
  return true;
}

/**
 * Bilinear lookup of a grid sampled at cell centers.
 * @param {Float32Array} grid
 * @param {number} width
 * @param {number} height
 * @param {number} xTex
 * @param {number} yTex
 * @returns {number}
 */
function sampleGrid(grid, width, height, xTex, yTex) {
  const fx = Math.min(width - 1, Math.max(0, (xTex + 0.5) / TONE_CELL_TEX - 0.5));
  const fy = Math.min(height - 1, Math.max(0, (yTex + 0.5) / TONE_CELL_TEX - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const ax = fx - x0;
  const ay = fy - y0;
  const top = grid[y0 * width + x0] * (1 - ax) + grid[y0 * width + x1] * ax;
  const bottom = grid[y1 * width + x0] * (1 - ax) + grid[y1 * width + x1] * ax;
  return top * (1 - ay) + bottom * ay;
}

/**
 * Model failures worth a look before applying: empty outer edges and leftover marker color.
 * @param {RgbaImage} source
 * @param {RgbaImage} image
 * @param {MarginsTex} marginsTex
 * @returns {string[]}
 */
function collectWarnings(source, image, marginsTex) {
  /** @type {string[]} */
  const warnings = [];
  /** @param {RgbaImage} img @param {number} x @param {number} y */
  const isSolid = (img, x, y) => img.data[(y * img.width + x) * RGBA + 3] > OPAQUE_ALPHA / 2;
  /** @type {Array<[Side, number, (k: number) => [number, number], (k: number) => [number, number],
   *   number]>} */
  const edges = [
    ['left', source.height, (k) => [0, k], (k) => [0, k + marginsTex.top], marginsTex.left],
    ['right', source.height, (k) => [source.width - 1, k],
      (k) => [image.width - 1, k + marginsTex.top], marginsTex.right],
    ['top', source.width, (k) => [k, 0], (k) => [k + marginsTex.left, 0], marginsTex.top],
    ['bottom', source.width, (k) => [k, source.height - 1],
      (k) => [k + marginsTex.left, image.height - 1], marginsTex.bottom],
  ];
  for (const [side, count, sourceAt, outerAt, margin] of edges) {
    if (margin === 0) continue;
    let sourceSolid = 0;
    let outerSolid = 0;
    for (let k = 0; k < count; k++) {
      if (isSolid(source, ...sourceAt(k))) sourceSolid++;
      if (isSolid(image, ...outerAt(k))) outerSolid++;
    }
    if (sourceSolid > count * EMPTY_EDGE_RATIO && outerSolid < count * EMPTY_EDGE_RATIO) {
      warnings.push(`Atenção: a borda de ${SIDE_LABELS[side]} ficou vazia; gere de novo.`);
    }
  }
  let markerCount = 0;
  let stripCount = 0;
  for (let y = 0; y < image.height; y++) {
    const isRowInside = y >= marginsTex.top && y < marginsTex.top + source.height;
    for (let x = 0; x < image.width; x++) {
      if (isRowInside && x >= marginsTex.left && x < marginsTex.left + source.width) continue;
      stripCount++;
      const i = (y * image.width + x) * RGBA;
      if (image.data[i + 3] > OPAQUE_ALPHA / 2
        && Math.abs(image.data[i] - MARKER_RGB[0]) <= MARKER_TOLERANCE
        && Math.abs(image.data[i + 1] - MARKER_RGB[1]) <= MARKER_TOLERANCE
        && Math.abs(image.data[i + 2] - MARKER_RGB[2]) <= MARKER_TOLERANCE) {
        markerCount++;
      }
    }
  }
  if (stripCount > 0 && markerCount > stripCount * MARKER_WARN_RATIO) {
    warnings.push('Atenção: sobrou cor de marcação (magenta) nas margens; gere de novo.');
  }
  return warnings;
}

/**
 * @param {Uint8Array<ArrayBuffer>} raw inflated scanlines (filter byte + row)
 * @param {number} width
 * @param {number} height
 * @param {number} channels bytes per pixel
 * @returns {Uint8Array<ArrayBuffer>}
 */
function unfilterRows(raw, width, height, channels) {
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error('Dados do PNG incompletos.');
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const from = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[row + x - channels] : 0;
      const up = y > 0 ? pixels[row - stride + x] : 0;
      const upLeft = x >= channels && y > 0 ? pixels[row - stride + x - channels] : 0;
      let value = raw[from + x];
      if (filter === FILTER_SUB) value += left;
      else if (filter === FILTER_UP) value += up;
      else if (filter === FILTER_AVERAGE) value += (left + up) >> 1;
      else if (filter === FILTER_PAETH) value += paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error('PNG com filtro inválido.');
      pixels[row + x] = value & OPAQUE_ALPHA;
    }
  }
  return pixels;
}

/**
 * @param {Object} options
 * @param {Uint8Array<ArrayBuffer>} options.pixels
 * @param {number} options.width
 * @param {number} options.height
 * @param {number} options.colorType
 * @param {Uint8Array<ArrayBuffer> | null} options.palette
 * @param {Uint8Array<ArrayBuffer> | null} options.transparency
 * @returns {RgbaImage}
 */
function expandToRgba({ pixels, width, height, colorType, palette, transparency }) {
  const image = createImage(width, height);
  const out = image.data;
  // tRNS for gray/RGB holds one 16-bit key per channel; matching pixels are transparent.
  /** @param {number} channel */
  const key16 = (channel) => {
    const offset = channel * TRNS_SAMPLE_BYTES;
    return transparency && transparency.length >= offset + TRNS_SAMPLE_BYTES
      ? (transparency[offset] << BYTE_BITS) | transparency[offset + 1] : -1;
  };
  for (let p = 0; p < width * height; p++) {
    const o = p * RGBA;
    if (colorType === COLOR_RGBA) {
      out.set(pixels.subarray(o, o + RGBA), o);
    } else if (colorType === COLOR_RGB) {
      const s = p * 3;
      out[o] = pixels[s];
      out[o + 1] = pixels[s + 1];
      out[o + 2] = pixels[s + 2];
      const isKey = pixels[s] === key16(0) && pixels[s + 1] === key16(1)
        && pixels[s + 2] === key16(2);
      out[o + 3] = isKey ? 0 : OPAQUE_ALPHA;
    } else if (colorType === COLOR_GRAY_ALPHA) {
      out[o] = out[o + 1] = out[o + 2] = pixels[p * 2];
      out[o + 3] = pixels[p * 2 + 1];
    } else if (colorType === COLOR_GRAY) {
      out[o] = out[o + 1] = out[o + 2] = pixels[p];
      out[o + 3] = pixels[p] === key16(0) ? 0 : OPAQUE_ALPHA;
    } else if (palette) {
      const index = pixels[p];
      out[o] = palette[index * 3];
      out[o + 1] = palette[index * 3 + 1];
      out[o + 2] = palette[index * 3 + 2];
      out[o + 3] = transparency && index < transparency.length ? transparency[index] : OPAQUE_ALPHA;
    }
  }
  return image;
}

/**
 * Writes one filtered row into target; returns the sum of |signed byte| used to pick a filter.
 * @param {Uint8Array} row
 * @param {Uint8Array | null} previous
 * @param {number} filter
 * @param {Uint8Array} target
 * @returns {number}
 */
function filterRow(row, previous, filter, target) {
  let cost = 0;
  for (let x = 0; x < row.length; x++) {
    const left = x >= RGBA ? row[x - RGBA] : 0;
    const up = previous ? previous[x] : 0;
    const upLeft = previous && x >= RGBA ? previous[x - RGBA] : 0;
    let predictor = 0;
    if (filter === FILTER_SUB) predictor = left;
    else if (filter === FILTER_UP) predictor = up;
    else if (filter === FILTER_AVERAGE) predictor = (left + up) >> 1;
    else if (filter === FILTER_PAETH) predictor = paeth(left, up, upLeft);
    const value = (row[x] - predictor) & OPAQUE_ALPHA;
    target[x] = value;
    cost += value < BYTE_HALF ? value : BYTE_RANGE - value;
  }
  return cost;
}

/**
 * @param {number} left
 * @param {number} up
 * @param {number} upLeft
 * @returns {number}
 */
function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceUpLeft = Math.abs(estimate - upLeft);
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) return left;
  return distanceUp <= distanceUpLeft ? up : upLeft;
}

/**
 * @param {string} type
 * @param {Uint8Array<ArrayBuffer>} body
 * @returns {Uint8Array<ArrayBuffer>}
 */
function createChunk(type, body) {
  const chunk = new Uint8Array(PNG_CHUNK_OVERHEAD + body.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < PNG_TYPE_OFFSET; i++) chunk[PNG_TYPE_OFFSET + i] = type.charCodeAt(i);
  chunk.set(body, PNG_DATA_OFFSET);
  view.setUint32(PNG_DATA_OFFSET + body.length,
    crc32(chunk.subarray(PNG_TYPE_OFFSET, PNG_DATA_OFFSET + body.length)));
  return chunk;
}

/** @returns {Uint32Array} */
function computeCrcTable() {
  const table = new Uint32Array(BYTE_RANGE);
  for (let n = 0; n < table.length; n++) {
    let c = n;
    for (let k = 0; k < BYTE_BITS; k++) c = c & 1 ? CRC_POLY ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

/**
 * @param {Uint8Array} bytes
 * @returns {number}
 */
function crc32(bytes) {
  let c = -1;
  for (const value of bytes) c = CRC_TABLE[(c ^ value) & OPAQUE_ALPHA] ^ (c >>> BYTE_BITS);
  return (c ^ -1) >>> 0;
}

/**
 * @param {Uint8Array<ArrayBuffer>[]} parts
 * @returns {Uint8Array<ArrayBuffer>}
 */
function concatBytes(parts) {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * zlib (de)compression through the native streams.
 * @param {Uint8Array<ArrayBuffer>} bytes
 * @param {CompressionStream | DecompressionStream} transform
 * @param {AbortSignal} signal
 * @returns {Promise<Uint8Array<ArrayBuffer>>}
 */
async function transformBytes(bytes, transform, signal) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  signal.throwIfAborted();
  return out;
}

/**
 * @param {string} encoded
 * @returns {Uint8Array<ArrayBuffer>}
 */
function base64ToBytes(encoded) {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * @param {string} color '#rrggbb'
 * @returns {[number, number, number]}
 */
function parseHexColor(color) {
  const value = Number.parseInt(color.slice(1), 16);
  return [(value >> (2 * BYTE_BITS)) & OPAQUE_ALPHA, (value >> BYTE_BITS) & OPAQUE_ALPHA,
    value & OPAQUE_ALPHA];
}

/**
 * Canvas decode is exact only when every pixel is opaque (alpha premultiplication).
 * @param {Blob} blob
 * @param {AbortSignal} signal
 * @returns {Promise<RgbaImage>}
 */
async function decodeOpaqueImage(blob, signal) {
  const bitmap = await createImageBitmap(blob);
  try {
    signal.throwIfAborted();
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D indisponível.');
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const image = { width: pixels.width, height: pixels.height, data: pixels.data };
    if (!isOpaqueImage(image)) {
      throw new Error('Imagem com transparência: use PNG para preservar o canal alfa.');
    }
    return image;
  } finally {
    bitmap.close();
  }
}

/**
 * @param {CanvasRenderingContext2D} context
 * @param {{ xCss: number, yCss: number, widthCss: number, heightCss: number }} rect
 */
function drawChecker(context, rect) {
  context.save();
  context.beginPath();
  context.rect(rect.xCss, rect.yCss, rect.widthCss, rect.heightCss);
  context.clip();
  context.fillStyle = '#2a2f3a';
  context.fillRect(rect.xCss, rect.yCss, rect.widthCss, rect.heightCss);
  context.fillStyle = '#1c2029';
  for (let yCss = 0; yCss < rect.heightCss; yCss += CHECKER_CSS) {
    for (let xCss = (yCss / CHECKER_CSS) % 2 === 0 ? 0 : CHECKER_CSS; xCss < rect.widthCss;
      xCss += 2 * CHECKER_CSS) {
      context.fillRect(rect.xCss + xCss, rect.yCss + yCss, CHECKER_CSS, CHECKER_CSS);
    }
  }
  context.restore();
}

/**
 * Lets the browser paint the status text before a long synchronous step.
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
async function yieldToBrowser(signal) {
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  signal.throwIfAborted();
}

/**
 * @param {string} name
 * @returns {string}
 */
function resultName(name) {
  return `${name.replace(/\.[^.]+$/, '')}-expandida.png`;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
