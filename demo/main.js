// Interactive demonstration page controller for ParaJaca Phase A (7-layer reference scene).
// Connects player instance to UI controls, per-axis intensity, layer panel/dialog, and live performance telemetry.

import { createPlayer } from '../src/core/player.js';
import { inspectMediaFile } from '../src/core/sources/media-source.js';

/** @typedef {import('../src/core/player.js').DiagnosticsSample} DiagnosticsSample */
/** @typedef {import('../src/core/scene/model.js').QualityPresetName} QualityPresetName */
/** @typedef {import('../src/core/scene/model.js').Scene} Scene */
/** @typedef {import('../src/core/scene/model.js').Variant} Variant */
/** @typedef {import('../src/core/scene/model.js').Asset} Asset */
/** @typedef {import('../src/core/scene/model.js').AssetType} AssetType */
/** @typedef {import('../src/core/scene/model.js').Layer} Layer */

/**
 * @typedef {Object} DemoConfiguration
 * @property {'parajaca-config'} format
 * @property {1 | 2} version
 * @property {number} focus
 * @property {number} intensityX
 * @property {number} intensityY
 * @property {'high' | 'mid' | 'low'} quality
 * @property {Array<{ x: number, y: number, parallaxPercent: number | null, asset?: Asset }>} layers
 */

/**
 * @typedef {Object} PendingImage
 * @property {File} file
 * @property {AssetType} type
 * @property {number} width
 * @property {number} height
 * @property {string} previewUrl
 */

/**
 * @typedef {Object} ReplaceSlot
 * @property {string} layerId
 * @property {number} number 1-based position (1 = back)
 * @property {string} currentName
 * @property {string} currentThumbUrl
 * @property {PendingImage | null} pending
 * @property {HTMLImageElement} thumb
 * @property {HTMLElement} nameLabel
 * @property {AbortController | null} importController
 */

const container = /** @type {HTMLElement} */ (document.getElementById('player-container'));
const focusSlider = /** @type {HTMLInputElement} */ (document.getElementById('focus-slider'));
const focusVal = /** @type {HTMLElement} */ (document.getElementById('focus-val'));
const intensityXSlider = /** @type {HTMLInputElement} */ (document.getElementById('intensity-x-slider'));
const intensityXVal = /** @type {HTMLElement} */ (document.getElementById('intensity-x-val'));
const intensityYSlider = /** @type {HTMLInputElement} */ (document.getElementById('intensity-y-slider'));
const intensityYVal = /** @type {HTMLElement} */ (document.getElementById('intensity-y-val'));
const qualitySelect = /** @type {HTMLSelectElement} */ (document.getElementById('quality-select'));
const configSaveButton = /** @type {HTMLButtonElement} */ (document.getElementById('config-save'));
const configLoadButton = /** @type {HTMLButtonElement} */ (document.getElementById('config-load'));
const configFileInput = /** @type {HTMLInputElement} */ (document.getElementById('config-file'));
const configStatus = /** @type {HTMLElement} */ (document.getElementById('config-status'));
const statLayers = /** @type {HTMLElement} */ (document.getElementById('stat-layers'));
const hudBadgeLayers = /** @type {HTMLElement} */ (document.getElementById('hud-badge-layers'));
const statFps = /** @type {HTMLElement} */ (document.getElementById('stat-fps'));
const statP95 = /** @type {HTMLElement} */ (document.getElementById('stat-p95'));
const statP99 = /** @type {HTMLElement} */ (document.getElementById('stat-p99'));
const statScale = /** @type {HTMLElement} */ (document.getElementById('stat-scale'));
const statRes = /** @type {HTMLElement} */ (document.getElementById('stat-res'));
const statConv = /** @type {HTMLElement} */ (document.getElementById('stat-conv'));
const errorBox = /** @type {HTMLElement} */ (document.getElementById('error-box'));
const hudPanel = /** @type {HTMLElement} */ (document.getElementById('hud'));
const hudToggle = /** @type {HTMLButtonElement} */ (document.getElementById('hud-toggle'));
const layersPanel = /** @type {HTMLElement} */ (document.getElementById('layers-panel'));
const layersToggle = /** @type {HTMLButtonElement} */ (document.getElementById('layers-toggle'));
const layersBody = /** @type {HTMLElement} */ (document.getElementById('layers-body'));
const layersList = /** @type {HTMLElement} */ (document.getElementById('layers-list'));
const layersStatus = /** @type {HTMLElement} */ (document.getElementById('layers-status'));
const replaceOpenButton = /** @type {HTMLButtonElement} */ (document.getElementById('replace-open'));
const resetAllButton = /** @type {HTMLButtonElement} */ (document.getElementById('reset-all'));
const replaceDialog = /** @type {HTMLDialogElement} */ (document.getElementById('replace-dialog'));
const replaceSlots = /** @type {HTMLElement} */ (document.getElementById('replace-slots'));
const replaceStatus = /** @type {HTMLElement} */ (document.getElementById('replace-status'));
const replacePickManyButton = /** @type {HTMLButtonElement} */ (document.getElementById('replace-pick-many'));
const replaceClearButton = /** @type {HTMLButtonElement} */ (document.getElementById('replace-clear'));
const replaceCancelButton = /** @type {HTMLButtonElement} */ (document.getElementById('replace-cancel'));
const replaceApplyButton = /** @type {HTMLButtonElement} */ (document.getElementById('replace-apply'));
const replaceFilesInput = /** @type {HTMLInputElement} */ (document.getElementById('replace-files'));
const replaceSlotFileInput = /** @type {HTMLInputElement} */ (document.getElementById('replace-slot-file'));
const svgCodeDialog = /** @type {HTMLDialogElement} */ (document.getElementById('svg-code-dialog'));
const svgCode = /** @type {HTMLTextAreaElement} */ (document.getElementById('svg-code'));
const svgCodeStatus = /** @type {HTMLElement} */ (document.getElementById('svg-code-status'));
const svgCodeApply = /** @type {HTMLButtonElement} */ (document.getElementById('svg-code-apply'));
const svgCodeCancel = /** @type {HTMLButtonElement} */ (document.getElementById('svg-code-cancel'));
const animationToggle = /** @type {HTMLButtonElement} */ (document.getElementById('animation-toggle'));
let svgCodeSlot = -1;
let animationPaused = false;

