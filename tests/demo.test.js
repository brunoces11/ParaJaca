// Integration test for the demo's configuration controls with a simulated DOM and player.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolveObjectURL } from 'node:buffer';

/** @typedef {import('../src/core/scene/model.js').Scene} Scene */
/** @typedef {import('../src/core/player.js').PlayerCommand} PlayerCommand */

/** @param {string} [tag] */
function createElement(tag = 'div') {
  const classes = new Set();
  const element = Object.assign(new EventTarget(), {
    tag, value: '', textContent: '', className: '', href: '', download: '', src: '', alt: '',
    type: '', min: '', max: '', step: '', disabled: false, files: /** @type {File[]} */ ([]),
    style: { display: '' }, children: /** @type {unknown[]} */ ([]),
    classList: {
      /** @param {string} name */
      add(name) { classes.add(name); },
      /** @param {string} name */
      remove(name) { classes.delete(name); },
      /** @param {string} name @param {boolean} [force] */
      toggle(name, force) {
        const active = force ?? !classes.has(name);
        if (active) classes.add(name); else classes.delete(name);
        return active;
      },
      /** @param {string} name */
      contains(name) { return classes.has(name); },
    },
    /** @param {...unknown} nodes */
    append(...nodes) { element.children.push(...nodes); },
    /** @param {unknown} node */
    appendChild(node) { element.children.push(node); return node; },
    replaceChildren() { element.children.length = 0; },
    querySelectorAll() { return []; },
    /** @param {string} _name @param {string} _value */
    setAttribute(_name, _value) {},
    click() { element.dispatchEvent(new Event('click')); },
    remove() {},
    showModal() {}, close() {},
  });
  return element;
}

/** @param {ReturnType<typeof createElement>} parent @param {number} index */
function child(parent, index) {
  return /** @type {ReturnType<typeof createElement>} */ (parent.children[index]);
}

/** @param {ReturnType<typeof createElement>} element @param {string} value */
function input(element, value) {
  element.value = value;
  element.dispatchEvent(new Event('input'));
}

