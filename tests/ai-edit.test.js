// Tests for the demo AI expansion core: exact PNG codec, sizing, prompt, markup and recomposition.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import {
  AI_MODEL, buildPrompt, clampTargetSize, composeInput, composeMarkup, composeResult,
  computeApiSizeTex, computeMarginsTex, decodePng, encodePng, isOpaqueImage, requestAiExpansion,
  resolveLinkedSize,
} from '../demo/ai-edit.js';

/** @typedef {import('../demo/ai-edit.js').RgbaImage} RgbaImage */

const signal = new AbortController().signal;

/**
 * Deterministic image with every alpha level, including semi-transparent pixels.
 * @param {number} width
 * @param {number} height
 * @param {number} seed
 * @returns {RgbaImage}
 */
function createPattern(width, height, seed) {
  const data = new Uint8ClampedArray(width * height * 4);
  let value = seed;
  for (let i = 0; i < data.length; i++) {
    value = (value * 1103515245 + 12345) >>> 0;
    data[i] = value >>> 24;
  }
  return { width, height, data };
}

/**
 * Builds a PNG with node:zlib for color types the demo encoder never writes.
 * @param {{ width: number, height: number, colorType: number, rows: number[][],
 *   chunks?: Array<[string, number[]]> }} options
 * @returns {Uint8Array<ArrayBuffer>}
 */
function buildPng({ width, height, colorType, rows, chunks = [] }) {
  /** @param {string} type @param {Uint8Array} body */
  const chunk = (type, body) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'ascii');
    Buffer.from(body).copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const raw = Buffer.from(rows.flatMap((row) => [0, ...row]));
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    ...chunks.map(([type, body]) => chunk(type, Uint8Array.from(body))),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]);
  return new Uint8Array(png);
}

/**
 * @param {RgbaImage} image
 * @param {number} x
 * @param {number} y
 */
function pixel(image, x, y) {
  const i = (y * image.width + x) * 4;
  return [...image.data.subarray(i, i + 4)];
}

test('PNG round trip is exact for every alpha level and keeps color chunks', async () => {
  const image = createPattern(37, 23, 7);
  const srgb = (await decodePng(buildPng({ width: 1, height: 1, colorType: 6,
    rows: [[1, 2, 3, 4]], chunks: [['sRGB', [0]]] }), signal)).colorChunks;
  assert.equal(srgb.length, 1);
  const decoded = await decodePng(await encodePng(image, srgb, signal), signal);
  assert.deepEqual(decoded.image, image);
  assert.deepEqual(decoded.colorChunks, srgb);
});

test('decodes a real layer exactly and re-encodes it without changes', async () => {
  const bytes = new Uint8Array(readFileSync(new URL('../demo/assets/samurai4.png',
    import.meta.url)));
  const { image } = await decodePng(bytes, signal);
  assert.deepEqual([image.width, image.height], [1774, 887]);
  let semiTransparent = 0;
  for (let i = 3; i < image.data.length; i += 4) {
    if (image.data[i] > 0 && image.data[i] < 255) semiTransparent++;
  }
  assert.ok(semiTransparent > 100000, 'layer must exercise semi-transparent pixels');
  assert.equal(isOpaqueImage(image), false);
  const again = await decodePng(await encodePng(image, [], signal), signal);
  assert.deepEqual(again.image.data, image.data);
});

test('decodes RGB, gray and palette PNGs, including tRNS transparency', async () => {
  const rgb = await decodePng(buildPng({ width: 2, height: 1, colorType: 2,
    rows: [[10, 20, 30, 1, 2, 3]], chunks: [['tRNS', [0, 1, 0, 2, 0, 3]]] }), signal);
  assert.deepEqual(pixel(rgb.image, 0, 0), [10, 20, 30, 255]);
  assert.deepEqual(pixel(rgb.image, 1, 0), [1, 2, 3, 0]);
  const gray = await decodePng(buildPng({ width: 2, height: 1, colorType: 0,
    rows: [[90, 7]] }), signal);
  assert.deepEqual(pixel(gray.image, 0, 0), [90, 90, 90, 255]);
  const palette = await decodePng(buildPng({ width: 2, height: 1, colorType: 3, rows: [[1, 0]],
    chunks: [['PLTE', [5, 6, 7, 50, 60, 70]], ['tRNS', [128]]] }), signal);
  assert.deepEqual(pixel(palette.image, 0, 0), [50, 60, 70, 255]);
  assert.deepEqual(pixel(palette.image, 1, 0), [5, 6, 7, 128]);
});