const SCENE_URL = new URL('scene.json', document.baseURI);
const LAYER_SLIDER_SPAN_COMP = 500;
// Numbered file suffixes address existing layers, including optional vector formats.
const LAYER_SUFFIX_REGEX = /_(\d{1,2})\.(png|webp|jpe?g|svg|json|lottie)$/i;
const ANIMATION_THUMB = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="48" viewBox="0 0 80 48"><rect width="80" height="48" fill="#15243a"/><path d="M32 12L54 24L32 36Z" fill="#60a5fa"/></svg>');

let isBusy = false;
let isSceneReady = false;

// Images picked by the user in the replace dialog, keyed by the assetId created for them.
/** @type {Map<string, { blob: Blob, url: string }>} */
const imageOverrides = new Map();

/**
 * Asset resolver: user-picked images first, then the files referenced by scene.json.
 * @param {Asset} asset
 * @returns {Blob | string}
 */
function resolveAsset(asset) {
  const override = imageOverrides.get(asset.id);
  return override ? override.blob : new URL(asset.path, SCENE_URL).href;
}

// Circular buffer for frame durations (up to 600 frames = ~10s at 60fps)
const BUFFER_SIZE = 600;
const frameBuffer = new Float32Array(BUFFER_SIZE);
let writeIdx = 0;
let bufferCount = 0;

/** @type {DiagnosticsSample | null} */
let latestSample = null;

/**
 * Diagnostics collector called by player on each rendered frame.
 * @param {DiagnosticsSample} sample
 */
function onDiagnostics(sample) {
  latestSample = sample;
  frameBuffer[writeIdx] = sample.frameDurationMs;
  writeIdx = (writeIdx + 1) % BUFFER_SIZE;
  if (bufferCount < BUFFER_SIZE) {
    bufferCount++;
  }
}

// Instantiate player with high quality preset
const player = createPlayer(container, {
  quality: 'high',
  diagnostics: onDiagnostics,
  assetResolver: resolveAsset,
});

// Load reference scene
player.load('scene.json');

// Wire Focus Slider
focusSlider.addEventListener('input', () => {
  const d = parseFloat(focusSlider.value);
  focusVal.textContent = d.toFixed(1);
  player.setFocus(d, { animate: true });
});

// Wire Parallax Intensity Sliders (independent X and Y axes)
function applyIntensity() {
  const intensityX = parseFloat(intensityXSlider.value);
  const intensityY = parseFloat(intensityYSlider.value);
  intensityXVal.textContent = `${intensityX.toFixed(0)} px`;
  intensityYVal.textContent = `${intensityY.toFixed(0)} px`;
  player.setIntensity(intensityX, intensityY);
}
intensityXSlider.addEventListener('input', applyIntensity);
intensityYSlider.addEventListener('input', applyIntensity);

// Wire Quality Selector
qualitySelect.addEventListener('change', () => {
  const preset = /** @type {QualityPresetName} */ (qualitySelect.value);
  player.setQuality(preset);
});

// Handle player errors
player.on('error', (payload) => {
  const data = /** @type {{ code: string, message: string }} */ (payload);
  errorBox.style.display = 'block';
  errorBox.textContent = `[Erro: ${data.code}] ${data.message}`;
});
player.on('warning', (payload) => setLayersStatus(`Aviso: ${String(payload.message)}`));
player.on('animation-state', (payload) => {
  animationPaused = Boolean(payload.paused);
  animationToggle.disabled = Number(payload.count) === 0;
  animationToggle.textContent = animationPaused ? 'Reproduzir animações' : 'Pausar animações';
});
animationToggle.addEventListener('click', () => player.setAnimationPaused(!animationPaused));

// Sync focus if player targets change programmatically (e.g. via Alt + Wheel)
player.on('focus-change', (payload) => {
  const data = /** @type {{ d: number }} */ (payload);
  focusSlider.value = String(data.d);
  focusVal.textContent = data.d.toFixed(1);
});

// A (re)load resets the player to the scene file values: reapply what the controls show.
player.on('ready', () => {
  isSceneReady = true;
  applyIntensity();
  player.setFocus(parseFloat(focusSlider.value), { animate: false });
  buildLayerRows(player.getScene());
});