/** @param {() => boolean} condition */
async function waitFor(condition) {
  for (let i = 0; i < 50 && !condition(); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(condition(), 'asynchronous UI action did not complete');
}

test('configuration restores saved assets and accepts older configuration files', async (t) => {
  const html = readFileSync(new URL('../demo/index.html', import.meta.url), 'utf8');
  const controls = new Map([...html.matchAll(/\bid="([^"]+)"/g)]
    .map((match) => [match[1], createElement()]));
  /** @param {string} id */
  function control(id) {
    const element = controls.get(id);
    assert.ok(element, `missing element ${id}`);
    return element;
  }
  control('focus-slider').value = '50';
  control('dof-slider').value = '100';
  control('intensity-x-slider').value = '400';
  control('intensity-y-slider').value = '100';
  control('quality-select').value = 'high';
  let scene = /** @type {Scene} */ (JSON.parse(readFileSync(
    new URL('../demo/scene.json', import.meta.url), 'utf8',
  )));
  const originalAssets = structuredClone(scene.assets);
  /** @type {Map<string, Set<(payload: { d?: number, message?: string }) => void>>} */
  const events = new Map();
  /** @param {string} event @param {{ d?: number, message?: string }} payload */
  function emit(event, payload) { events.get(event)?.forEach((handler) => handler(payload)); }
  let focus = 50;
  let depthOfField = 1;
  let focusTracking = 'manual';
  let intensityX = 0;
  let intensityY = 0;
  let quality = 'high';
  let failLayer = '';
  const fakePlayer = {
    /** @param {string | Scene} value */
    load(value) {
      if (typeof value === 'object') scene = structuredClone(value);
      queueMicrotask(() => emit('ready', {})); return Promise.resolve();
    },
    getScene() { return structuredClone(scene); },
    /** @param {number} value */
    setFocus(value) { focus = value; emit('focus-change', { d: value }); },
    /** @param {number} value */
    setDepthOfFieldStrength(value) { depthOfField = value; },
    /** @param {string} value */
    setFocusTracking(value) { focusTracking = value; },
    /** @param {number} x @param {number} y */
    setIntensity(x, y) { intensityX = x; intensityY = y; },
    /** @param {string} value */
    setQuality(value) { quality = value; },
    /** @param {string} event @param {(payload: { d?: number, message?: string }) => void} handler */
    on(event, handler) {
      if (!events.has(event)) events.set(event, new Set());
      events.get(event)?.add(handler);
      return () => { events.get(event)?.delete(handler); };
    },
    /** @param {PlayerCommand} command */
    async edit(command) {
      if (command.layerId === failLayer) {
        failLayer = '';
        emit('error', { message: 'Simulated edit failure' });
        return;
      }
      const layer = scene.variants[0].layers.find((item) => item.id === command.layerId);
      assert.ok(layer);
      if (command.changesLayer?.placement) {
        assert.equal(command.changesLayer.placement.width, layer.placement.width);
        assert.equal(command.changesLayer.placement.height, layer.placement.height);
        layer.placement = { ...command.changesLayer.placement };
      }
      if (command.changesLayer?.scalePercent !== undefined) {
        const asset = scene.assets.find((item) => item.id === layer.assetId);
        assert.ok(asset);
        layer.scalePercent = command.changesLayer.scalePercent;
        layer.placement.width = asset.width * layer.scalePercent / 100;
        layer.placement.height = asset.height * layer.scalePercent / 100;
      }
      if (command.changesLayer?.parallaxPercent !== undefined) {
        layer.parallaxPercent = command.changesLayer.parallaxPercent;
      }
    },
  };
  /** @type {{ href: string, name: string } | null} */
  let download = null;
  const body = createElement();
  const documentTarget = Object.assign(new EventTarget(), {
    baseURI: 'http://localhost/demo/', body,
    /** @param {string} id */
    getElementById(id) { return control(id); },
    /** @param {string} tag */
    createElement(tag) {
      const element = createElement(tag);
      if (tag === 'a') {
        element.click = () => { download = { href: element.href, name: element.download }; };
      }
      return element;
    },
  });
  /** @type {string | null} */
  let chosenName = 'Minha cena';
  const testWindow = Object.assign(new EventTarget(), { prompt: () => chosenName });
  const globals = {
    window: testWindow, document: documentTarget,
    setInterval() { return 0; },
    __parajacaDemoTestPlayer: fakePlayer,
    fetch: async () => ({ ok: true, status: 200 }),
  };
  const originals = Object.keys(globals).map((name) => ({
    name, descriptor: Object.getOwnPropertyDescriptor(globalThis, name),
  }));
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  t.after(() => {
    for (const { name, descriptor } of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  const playerUrl = new URL('../src/core/player.js', import.meta.url).href;
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      if (url !== playerUrl) return nextLoad(url, context);
      return { format: 'module', shortCircuit: true,
        source: 'export function createPlayer() { return globalThis.__parajacaDemoTestPlayer; }' };
    },
  });
  try {
    await import(new URL('../demo/main.js', import.meta.url).href);
  } finally {
    hooks.deregister();
  }
  await waitFor(() => control('layers-list').children.length === 7);

  input(control('focus-slider'), '73.4');
  input(control('dof-slider'), '35');
  input(control('intensity-x-slider'), '300');
  input(control('intensity-y-slider'), '40');
  control('quality-select').value = 'low';
  control('quality-select').dispatchEvent(new Event('change'));
  const row = child(control('layers-list'), 1);
  input(child(child(row, 1), 2), '-1250');
  input(child(child(row, 2), 2), '2050');
  input(child(child(row, 3), 2), '66.6');
  input(child(child(row, 4), 1), '33');
  input(child(child(row, 4), 1), '67');
  input(child(child(row, 1), 2), '-1250');
  input(child(child(row, 2), 2), '2050');
  input(child(child(row, 4), 1), '200');
  control('focus-cursor-toggle').click();
  assert.equal(focusTracking, 'cursor');
  assert.equal(control('focus-cursor-toggle').textContent, 'Foco no cursor: ligado');
  chosenName = null;
  control('config-save').click();
  assert.equal(download, null);
  chosenName = 'Minha cena';
  control('config-save').click();
  assert.ok(download);
  const savedDownload = /** @type {{ href: string, name: string }} */ (download);
  assert.equal(savedDownload.name, 'Minha cena.json');
  const blob = resolveObjectURL(savedDownload.href);
  assert.ok(blob);
  const savedText = await blob.text();
  URL.revokeObjectURL(savedDownload.href);
  const saved = /** @type {{ version: number, focus: number, intensityX: number, intensityY: number, quality: string, depthOfField: number, focusTracking?: string, layers: Array<{ x: number, y: number, parallaxPercent: number | null, scalePercent: number, asset: import('../src/core/scene/model.js').Asset }> }} */ (JSON.parse(savedText));
  assert.deepEqual(saved.layers[1], { x: -1250, y: 2050, parallaxPercent: 66.6, scalePercent: 200, asset: originalAssets[1] });
  assert.equal(saved.version, 2);
  assert.equal(saved.depthOfField, 35);
  assert.equal(saved.focusTracking, 'cursor');
  assert.deepEqual(saved.layers.map((layer) => layer.asset.path), originalAssets.map((asset) => asset.path));
  assert.equal(saved.layers[0].parallaxPercent, null);
  assert.deepEqual([saved.focus, saved.intensityX, saved.intensityY, saved.quality],
    [73.4, 300, 40, 'low']);
  assert.equal('assets' in saved, false);

  input(control('dof-slider'), '0');
  input(control('focus-slider'), '10');
  input(control('intensity-x-slider'), '10');
  input(child(child(row, 1), 2), '5');
  input(child(child(row, 3), 2), '2');
  const fileInput = control('config-file');
  // Older files have no focusTracking: they fall back to the slider-driven focus.
  const legacy = { ...saved, version: 1, focusTracking: undefined, layers: saved.layers.map(({ x, y, parallaxPercent, scalePercent }) => ({ x, y, parallaxPercent, scalePercent })) };
  fileInput.files = [new File([JSON.stringify(legacy)], 'space.json', { type: 'application/json' })];
  fileInput.dispatchEvent(new Event('change'));
  await waitFor(() => control('config-status').textContent.startsWith('Configuração carregada'));
  assert.deepEqual([focus, intensityX, intensityY, quality, depthOfField], [73.4, 300, 40, 'low', 0.35]);
  assert.equal(focusTracking, 'manual');
  assert.equal(control('focus-cursor-toggle').textContent, 'Foco no cursor: desligado');
  assert.deepEqual(scene.assets, originalAssets);
  assert.deepEqual(scene.variants[0].layers[1].placement,
    { x: -1250, y: 2050, width: 3840, height: 2160 });
  assert.equal(scene.variants[0].layers[1].parallaxPercent, 66.6);
  const rebuiltRow = child(control('layers-list'), 1);
  assert.equal(child(child(rebuiltRow, 1), 2).value, '-1250');
  assert.equal(child(child(rebuiltRow, 3), 2).value, '66.6');

  const snapshot = structuredClone(scene);
  const invalid = { ...saved, layers: saved.layers.slice(0, 3) };
  fileInput.files = [new File([JSON.stringify(invalid)], 'wrong.json')];
  fileInput.dispatchEvent(new Event('change'));
  await waitFor(() => control('config-status').classList.contains('error'));
  assert.match(control('config-status').textContent, /entre 4 e 11 camadas/);
  assert.deepEqual(scene, snapshot);
  assert.deepEqual([focus, intensityX, intensityY, quality, depthOfField], [73.4, 300, 40, 'low', 0.35]);

  fileInput.files = [new File([JSON.stringify({ ...legacy, focusTracking: 'mouse' })], 'mode.json')];
  fileInput.dispatchEvent(new Event('change'));
  await waitFor(() => control('config-status').textContent.includes('Modo de foco inválido'));
  assert.deepEqual(scene, snapshot);
  assert.equal(focusTracking, 'manual');

  fileInput.files = [new File(['not JSON'], 'invalid.json')];
  fileInput.dispatchEvent(new Event('change'));
  await waitFor(() => control('config-status').textContent.includes('JSON válido'));
  assert.deepEqual(scene, snapshot);

  const failing = structuredClone(legacy);
  failing.layers[0].x = 999;
  failLayer = scene.variants[0].layers[1].id;
  fileInput.files = [new File([JSON.stringify(failing)], 'failure.json')];
  fileInput.dispatchEvent(new Event('change'));
  await waitFor(() => control('config-status').textContent.includes('Simulated edit failure'));
  assert.deepEqual(scene, snapshot);
  assert.deepEqual([focus, intensityX, intensityY, quality, depthOfField], [73.4, 300, 40, 'low', 0.35]);

  fileInput.files = [new File([savedText], 'scene.json')];
  fileInput.dispatchEvent(new Event('change'));
  await waitFor(() => control('config-status').textContent.includes('arquivos das camadas carregados'));
  assert.equal(focusTracking, 'cursor');
  assert.deepEqual(scene.assets.map((asset) => asset.path), originalAssets.map((asset) => asset.path));
  assert.deepEqual(scene.variants[0].layers[1].placement, { x: -1250, y: 2050, width: 3840, height: 2160 });

  const tenLayers = structuredClone(saved);
  while (tenLayers.layers.length < 10) tenLayers.layers.push(structuredClone(tenLayers.layers[0]));
  fileInput.files = [new File([JSON.stringify(tenLayers)], 'ten.json')];
  fileInput.dispatchEvent(new Event('change'));
  await waitFor(() => scene.variants[0].layers.length === 10 && !control('config-load').disabled);
  assert.equal(control('layers-list').children.length, 10);
  fileInput.files = [new File([savedText], 'seven.json')];
  fileInput.dispatchEvent(new Event('change'));
  await waitFor(() => scene.variants[0].layers.length === 7 && !control('config-load').disabled);
  assert.equal(control('layers-list').children.length, 7);

  const restored = structuredClone(scene);
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: async () => ({ ok: false, status: 404 }) });
  fileInput.files = [new File([savedText], 'missing.json')];
  fileInput.dispatchEvent(new Event('change'));
  await waitFor(() => control('config-status').textContent.includes('HTTP 404'));
  assert.deepEqual(scene, restored);
});