test('rejects PNGs it cannot reproduce exactly', async () => {
  const sixteenBit = buildPng({ width: 1, height: 1, colorType: 6, rows: [[0, 0, 0, 0]] });
  sixteenBit[24] = 16;
  await assert.rejects(decodePng(sixteenBit, signal), /8 bits/);
  await assert.rejects(decodePng(new Uint8Array([1, 2, 3]), signal), /PNG inválido/);
});

test('margins follow the active sides; an axis without sides grows evenly', () => {
  const sourceTex = { width: 100, height: 50 };
  const targetTex = { width: 141, height: 70 };
  assert.deepEqual(computeMarginsTex(sourceTex, targetTex, new Set(['left', 'bottom'])),
    { left: 41, top: 0, right: 0, bottom: 20 });
  assert.deepEqual(computeMarginsTex(sourceTex, targetTex, new Set(['right'])),
    { left: 0, top: 10, right: 41, bottom: 10 });
  assert.deepEqual(computeMarginsTex(sourceTex, targetTex, new Set(['left', 'right'])),
    { left: 20, top: 10, right: 21, bottom: 10 });
});

test('size lock keeps the aspect ratio and the target never crops the original', () => {
  const sourceTex = { width: 1774, height: 887 };
  assert.deepEqual(resolveLinkedSize(sourceTex, 'width', 2160), { width: 2160, height: 1080 });
  assert.deepEqual(resolveLinkedSize(sourceTex, 'height', 1120), { width: 2240, height: 1120 });
  assert.deepEqual(clampTargetSize(sourceTex, { width: 1000, height: Number.NaN }),
    { width: 1774, height: 887 });
  assert.deepEqual(clampTargetSize(sourceTex, { width: 99999, height: 900.4 }),
    { width: 8192, height: 900 });
});

test('model size respects multiples of 16, pixel limits and the 3:1 ratio', () => {
  assert.deepEqual(computeApiSizeTex({ width: 2160, height: 1120 }), { width: 2160, height: 1120 });
  const large = computeApiSizeTex({ width: 3474, height: 2087 });
  assert.equal(large.width % 16, 0);
  assert.equal(large.height % 16, 0);
  assert.ok(large.width * large.height <= 2560 * 1440 * 1.01);
  assert.ok(Math.abs(large.width / large.height - 3474 / 2087) < 0.02);
  const small = computeApiSizeTex({ width: 600, height: 400 });
  assert.ok(small.width * small.height >= 655360);
  assert.throws(() => computeApiSizeTex({ width: 4000, height: 1000 }), /3:1/);
});

test('prompt states directions in model pixels, alpha rules and the color legend', () => {
  const prompt = buildPrompt({ marginsTex: { left: 100, top: 0, right: 0, bottom: 60 },
    targetTex: { width: 1000, height: 600 }, apiSizeTex: { width: 2000, height: 1200 },
    isOpaque: false, userText: '  verde = árvores ', colorNames: ['GREEN'] });
  assert.match(prompt, /200 px on the LEFT, 120 px on the BOTTOM/);
  assert.match(prompt, /Expansion directions: LEFT \+ BOTTOM/);
  assert.match(prompt, /must stay fully transparent/);
  assert.match(prompt, /\(GREEN\)/);
  assert.match(prompt, /User request: verde = árvores$/);
  const opaque = buildPrompt({ marginsTex: { left: 0, top: 10, right: 0, bottom: 0 },
    targetTex: { width: 100, height: 100 }, apiSizeTex: { width: 100, height: 100 },
    isOpaque: true, userText: '', colorNames: [] });
  assert.match(opaque, /fully opaque/);
  assert.doesNotMatch(opaque, /Colored annotation/);
  assert.match(opaque, /User request: Extend the scene naturally/);
});

test('input places the original in the expanded canvas; markup marks strips and strokes', () => {
  const source = createPattern(20, 10, 3);
  const marginsTex = { left: 4, top: 0, right: 0, bottom: 6 };
  const apiSizeTex = { width: 24, height: 16 };
  const input = composeInput(source, marginsTex, apiSizeTex);
  assert.deepEqual(pixel(input, 4, 0), pixel(source, 0, 0));
  assert.deepEqual(pixel(input, 0, 0), [0, 0, 0, 0]);
  const markup = composeMarkup({ sourceTex: source, marginsTex, apiSizeTex,
    strokes: [{ color: '#22c55e', widthTex: 2, pointsTex: [10, 5] }] });
  assert.deepEqual(pixel(markup, 0, 0), [255, 0, 255, 255]);
  assert.deepEqual(pixel(markup, 10, 14), [255, 0, 255, 255]);
  assert.deepEqual(pixel(markup, 20, 2), [0, 0, 0, 0]);
  assert.deepEqual(pixel(markup, 10, 5), [34, 197, 94, 255]);
});