// ---- Panels: collapse/expand per card and Ctrl+H to hide/show all ----

/**
 * @param {HTMLElement} panel
 * @param {HTMLButtonElement} toggle
 */
function wireCollapsible(panel, toggle) {
  toggle.addEventListener('click', () => {
    const isOpen = panel.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(isOpen));
  });
}
wireCollapsible(hudPanel, hudToggle);
wireCollapsible(layersPanel, layersToggle);

window.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey || e.key.toLowerCase() !== 'h') return;
  e.preventDefault();
  if (!e.repeat) {
    document.body.classList.toggle('panels-hidden');
  }
});

// ---- Layers panel: native-size images, X/Y position, and independent parallax ----

/** @type {Array<() => void>} */
let layerResets = [];

/**
 * @param {string} message
 * @param {boolean} [isError]
 */
function setLayersStatus(message, isError = false) {
  layersStatus.textContent = message;
  layersStatus.classList.toggle('error', isError);
}

/**
 * Disables the layers panel and dialog controls while a scene reload is running.
 * @param {boolean} busy
 */
function setBusy(busy) {
  isBusy = busy;
  configSaveButton.disabled = busy || !isSceneReady;
  configLoadButton.disabled = busy || !isSceneReady;
  focusSlider.disabled = busy;
  intensityXSlider.disabled = busy;
  intensityYSlider.disabled = busy;
  qualitySelect.disabled = busy;
  for (const el of layersBody.querySelectorAll('button, input')) {
    /** @type {HTMLButtonElement | HTMLInputElement} */ (el).disabled = busy;
  }
  for (const el of replaceDialog.querySelectorAll('button')) {
    el.disabled = busy;
  }
  if (!busy) {
    updateApplyState();
  }
}

/**
 * @param {Asset} asset
 * @returns {string}
 */
function thumbUrlFor(asset) {
  if (asset.type === 'lottie' || asset.type === 'dotlottie') return ANIMATION_THUMB;
  return imageOverrides.get(asset.id)?.url ?? new URL(asset.path, SCENE_URL).href;
}

/**
 * @param {Scene} scene
 * @returns {Variant | undefined}
 */
function getDefaultVariant(scene) {
  return scene.variants.find((v) => v.id === scene.defaultVariantId);
}

/**
 * Layers from back (order 0) to front.
 * @param {Variant} variant
 * @returns {Layer[]}
 */
function sortedLayers(variant) {
  return [...variant.layers].sort((a, b) => a.order - b.order);
}

/**
 * Number inputs accept any finite position; sliders expand to include it.
 * @param {Object} options
 * @param {string} options.label
 * @param {string} options.ariaLabel
 * @param {number} options.initial
 * @param {(value: number) => void} options.onChange
 * @param {boolean} [options.isPercentage]
 * @returns {{ element: HTMLElement, setValue: (value: number) => void }}
 */
function createAxisControl({ label, ariaLabel, initial, onChange, isPercentage = false }) {
  const element = document.createElement('div');
  element.className = isPercentage ? 'layer-axis layer-parallax' : 'layer-axis';

  const text = document.createElement('label');
  text.textContent = label;

  const range = document.createElement('input');
  range.type = 'range';
  range.step = isPercentage ? '0.1' : '1';
  range.setAttribute('aria-label', ariaLabel);

  const number = document.createElement('input');
  number.type = 'number';
  number.step = range.step;
  if (isPercentage) {
    number.min = '0';
    number.max = '100';
  }
  number.setAttribute('aria-label', ariaLabel);

  /** @param {number} value */
  function setValue(value) {
    const spanComp = Math.max(LAYER_SLIDER_SPAN_COMP, Math.ceil(Math.abs(value)));
    range.min = isPercentage ? '0' : String(-spanComp);
    range.max = isPercentage ? '100' : String(spanComp);
    range.value = String(value);
    number.value = String(value);
  }
  setValue(initial);

  range.addEventListener('input', () => {
    number.value = range.value;
    onChange(parseFloat(range.value));
  });
  number.addEventListener('input', () => {
    const value = parseFloat(number.value);
    if (!Number.isFinite(value)) return;
    const next = isPercentage ? Math.min(Math.max(value, 0), 100) : value;
    const typed = number.value;
    setValue(next);
    number.value = typed;
    onChange(next);
  });
  number.addEventListener('change', () => {
    const value = parseFloat(number.value);
    if (Number.isFinite(value)) {
      setValue(isPercentage ? Math.min(Math.max(value, 0), 100) : value);
    } else {
      number.value = range.value;
    }
  });

  element.append(text, range, number);
  return { element, setValue };
}

/**
 * @param {Object} options
 * @param {Layer} options.layer
 * @param {Asset | undefined} options.asset
 * @param {number} options.number 1-based position (1 = back)
 * @param {number} options.count
 * @returns {{ element: HTMLElement, reset: () => void }}
 */
