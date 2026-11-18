// WebGL2 Renderer implementation for ParaJaca.
// Implements R§14.6. Hot path contains zero allocations.

import { ParaJacaError, ERROR_CODES } from '../errors.js';
import {
  createGlContext,
  readLimits,
  compileProgram,
  createQuadGeometry,
} from './resources.js';
import {
  QUAD_VERTEX_SOURCE,
  COMPOSITE_FRAGMENT_SOURCE,
  PYRAMID_VERTEX_SOURCE,
  PYRAMID_FRAGMENT_SOURCE,
  ANIMATED_PREMULTIPLY_FRAGMENT_SOURCE,
} from './shaders.js';
import { buildPyramid, createPyramidResources, disposePyramidResources, computeLevelSizes } from './pyramid.js';

export const FRAME_CAPACITY = 11; // = MAX_LAYERS in scene/model.js

/**
 * @typedef {import('./resources.js').Limits} Limits
 * @typedef {import('../quality/requirements.js').LayerRequirements} LayerRequirements
 * @typedef {import('../scene/model.js').Rect} Rect
 */

/**
 * @typedef {Object} LayerResource
 * @property {WebGLTexture} texture
 * @property {LayerRequirements} requirements
 * @property {Rect} contentRectComp
 * @property {boolean} opaque
 * @property {{ canvas: HTMLCanvasElement, raw: WebGLTexture, pyramid: import('./pyramid.js').PyramidResources } | null} dynamic
 * @property {number} bytes
 */

/**
 * @typedef {Object} FrameState
 * @property {number} layerCount
 * @property {string[]} layerIds
 * @property {Float32Array} rects
 * @property {Float32Array} lods
 * @property {Float32Array} opacities
 * @property {Uint8Array} outlineFlags
 */

/**
 * Creates pre-allocated FrameState matching capacity.
 * @returns {FrameState}
 */
export function createFrameState() {
  return {
    layerCount: 0,
    layerIds: new Array(FRAME_CAPACITY).fill(''),
    rects: new Float32Array(FRAME_CAPACITY * 4),
    lods: new Float32Array(FRAME_CAPACITY),
    opacities: new Float32Array(FRAME_CAPACITY),
    outlineFlags: new Uint8Array(FRAME_CAPACITY),
  };
}

/**
 * Creates WebGL2 renderer instance for composition display and pyramid mipmap generation.
 * @param {HTMLCanvasElement | OffscreenCanvas} canvas
 * @param {{ isDiagnostics?: boolean }} [options]
 */
