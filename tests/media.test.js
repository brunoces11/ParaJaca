// Import validation protects working scenes from invalid files before a renderer is created.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { inspectLottie, unpackLottie } from '../src/core/sources/lottie-source.js';
import { inspectMediaFile } from '../src/core/sources/media-source.js';

const signal = () => new AbortController().signal;
const animation = () => ({ v: '5.13.0', w: 640, h: 320, fr: 30, ip: 0, op: 60, layers: [] });
/** @param {unknown} value */
const blob = (value) => new Blob([JSON.stringify(value)], { type: 'application/json' });

test('Lottie JSON preserves native dimensions and timing and rejects scene configuration JSON', async () => {
  const result = await inspectLottie(blob(animation()), false, signal());
  assert.equal(result.width, 640);
  assert.equal(result.height, 320);
  assert.equal(result.fps, 30);
  await assert.rejects(inspectLottie(blob({ format: 'parajaca-config', version: 1 }), false, signal()), /Invalid Lottie/);
  const file = new File([JSON.stringify(animation())], 'animation.json', { type: '' });
  assert.deepEqual(await inspectMediaFile(file, signal()), { type: 'lottie', width: 640, height: 320 });
});

test('Lottie rejects executable expressions, unsafe properties and missing external images', async () => {
  await assert.rejects(inspectLottie(blob({ ...animation(), layers: [{ ks: { p: { x: 'alert(1)' } } }] }), false, signal()), /expressions/);
  await assert.rejects(inspectLottie(new Blob(['{"w":1,"__proto__":{}}']), false, signal()), /Unsafe JSON/);
  await assert.rejects(inspectLottie(blob({ ...animation(), assets: [{ p: 'https://example.invalid/image.png' }] }), false, signal()), /Missing embedded image/);
});

test('dotLottie v1 and v2 honor the selected animation and resolve packaged images', async () => {
  for (const version of ['1', '2']) {
    const directory = version === '1' ? 'animations' : 'a';
    const imageDirectory = version === '1' ? 'images' : 'i';
    const first = animation();
    const selected = { ...animation(), w: 3000, assets: [{ id: 'image', u: '', p: `${imageDirectory}/embedded.png` }] };
    const manifest = { version, animations: [{ id: 'first' }, { id: 'selected' }],
      ...(version === '1' ? { activeAnimationId: 'selected' } : { initial: { animation: 'selected' } }) };
    const bytes = zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)),
      [`${directory}/first.json`]: strToU8(JSON.stringify(first)),
      [`${directory}/selected.json`]: strToU8(JSON.stringify(selected)),
      [`${imageDirectory}/embedded.png`]: new Uint8Array([1, 2, 3]),
    });
    const result = await inspectLottie(new Blob([bytes]), true, signal());
    assert.equal(result.width, 3000);
    assert.match(JSON.stringify(result.data.assets), /data:image\/png;base64,AQID/);
  }
});

test('dotLottie reports unsupported initial state machines, missing selections and unsafe paths', async () => {
  const make = (/** @type {object} */ manifest) => new Blob([zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)) })]);
  await assert.rejects(inspectLottie(make({ version: '2', animations: [{ id: 'a' }], initial: { stateMachine: 'machine' } }), true, signal()), /state machines/);
  await assert.rejects(inspectLottie(make({ version: '2', animations: [{ id: 'a' }], initial: { animation: 'missing' } }), true, signal()), /not listed/);
  const unsafe = zipSync({ 'manifest.json': strToU8('{}'), '../outside.json': strToU8('{}') });
  await assert.rejects(unpackLottie(unsafe, signal()), /paths/);
});

test('dotLottie limits entries and cancellation before decompression', async () => {
  /** @type {Record<string, Uint8Array>} */
  const files = { 'manifest.json': strToU8('{}') };
  for (let i = 0; i < 64; i++) files[`a/${i}.json`] = strToU8('{}');
  await assert.rejects(unpackLottie(zipSync(files), signal()), /too many entries/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(unpackLottie(new Uint8Array(), controller.signal), { name: 'AbortError' });
});