function createLayerRow({ layer, asset, number, count }) {
  const row = document.createElement('div');
  row.className = 'layer-row';

  const thumb = document.createElement('img');
  thumb.className = 'layer-thumb';
  thumb.alt = '';
  if (asset) {
    thumb.src = thumbUrlFor(asset);
  }

  const heading = document.createElement('b');
  heading.textContent = `Camada ${number}`;
  const name = document.createElement('span');
  name.textContent = asset ? `${asset.name} (${asset.width}×${asset.height})` : '—';
  const title = document.createElement('div');
  title.className = 'layer-title';
  title.append(heading, name);

  const head = document.createElement('div');
  head.className = 'layer-head';
  head.append(thumb, title);

  const pos = { ...layer.placement };
  const moveLayer = () => {
    player.edit({ type: 'set-layer', layerId: layer.id, changesLayer: { placement: { ...pos } } });
  };
  const axisX = createAxisControl({
    label: 'X', ariaLabel: `X da camada ${number}`, initial: pos.x,
    onChange(v) {
      pos.x = v;
      moveLayer();
    },
  });
  const axisY = createAxisControl({
    label: 'Y', ariaLabel: `Y da camada ${number}`, initial: pos.y,
    onChange(v) {
      pos.y = v;
      moveLayer();
    },
  });
  const autoPercent = count === 1 ? 0 : (number - 1) * 100 / (count - 1);
  const parallax = createAxisControl({
    label: '%', ariaLabel: `Paralaxe da camada ${number} (%)`,
    initial: Number((layer.parallaxPercent ?? autoPercent).toFixed(1)), isPercentage: true,
    onChange(value) {
      player.edit({
        type: 'set-layer', layerId: layer.id, changesLayer: { parallaxPercent: value },
      });
    },
  });

  row.append(head, axisX.element, axisY.element, parallax.element);
  return {
    element: row,
    reset() {
      pos.x = 0;
      pos.y = 0;
      axisX.setValue(0);
      axisY.setValue(0);
      moveLayer();
    },
  };
}

/**
 * Rebuilds the panel rows from the player's current scene (back layer first).
 * @param {Scene} scene
 */
function buildLayerRows(scene) {
  layersList.replaceChildren();
  layerResets = [];
  const variant = getDefaultVariant(scene);
  if (!variant) return;
  sortedLayers(variant).forEach((layer, index) => {
    const asset = scene.assets.find((a) => a.id === layer.assetId);
    const row = createLayerRow({ layer, asset, number: index + 1, count: variant.layers.length });
    layersList.appendChild(row.element);
    layerResets.push(row.reset);
  });
  setBusy(isBusy);
}

/**
 * @param {string} message
 * @param {boolean} [isError]
 */
function setConfigStatus(message, isError = false) {
  configStatus.textContent = message;
  configStatus.classList.toggle('error', isError);
}

/**
 * Saves controls, layer parameters and the asset referenced by each layer.
 * @param {Scene} scene
 * @param {Variant} variant
 * @returns {DemoConfiguration}
 */
function captureConfiguration(scene, variant) {
  return {
    format: 'parajaca-config',
    version: 2,
    focus: Number(focusSlider.value),
    intensityX: Number(intensityXSlider.value),
    intensityY: Number(intensityYSlider.value),
    quality: /** @type {'high' | 'mid' | 'low'} */ (qualitySelect.value),
    layers: sortedLayers(variant).map((layer) => {
      const asset = scene.assets.find((item) => item.id === layer.assetId);
      if (!asset) throw new Error('Arquivo da camada não encontrado na cena.');
      const path = imageOverrides.has(asset.id)
        ? `assets/${encodeURIComponent(asset.name).replace(/\.\./g, '%2E%2E')}` : asset.path;
      return { x: layer.placement.x, y: layer.placement.y,
        parallaxPercent: layer.parallaxPercent ?? null, asset: { ...asset, path } };
    }),
  };
}

/**
 * Validates the complete file before changing the player or its controls.
 * @param {unknown} value
 * @param {Variant} variant
 * @returns {DemoConfiguration}
 */