export function createRenderer(canvas, options = {}) {
  const isDiagnostics = options.isDiagnostics ?? false;
  const gl = createGlContext(canvas);
  const limits = readLimits(gl);

  const compositeProgram = compileProgram(
    gl,
    'composite',
    QUAD_VERTEX_SOURCE,
    COMPOSITE_FRAGMENT_SOURCE,
    ['u_rect', 'u_viewport', 'u_texture', 'u_lod', 'u_opacity'],
  );

  const pyramidProgram = compileProgram(
    gl,
    'pyramid',
    PYRAMID_VERTEX_SOURCE,
    PYRAMID_FRAGMENT_SOURCE,
    ['u_src', 'u_srcLod', 'u_srcSize', 'u_dstSize', 'u_dir'],
  );

  const quad = createQuadGeometry(gl);

  /** @type {Map<string, LayerResource>} */
  const resources = new Map();
  /** @type {{program: WebGLProgram, uniforms: Record<string, WebGLUniformLocation>} | null} */
  let animatedProgram = null;
  let allocatedBytes = 0;

  /** @param {LayerResource} resource */
  function deleteResource(resource) {
    gl.deleteTexture(resource.texture);
    if (resource.dynamic) {
      gl.deleteTexture(resource.dynamic.raw);
      disposePyramidResources(gl, resource.dynamic.pyramid);
    }
    allocatedBytes -= resource.bytes;
  }

  let currentViewportWidth = 0;
  let currentViewportHeight = 0;
  let currentBlendEnabled = false;

  /**
   * Sets canvas rendering resolution and viewport dimensions.
   * @param {number} cssWidth
   * @param {number} cssHeight
   * @param {number} dpr
   * @param {number} renderScale
   * @returns {{ widthRender: number, heightRender: number }}
   */
  function setViewport(cssWidth, cssHeight, dpr, renderScale) {
    let targetW = Math.round(cssWidth * dpr * renderScale);
    let targetH = Math.round(cssHeight * dpr * renderScale);

    targetW = Math.max(1, Math.min(targetW, limits.maxRenderbufferSize, limits.maxViewportWidth));
    targetH = Math.max(1, Math.min(targetH, limits.maxRenderbufferSize, limits.maxViewportHeight));

    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    currentViewportWidth = targetW;
    currentViewportHeight = targetH;
    gl.viewport(0, 0, targetW, targetH);
    return { widthRender: targetW, heightRender: targetH };
  }

  /**
   * Uploads texture, builds mip pyramid, and stores LayerResource.
   * @param {string} layerId
   * @param {{ bitmap: ImageBitmap, contentRectComp: Rect, opaque: boolean, canvas?: HTMLCanvasElement }} source
   * @param {LayerRequirements} requirements
   * @param {AbortSignal} signal
   * @returns {Promise<void>}
   */
  async function prepareLayer(layerId, source, requirements, signal) {
    signal.throwIfAborted();
    const { bitmap, contentRectComp, opaque } = source;
    const { textureSize, levels, paddingTex } = requirements;
    const sizes = computeLevelSizes(textureSize, levels);
    let bytes = 0;
    for (const size of sizes) bytes += size.width * size.height * 4;
    if (source.canvas) {
      bytes += source.canvas.width * source.canvas.height * 8;
      for (let k = 1; k < sizes.length; k++) bytes += sizes[k].width * sizes[k - 1].height * 4;
    }
    if (allocatedBytes + bytes > 400 * 1024 * 1024) {
      source.bitmap.close();
      throw new ParaJacaError(ERROR_CODES.ASSET_LOAD_FAILED, 'Scene exceeds the 400 MB texture budget');
    }
    /** @type {LayerResource['dynamic']} */
    let dynamic = null;

    const texture = gl.createTexture();
    if (!texture) {
      bitmap.close();
      throw new ParaJacaError(ERROR_CODES.WEBGL_UNAVAILABLE, `Failed to create texture for layer ${layerId}`);
    }

    try {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, textureSize.width, textureSize.height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        paddingTex.left,
        paddingTex.top,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        bitmap,
      );
      bitmap.close();

      buildPyramid(
        gl,
        pyramidProgram,
        quad,
        texture,
        textureSize,
        levels,
        currentViewportWidth,
        currentViewportHeight,
        isDiagnostics,
      );

      signal.throwIfAborted();

      if (source.canvas) {
        if (!animatedProgram) animatedProgram = compileProgram(gl, 'animated-alpha', PYRAMID_VERTEX_SOURCE,
          ANIMATED_PREMULTIPLY_FRAGMENT_SOURCE, ['u_src', 'u_offset']);
        const raw = gl.createTexture();
        if (!raw) throw new ParaJacaError(ERROR_CODES.WEBGL_UNAVAILABLE, 'Failed to allocate animation upload texture');
        try {
          gl.bindTexture(gl.TEXTURE_2D, raw);
          gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, source.canvas.width, source.canvas.height);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          dynamic = { canvas: source.canvas, raw, pyramid: createPyramidResources(gl, textureSize, levels) };
        } catch (error) { gl.deleteTexture(raw); throw error; }
      }

      const oldResource = resources.get(layerId);
      if (oldResource) {
        deleteResource(oldResource);
      }

      resources.set(layerId, {
        texture,
        requirements,
        contentRectComp,
        opaque,
        dynamic,
        bytes,
      });
      allocatedBytes += bytes;
    } catch (err) {
      gl.deleteTexture(texture);
      bitmap.close();
      if (dynamic) { gl.deleteTexture(dynamic.raw); disposePyramidResources(gl, dynamic.pyramid); }
      throw err;
    }
  }

  /** Update an existing texture and its blur levels without allocating GPU resources.
   * @param {string} layerId */
  function updateLayer(layerId) {
    const resource = resources.get(layerId);
    if (!resource || !resource.dynamic || !animatedProgram) return;
    const dynamic = resource.dynamic;
    const req = resource.requirements;
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, dynamic.raw);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, dynamic.canvas);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dynamic.pyramid.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, resource.texture, 0);
    gl.viewport(req.paddingTex.left, req.paddingTex.top, dynamic.canvas.width, dynamic.canvas.height);
    gl.useProgram(animatedProgram.program);
    gl.bindVertexArray(quad.vao);
    gl.uniform1i(animatedProgram.uniforms.u_src, 0);
    gl.uniform2i(animatedProgram.uniforms.u_offset, req.paddingTex.left, req.paddingTex.top);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    buildPyramid(gl, pyramidProgram, quad, resource.texture, req.textureSize, req.levels,
      currentViewportWidth, currentViewportHeight, false, dynamic.pyramid);
    gl.viewport(0, 0, currentViewportWidth, currentViewportHeight);
  }

  /**
   * Draws a composite frame according to frameState.
   * Hot path: no dynamic allocations.
   * @param {FrameState} frameState
   */
  function draw(frameState) {
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const count = frameState.layerCount;
    if (count === 0) return;

    gl.useProgram(compositeProgram.program);
    gl.bindVertexArray(quad.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(compositeProgram.uniforms.u_texture, 0);
    gl.uniform2f(compositeProgram.uniforms.u_viewport, currentViewportWidth, currentViewportHeight);

    currentBlendEnabled = gl.isEnabled(gl.BLEND);

    for (let i = 0; i < count; i++) {
      const layerId = frameState.layerIds[i];
      const resource = resources.get(layerId);
      if (!resource) continue;

      const shouldBlend = !resource.opaque;
      if (shouldBlend !== currentBlendEnabled) {
        if (shouldBlend) {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        } else {
          gl.disable(gl.BLEND);
        }
        currentBlendEnabled = shouldBlend;
      }

      gl.bindTexture(gl.TEXTURE_2D, resource.texture);

      const rIdx = i * 4;
      gl.uniform4f(
        compositeProgram.uniforms.u_rect,
        frameState.rects[rIdx],
        frameState.rects[rIdx + 1],
        frameState.rects[rIdx + 2],
        frameState.rects[rIdx + 3],
      );
      gl.uniform1f(compositeProgram.uniforms.u_lod, frameState.lods[i]);
      gl.uniform1f(compositeProgram.uniforms.u_opacity, frameState.opacities[i]);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindVertexArray(null);
    gl.useProgram(null);
  }

  /**
   * Releases GPU texture associated with layerId.
   * @param {string} layerId
   */
  function releaseLayer(layerId) {
    const res = resources.get(layerId);
    if (res) {
      deleteResource(res);
      resources.delete(layerId);
    }
  }

  /**
   * Checks if layer is currently prepared in GPU memory.
   * @param {string} layerId
   * @returns {boolean}
   */
  function hasLayer(layerId) {
    return resources.has(layerId);
  }

  /**
   * Gets resource descriptor for a prepared layer.
   * @param {string} layerId
   * @returns {LayerResource | null}
   */
  function getLayerResource(layerId) {
    return resources.get(layerId) ?? null;
  }

  /**
   * Returns cached hardware limits.
   * @returns {Limits}
   */
  function getLimits() {
    return limits;
  }

  /**
   * Disposes all GPU resources, programs, and geometry buffers.
   */
  function dispose() {
    for (const res of resources.values()) {
      deleteResource(res);
    }
    resources.clear();

    gl.deleteProgram(compositeProgram.program);
    gl.deleteProgram(pyramidProgram.program);
    if (animatedProgram) gl.deleteProgram(animatedProgram.program);
    gl.deleteVertexArray(quad.vao);
    gl.deleteBuffer(quad.buffer);
  }

  return {
    prepareLayer,
    updateLayer,
    releaseLayer,
    hasLayer,
    getLayerResource,
    setViewport,
    draw,
    getLimits,
    dispose,
  };
}