test('result keeps the original exactly outside the band and painted areas', () => {
  const source = createPattern(60, 40, 11);
  const marginsTex = { left: 10, top: 0, right: 0, bottom: 8 };
  const aiImage = createPattern(70, 48, 99);
  for (let i = 3; i < aiImage.data.length; i += 4) aiImage.data[i] = 255;
  const strict = composeResult({ source, aiImage, marginsTex, strokes: [], bandTex: 0 });
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 60; x++) {
      assert.deepEqual(pixel(strict.image, x + 10, y), pixel(source, x, y));
    }
  }
  assert.equal(pixel(strict.image, 0, 0)[3], 255, 'strips come from the model');
  const banded = composeResult({ source, aiImage, marginsTex, bandTex: 6,
    strokes: [{ color: '#ef4444', widthTex: 2, pointsTex: [40, 15] }] });
  let changedInBand = 0;
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 60; x++) {
      const isInBand = x < 6 || y >= 40 - 6;
      const isNearStroke = Math.hypot(x + 10 - 40, y - 15) < 1 + 24 + 2 * 16 + 1;
      const same = pixel(banded.image, x + 10, y).every((v, c) => v === pixel(source, x, y)[c]);
      if (!isInBand && !isNearStroke) assert.ok(same, `pixel ${x},${y} must stay original`);
      if (isInBand && !same) changedInBand++;
    }
  }
  assert.ok(changedInBand > 0, 'the band blends near the expanded edges');
  assert.notDeepEqual(pixel(banded.image, 40, 15), pixel(source, 30, 15),
    'painted areas take the model pixels');
});

test('a perfect model leaves the original untouched even with a transition band', () => {
  const source = createPattern(48, 32, 5);
  const marginsTex = { left: 0, top: 6, right: 6, bottom: 0 };
  const aiImage = composeInput(source, marginsTex, { width: 54, height: 38 });
  const { image, warnings } = composeResult({ source, aiImage, marginsTex, strokes: [],
    bandTex: 32 });
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 48; x++) assert.deepEqual(pixel(image, x, y + 6), pixel(source, x, y));
  }
  assert.ok(Array.isArray(warnings));
});

test('API request sends the image, markup and options and returns the PNG bytes', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  /** @type {{ url: string, init: RequestInit } | null} */
  let call = null;
  const png = Uint8Array.from([137, 80, 78, 71]);
  globalThis.fetch = async (url, init) => {
    call = { url: String(url), init: init ?? {} };
    const encoded = Buffer.from(png).toString('base64');
    return new Response(JSON.stringify({ data: [{ b64_json: encoded }] }), { status: 200 });
  };
  const options = { apiKey: 'test-key', prompt: 'p', inputPng: new Uint8Array([1]),
    markupPng: new Uint8Array([2]), apiSizeTex: { width: 2160, height: 1120 }, isOpaque: false };
  assert.deepEqual(await requestAiExpansion(options, signal), png);
  const sent = /** @type {{ url: string, init: RequestInit }} */ (/** @type {unknown} */ (call));
  assert.equal(sent.url, '/openai/v1/images/edits');
  assert.deepEqual(sent.init.headers, { Authorization: 'Bearer test-key' });
  const form = /** @type {FormData} */ (sent.init.body);
  assert.equal(form.get('model'), AI_MODEL);
  assert.equal(form.get('size'), '2160x1120');
  assert.equal(form.get('background'), 'transparent');
  assert.ok(form.get('image') instanceof Blob);
  assert.ok(form.get('markup') instanceof Blob);
  assert.equal(form.get('mask'), null);

  await requestAiExpansion({ ...options, apiKey: ' test​-key\n' }, signal);
  const cleaned = /** @type {{ init: RequestInit }} */ (/** @type {unknown} */ (call));
  assert.deepEqual(cleaned.init.headers, { Authorization: 'Bearer test-key' },
    'invisible characters from a paste are removed');

  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(requestAiExpansion(options, signal),
    /Sem resposta após \d+ s \(Failed to fetch\)/);

  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'bad key' } }),
    { status: 401 });
  await assert.rejects(requestAiExpansion(options, signal), /bad key \(HTTP 401\)/);
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  await assert.rejects(requestAiExpansion(options, controller.signal), { name: 'AbortError' });
});