function parseConfiguration(value, variant) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Arquivo de configuração inválido.');
  }
  const data = /** @type {Record<string, unknown>} */ (value);
  if (data.format !== 'parajaca-config' || data.version !== 1 && data.version !== 2) {
    throw new Error('Formato ou versão de configuração não reconhecido.');
  }
  const { focus, intensityX, intensityY, quality } = data;
  if (typeof focus !== 'number' || !Number.isFinite(focus)
    || focus < variant.optics.focusRange[0] || focus > variant.optics.focusRange[1]
    || Math.abs(focus * 10 - Math.round(focus * 10)) > 1e-7) {
    throw new Error('Valor de foco inválido para esta cena.');
  }
  if (typeof intensityX !== 'number' || !Number.isInteger(intensityX)
    || intensityX < 0 || intensityX > 400
    || typeof intensityY !== 'number' || !Number.isInteger(intensityY)
    || intensityY < 0 || intensityY > 400) {
    throw new Error('Valores de paralaxe X/Y devem estar entre 0 e 400.');
  }
  if (quality !== 'high' && quality !== 'mid' && quality !== 'low') {
    throw new Error('Qualidade inválida na configuração.');
  }
  if (!Array.isArray(data.layers) || data.layers.length !== variant.layers.length) {
    throw new Error(`A configuração deve ter ${variant.layers.length} camadas, como a cena atual.`);
  }
  const layers = data.layers.map((rawLayer, index) => {
    if (!rawLayer || typeof rawLayer !== 'object' || Array.isArray(rawLayer)) {
      throw new Error(`Parâmetros inválidos na camada ${index + 1}.`);
    }
    const layer = /** @type {Record<string, unknown>} */ (rawLayer);
    const { x, y, parallaxPercent } = layer;
    if (typeof x !== 'number' || !Number.isFinite(x)
      || typeof y !== 'number' || !Number.isFinite(y)
      || (parallaxPercent !== null && (typeof parallaxPercent !== 'number'
        || !Number.isFinite(parallaxPercent) || parallaxPercent < 0 || parallaxPercent > 100))) {
      throw new Error(`Parâmetros inválidos na camada ${index + 1}.`);
    }
    if (data.version === 2) {
      const asset = layer.asset;
      if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
        throw new Error(`Arquivo inválido na camada ${index + 1}.`);
      }
      const item = /** @type {Record<string, unknown>} */ (asset);
      if (typeof item.id !== 'string' || !item.id || typeof item.name !== 'string'
        || !['png', 'webp', 'jpg', 'svg', 'lottie', 'dotlottie'].includes(String(item.type))
        || typeof item.width !== 'number' || !Number.isFinite(item.width) || item.width <= 0
        || typeof item.height !== 'number' || !Number.isFinite(item.height) || item.height <= 0
        || typeof item.path !== 'string' || !/^assets\/[^/\\?#]+$/.test(item.path)
        || item.path.includes('..') || /%2f|%5c/i.test(item.path)) {
        throw new Error(`Arquivo inválido na camada ${index + 1}.`);
      }
      return { x, y, parallaxPercent, asset: /** @type {Asset} */ (/** @type {unknown} */ (item)) };
    }
    return { x, y, parallaxPercent };
  });
  return { format: 'parajaca-config', version: /** @type {1 | 2} */ (data.version), focus, intensityX, intensityY, quality, layers };
}

/**
 * Applies validated layer parameters to the current images and restores them on an edit error.
 * @param {DemoConfiguration} configuration
 * @param {Variant} variant
 * @returns {Promise<void>}
 */
async function applyConfiguration(configuration, variant) {
  const layers = sortedLayers(variant);
  let editError = '';
  const stopError = player.on('error', (payload) => {
    editError = String(payload.message);
  });
  try {
    for (let index = 0; index < layers.length; index++) {
      const layer = layers[index];
      const saved = configuration.layers[index];
      await player.edit({
        type: 'set-layer', layerId: layer.id,
        changesLayer: {
          placement: { ...layer.placement, x: saved.x, y: saved.y },
          parallaxPercent: saved.parallaxPercent,
        },
      });
      if (editError) throw new Error(editError);
    }
  } catch (error) {
    editError = '';
    for (const layer of layers) {
      await player.edit({
        type: 'set-layer', layerId: layer.id,
        changesLayer: {
          placement: { ...layer.placement }, parallaxPercent: layer.parallaxPercent ?? null,
        },
      });
    }
    if (editError) {
      throw new Error('Falha ao aplicar e restaurar as camadas; confira os ajustes atuais.');
    }
    throw error;
  } finally {
    stopError();
  }

  focusSlider.value = String(configuration.focus);
  player.setFocus(configuration.focus, { animate: false });
  intensityXSlider.value = String(configuration.intensityX);
  intensityYSlider.value = String(configuration.intensityY);
  applyIntensity();
  qualitySelect.value = configuration.quality;
  player.setQuality(configuration.quality);
  buildLayerRows(player.getScene());
}

/**
 * Restores asset references and layer positions together, rolling back on load failure.
 * @param {DemoConfiguration} configuration
 * @returns {Promise<void>}
 */
async function restoreConfigurationAssets(configuration) {
  const previousScene = player.getScene();
  const scene = player.getScene();
  const variant = getDefaultVariant(scene);
  if (!variant) throw new Error('Cena sem variante disponível.');
  const layers = sortedLayers(variant);
  const oldAssetIds = layers.map((layer) => layer.assetId);
  const savedAssets = configuration.layers.map((entry) => {
    if (!entry.asset) throw new Error('A configuração não contém todos os arquivos.');
    return entry.asset;
  });
  for (const asset of savedAssets) {
    const response = await fetch(new URL(asset.path, SCENE_URL));
    if (!response.ok) throw new Error(`Arquivo não encontrado: ${asset.path} (HTTP ${response.status}).`);
  }
  scene.assets = scene.assets.filter((asset) => !oldAssetIds.includes(asset.id));
  for (let index = 0; index < layers.length; index++) {
    const saved = configuration.layers[index];
    const asset = { ...savedAssets[index], id: crypto.randomUUID() };
    scene.assets.push(asset);
    layers[index].assetId = asset.id;
    layers[index].placement = { x: saved.x, y: saved.y, width: asset.width, height: asset.height };
    layers[index].parallaxPercent = saved.parallaxPercent;
  }
  let ready = false;
  let message = '';
  const stopReady = player.on('ready', () => { ready = true; });
  const stopError = player.on('error', (payload) => { message = String(payload.message); });
  try {
    await player.load(scene);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  } finally {
    stopReady();
    stopError();
  }
  if (!ready) {
    await player.load(previousScene);
    throw new Error(`Falha ao carregar os arquivos: ${message || 'cena não carregada'}.`);
  }
  oldAssetIds.forEach(releaseOverride);
  focusSlider.value = String(configuration.focus);
  player.setFocus(configuration.focus, { animate: false });
  intensityXSlider.value = String(configuration.intensityX);
  intensityYSlider.value = String(configuration.intensityY);
  applyIntensity();
  qualitySelect.value = configuration.quality;
  player.setQuality(configuration.quality);
  buildLayerRows(player.getScene());
}

configSaveButton.addEventListener('click', () => {
  if (isBusy || !isSceneReady) return;
  const scene = player.getScene();
  const variant = getDefaultVariant(scene);
  if (!variant) {
    setConfigStatus('Cena sem variante disponível.', true);
    return;
  }
  const json = JSON.stringify(captureConfiguration(scene, variant), null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'parajaca-configuracao.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setConfigStatus('Download da configuração iniciado.');
});

configLoadButton.addEventListener('click', () => {
  if (!isBusy && isSceneReady) configFileInput.click();
});
configFileInput.addEventListener('change', async () => {
  const file = configFileInput.files?.[0];
  configFileInput.value = '';
  if (!file || isBusy || !isSceneReady) return;

  setBusy(true);
  try {
    const data = /** @type {unknown} */ (JSON.parse(await file.text()));
    const variant = getDefaultVariant(player.getScene());
    if (!variant) throw new Error('Cena sem variante disponível.');
    const configuration = parseConfiguration(data, variant);
    if (configuration.version === 2) {
      await restoreConfigurationAssets(configuration);
      setConfigStatus('Configuração e arquivos das camadas carregados.');
    } else {
      await applyConfiguration(configuration, variant);
      setConfigStatus('Configuração carregada. As imagens atuais foram mantidas.');
    }
  } catch (error) {
    const message = error instanceof SyntaxError
      ? 'O arquivo não contém um JSON válido.'
      : error instanceof Error ? error.message : String(error);
    setConfigStatus(message, true);
  } finally {
    setBusy(false);
  }
});

resetAllButton.addEventListener('click', () => {
  for (const reset of layerResets) {
    reset();
  }
  setLayersStatus('Posições X/Y de todas as camadas zeradas.');
});

// ---- Replace-images dialog: pick up to one new image per layer, apply all at once ----

/** @type {ReplaceSlot[]} */
let slots = [];
let pickSlotIndex = -1;

/**
 * @param {string} message
 * @param {boolean} [isError]
 */
function setDialogStatus(message, isError = false) {
  replaceStatus.textContent = message;
  replaceStatus.classList.toggle('error', isError);
}

function updateApplyState() {
  replaceApplyButton.disabled = isBusy || slots.some((slot) => slot.importController !== null)
    || !slots.some((slot) => slot.pending !== null);
}

/** @param {ReplaceSlot} slot */
function renderSlot(slot) {
  if (slot.pending) {
    slot.thumb.src = slot.pending.previewUrl;
    slot.nameLabel.textContent = `→ ${slot.pending.file.name} (${slot.pending.width}×${slot.pending.height})`;
    slot.nameLabel.classList.add('pending');
  } else {
    slot.thumb.src = slot.currentThumbUrl;
    slot.nameLabel.textContent = slot.currentName;
    slot.nameLabel.classList.remove('pending');
  }
}

/** Releases every pending preview and empties the dialog rows. */
function clearReplaceSlots() {
  for (const slot of slots) {
    slot.importController?.abort();
    if (slot.pending) {
      URL.revokeObjectURL(slot.pending.previewUrl);
    }
  }
  slots = [];
  replaceSlots.replaceChildren();
}

/**
 * @param {Layer} layer
 * @param {Asset | undefined} asset
 * @param {number} number
 * @returns {HTMLElement}
 */
function createReplaceSlotRow(layer, asset, number) {
  const thumb = document.createElement('img');
  thumb.className = 'layer-thumb';
  thumb.alt = '';

  const heading = document.createElement('b');
  heading.textContent = `Camada ${number}`;
  const nameLabel = document.createElement('span');
  const title = document.createElement('div');
  title.className = 'layer-title';
  title.append(heading, nameLabel);

  const index = slots.length;
  const pickButton = document.createElement('button');
  pickButton.type = 'button';
  pickButton.className = 'btn';
  pickButton.textContent = 'Escolher…';
  pickButton.addEventListener('click', () => {
    pickSlotIndex = index;
    replaceSlotFileInput.click();
  });

  const row = document.createElement('div');
  row.className = 'slot-row';
  const codeButton = document.createElement('button');
  codeButton.type = 'button';
  codeButton.className = 'btn';
  codeButton.textContent = 'Código SVG';
  codeButton.addEventListener('click', () => {
    svgCodeSlot = index;
    svgCode.value = '';
    svgCodeStatus.textContent = '';
    svgCodeDialog.showModal();
    svgCode.focus();
  });
  const actions = document.createElement('div');
  actions.className = 'layers-toolbar';
  actions.append(pickButton, codeButton);
  row.append(thumb, title, actions);

  /** @type {ReplaceSlot} */
  const slot = {
    layerId: layer.id,
    number,
    currentName: asset ? asset.name : '—',
    currentThumbUrl: asset ? thumbUrlFor(asset) : '',
    pending: null,
    importController: null,
    thumb,
    nameLabel,
  };
  slots.push(slot);
  renderSlot(slot);
  return row;
}

function openReplaceDialog() {
  if (isBusy) return;
  const scene = player.getScene();
  const variant = getDefaultVariant(scene);
  if (!variant) return;

  clearReplaceSlots();
  sortedLayers(variant).forEach((layer, index) => {
    const asset = scene.assets.find((a) => a.id === layer.assetId);
    replaceSlots.appendChild(createReplaceSlotRow(layer, asset, index + 1));
  });
  setDialogStatus('');
  updateApplyState();
  replaceDialog.showModal();
}

/**
 * Validates and decodes a picked file into a slot.
 * @param {number} index
 * @param {File} file
 * @returns {Promise<string | null>} error message, or null on success
 */
async function setSlotImage(index, file) {
  const slot = slots[index];
  if (!slot) return null;
  slot.importController?.abort();
  const controller = new AbortController();
  slot.importController = controller;
  updateApplyState();
  try {
    const { type, width, height } = await inspectMediaFile(file, controller.signal);
    if (slots[index] !== slot || controller.signal.aborted) return null;
    if (slot.pending) URL.revokeObjectURL(slot.pending.previewUrl);
    const previewUrl = type === 'lottie' || type === 'dotlottie' ? ANIMATION_THUMB : URL.createObjectURL(file);
    slot.pending = { file, type, width, height, previewUrl };
    renderSlot(slot);
    return null;
  } catch (err) {
    if (controller.signal.aborted) return null;
    return `${file.name}: não foi possível importar (${err instanceof Error ? err.message : String(err)}).`;
  } finally {
    if (slot.importController === controller) slot.importController = null;
    updateApplyState();
  }
}

/**
 * Maps picked files to layers: `_N` suffix = layer N, the rest fill free layers in name order.
 * @param {File[]} files
 * @param {boolean[]} occupied slots that already hold a pending image
 * @returns {{ bySlot: Array<File | null>, ignored: number }}
 */
function planSlotAssignment(files, occupied) {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  /** @type {Array<File | null>} */
  const bySlot = occupied.map(() => null);
  /** @type {File[]} */
  const rest = [];
  for (const file of sorted) {
    const match = LAYER_SUFFIX_REGEX.exec(file.name);
    const index = match ? Number(match[1]) - 1 : -1;
    if (index >= 0 && index < bySlot.length && bySlot[index] === null) {
      bySlot[index] = file;
    } else {
      rest.push(file);
    }
  }
  let ignored = 0;
  for (const file of rest) {
    const free = bySlot.findIndex((assigned, i) => assigned === null && !occupied[i]);
    if (free === -1) {
      ignored++;
    } else {
      bySlot[free] = file;
    }
  }
  return { bySlot, ignored };
}

/** @param {File[]} files */
async function assignFiles(files) {
  if (isBusy || files.length === 0) return;
  const plan = planSlotAssignment(files, slots.map((slot) => slot.pending !== null));
  /** @type {string[]} */
  const problems = [];
  for (let i = 0; i < plan.bySlot.length; i++) {
    const file = plan.bySlot[i];
    if (!file) continue;
    const problem = await setSlotImage(i, file);
    if (problem) problems.push(problem);
  }
  if (plan.ignored > 0) {
    problems.push(`${plan.ignored} arquivo(s) ignorado(s): não há camada livre.`);
  }
  setDialogStatus(problems.join(' '), problems.length > 0);
}

/**
 * Replaces the image of several layers with a single scene reload (the player has no per-layer swap
 * yet). On failure the previous scene is restored.
 * @param {Array<{ layerId: string, number: number, image: PendingImage }>} entries
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
async function replaceLayerImages(entries) {
  const previousScene = player.getScene();
  const scene = player.getScene();
  const variant = getDefaultVariant(scene);
  if (!variant) {
    return { ok: false, message: 'Cena sem variante padrão.' };
  }

  /** @type {string[]} */
  const newAssetIds = [];
  /** @type {string[]} */
  const oldAssetIds = [];
  try {
    for (const { layerId, number, image } of entries) {
      const layer = variant.layers.find((l) => l.id === layerId);
      if (!layer) {
        throw new Error(`Camada ${number} não encontrada`);
      }
      const oldAssetId = layer.assetId;
      const assetId = crypto.randomUUID();
      /** @type {Asset} */
      const asset = {
        id: assetId,
        name: image.file.name,
        type: image.type,
        width: image.width,
        height: image.height,
        path: `assets/${assetId}.${image.type === 'lottie' ? 'json' : image.type === 'dotlottie' ? 'lottie' : image.type}`,
      };
      imageOverrides.set(assetId, { blob: image.file, url: URL.createObjectURL(image.file) });
      newAssetIds.push(assetId);
      oldAssetIds.push(oldAssetId);
      scene.assets = scene.assets.map((a) => (a.id === oldAssetId ? asset : a));
      layer.assetId = assetId;
      layer.placement.width = image.width;
      layer.placement.height = image.height;
    }

    const outcome = { ready: false, error: /** @type {string | null} */ (null) };
    const stopReady = player.on('ready', () => {
      outcome.ready = true;
    });
    const stopError = player.on('error', (payload) => {
      outcome.error = String(payload.message);
    });
    await player.load(scene);
    stopReady();
    stopError();

    if (!outcome.ready) {
      newAssetIds.forEach(releaseOverride);
      await player.load(previousScene);
      return { ok: false, message: `Falha ao trocar as imagens: ${outcome.error ?? 'a cena não terminou de carregar'}` };
    }

    oldAssetIds.forEach(releaseOverride);
    return { ok: true, message: `${entries.length} imagem(ns) trocada(s) em tamanho original (1:1).` };
  } catch (err) {
    newAssetIds.forEach(releaseOverride);
    return { ok: false, message: `Falha ao trocar as imagens: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Drops a user-picked image (and its object URL) once nothing references it.
 * @param {string} assetId
 */
function releaseOverride(assetId) {
  const override = imageOverrides.get(assetId);
  if (!override) return;
  URL.revokeObjectURL(override.url);
  imageOverrides.delete(assetId);
}

replaceOpenButton.addEventListener('click', openReplaceDialog);
svgCodeCancel.addEventListener('click', () => svgCodeDialog.close());
svgCodeApply.addEventListener('click', async () => {
  if (svgCodeSlot < 0 || !svgCode.value.trim()) { svgCodeStatus.textContent = 'Cole um código SVG válido.'; return; }
  svgCodeApply.disabled = true;
  try {
    const file = new File([svgCode.value], `camada_${svgCodeSlot + 1}.svg`, { type: 'image/svg+xml' });
    const problem = await setSlotImage(svgCodeSlot, file);
    svgCodeStatus.textContent = problem || '';
    if (!problem) svgCodeDialog.close();
  } finally { svgCodeApply.disabled = false; }
});
replaceCancelButton.addEventListener('click', () => replaceDialog.close());
replaceDialog.addEventListener('close', () => {
  // A queued close event from an earlier import must not erase a newly opened dialog.
  if (!replaceDialog.open) clearReplaceSlots();
});
replaceDialog.addEventListener('cancel', (e) => {
  if (isBusy) e.preventDefault(); // Esc must not close the dialog while images are loading
});

replacePickManyButton.addEventListener('click', () => replaceFilesInput.click());
replaceFilesInput.addEventListener('change', () => {
  const files = Array.from(replaceFilesInput.files ?? []);
  replaceFilesInput.value = '';
  assignFiles(files);
});

replaceSlotFileInput.addEventListener('change', async () => {
  const file = replaceSlotFileInput.files?.[0];
  replaceSlotFileInput.value = '';
  if (!file || isBusy) return;
  const problem = await setSlotImage(pickSlotIndex, file);
  setDialogStatus(problem ?? '', problem !== null);
});

replaceClearButton.addEventListener('click', () => {
  for (const slot of slots) {
    slot.importController?.abort();
    slot.importController = null;
    if (slot.pending) {
      URL.revokeObjectURL(slot.pending.previewUrl);
      slot.pending = null;
      renderSlot(slot);
    }
  }
  setDialogStatus('');
  updateApplyState();
});

// Dropping files anywhere on the dialog (including its backdrop) fills the layers.
replaceDialog.addEventListener('dragover', (e) => {
  e.preventDefault();
});
replaceDialog.addEventListener('drop', (e) => {
  e.preventDefault();
  assignFiles(Array.from(e.dataTransfer?.files ?? []));
});

replaceApplyButton.addEventListener('click', async () => {
  const entries = slots.flatMap((slot) => (
    slot.pending ? [{ layerId: slot.layerId, number: slot.number, image: slot.pending }] : []
  ));
  if (entries.length === 0 || isBusy || slots.some((slot) => slot.importController !== null)) return;

  setBusy(true);
  setDialogStatus('Carregando imagens…');
  const result = await replaceLayerImages(entries);
  setBusy(false);

  setLayersStatus(result.message, !result.ok);
  if (result.ok) {
    replaceDialog.close();
  } else {
    setDialogStatus(result.message, true);
  }
});

// Periodic statistics computation every 500ms
setInterval(() => {
  if (bufferCount === 0 || !latestSample) return;

  const count = bufferCount;
  const samples = Array.from(frameBuffer.subarray(0, count));
  samples.sort((a, b) => a - b);

  const sum = samples.reduce((acc, v) => acc + v, 0);
  const avgMs = sum / count;
  const fps = avgMs > 0 ? 1000 / avgMs : 0;

  const p95Idx = Math.min(Math.floor(count * 0.95), count - 1);
  const p99Idx = Math.min(Math.floor(count * 0.99), count - 1);

  statFps.textContent = fps.toFixed(1);
  statP95.textContent = `${samples[p95Idx].toFixed(2)} ms`;
  statP99.textContent = `${samples[p99Idx].toFixed(2)} ms`;
  statScale.textContent = latestSample.renderScale.toFixed(2);
  statConv.textContent = latestSample.isConverged ? 'Sim' : 'Não';
  statLayers.textContent = `${latestSample.activeLayers} camadas`;
  hudBadgeLayers.textContent = `${latestSample.activeLayers} camadas`;

  const canvas = container.querySelector('canvas');
  if (canvas) {
    statRes.textContent = `${canvas.width}×${canvas.height}`;
  }
}, 500);
