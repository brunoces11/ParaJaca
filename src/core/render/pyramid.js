// Mipmap blur pyramid generator using binomial 1-4-6-4-1 filtering on premultiplied textures.
// Implements R§14.5.

import { ParaJacaError, ERROR_CODES } from '../errors.js';

/**
 * @typedef {{ width: number, height: number }} Size
 */

/**
 * Computes sizes of all mip levels: w_k = max(1, floor(w_{k-1} / 2)).
 * @param {Size} size
 * @param {number} levels
 * @returns {Size[]}
 */
export function computeLevelSizes(size, levels) {
  const result = [{ width: size.width, height: size.height }];
  for (let k = 1; k < levels; k++) {
    const prev = result[k - 1];
    result.push({
      width: Math.max(1, Math.floor(prev.width / 2)),
      height: Math.max(1, Math.floor(prev.height / 2)),
    });
  }
  return result;
}

/** @typedef {{ framebuffer: WebGLFramebuffer, sizes: Size[], temps: WebGLTexture[] }} PyramidResources */

/** Allocate scratch storage once for a changing layer.
 * @param {WebGL2RenderingContext} gl @param {Size} size @param {number} levels
 * @returns {PyramidResources} */
export function createPyramidResources(gl, size, levels) {
  const framebuffer = gl.createFramebuffer();
  if (!framebuffer) throw new ParaJacaError(ERROR_CODES.WEBGL_UNAVAILABLE, 'Failed to allocate animation framebuffer');
  const sizes = computeLevelSizes(size, levels);
  /** @type {WebGLTexture[]} */
  const temps = [];
  try {
    for (let k = 1; k < levels; k++) {
      const texture = gl.createTexture();
      if (!texture) throw new ParaJacaError(ERROR_CODES.WEBGL_UNAVAILABLE, 'Failed to allocate animation scratch texture');
      temps.push(texture);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, sizes[k].width, sizes[k - 1].height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    return { framebuffer, sizes, temps };
  } catch (error) {
    for (const texture of temps) gl.deleteTexture(texture);
    gl.deleteFramebuffer(framebuffer);
    throw error;
  } finally { gl.bindTexture(gl.TEXTURE_2D, null); }
}

/** @param {WebGL2RenderingContext} gl @param {PyramidResources} resources */
export function disposePyramidResources(gl, resources) {
  for (const texture of resources.temps) gl.deleteTexture(texture);
  gl.deleteFramebuffer(resources.framebuffer);
}

/**
 * Builds mipmap pyramid for an immutable WebGLTexture using separable H/V blur passes.
 * @param {WebGL2RenderingContext} gl
 * @param {{ program: WebGLProgram, uniforms: Record<string, WebGLUniformLocation> }} pyramidProgram
 * @param {{ vao: WebGLVertexArrayObject }} quad
 * @param {WebGLTexture} texture
 * @param {Size} textureSize
 * @param {number} levels
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 * @param {boolean} [isDiagnostics=false]
 * @param {PyramidResources} [reusable]
 */
export function buildPyramid(
  gl,
  pyramidProgram,
  quad,
  texture,
  textureSize,
  levels,
  canvasWidth,
  canvasHeight,
  isDiagnostics = false,
  reusable,
) {
  if (levels <= 1) return;

  const fb = reusable ? reusable.framebuffer : gl.createFramebuffer();
  if (!fb) {
    throw new ParaJacaError(ERROR_CODES.WEBGL_UNAVAILABLE, 'Failed to create framebuffer for pyramid');
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);

  const blendWasEnabled = reusable ? false : gl.isEnabled(gl.BLEND);
  if (blendWasEnabled) {
    gl.disable(gl.BLEND);
  }

  gl.useProgram(pyramidProgram.program);
  gl.bindVertexArray(quad.vao);
  gl.activeTexture(gl.TEXTURE0);
  gl.uniform1i(pyramidProgram.uniforms.u_src, 0);

  const levelSizes = reusable ? reusable.sizes : computeLevelSizes(textureSize, levels);

  for (let k = 1; k < levels; k++) {
    const srcSize = levelSizes[k - 1];
    const dstSize = levelSizes[k];

    // 1) Temp texture: RGBA8, 1 level, size (w_k, h_{k-1})
    const temp = reusable ? reusable.temps[k - 1] : gl.createTexture();
    if (!temp) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      throw new ParaJacaError(ERROR_CODES.WEBGL_UNAVAILABLE, 'Failed to create temp texture for pyramid');
    }
    gl.bindTexture(gl.TEXTURE_2D, temp);
    if (!reusable) {
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, dstSize.width, srcSize.height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    // 2) Horizontal pass: FB -> temp; samples texture at srcLod = k - 1
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, temp, 0);
    if (isDiagnostics && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteTexture(temp);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      throw new ParaJacaError(ERROR_CODES.WEBGL_UNAVAILABLE, 'Pyramid H pass framebuffer incomplete');
    }

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.viewport(0, 0, dstSize.width, srcSize.height);
    gl.uniform1f(pyramidProgram.uniforms.u_srcLod, k - 1);
    gl.uniform2f(pyramidProgram.uniforms.u_srcSize, srcSize.width, srcSize.height);
    gl.uniform2f(pyramidProgram.uniforms.u_dstSize, dstSize.width, srcSize.height);
    gl.uniform2f(pyramidProgram.uniforms.u_dir, 1.0, 0.0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 3) Vertical pass: FB -> texture level k; samples temp at srcLod = 0
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, k);
    if (isDiagnostics && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteTexture(temp);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      throw new ParaJacaError(ERROR_CODES.WEBGL_UNAVAILABLE, 'Pyramid V pass framebuffer incomplete');
    }

    gl.bindTexture(gl.TEXTURE_2D, temp);
    gl.viewport(0, 0, dstSize.width, dstSize.height);
    gl.uniform1f(pyramidProgram.uniforms.u_srcLod, 0.0);
    gl.uniform2f(pyramidProgram.uniforms.u_srcSize, dstSize.width, srcSize.height);
    gl.uniform2f(pyramidProgram.uniforms.u_dstSize, dstSize.width, dstSize.height);
    gl.uniform2f(pyramidProgram.uniforms.u_dir, 0.0, 1.0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 4) Delete temp texture
    if (!reusable) gl.deleteTexture(temp);
  }

  // Restore state
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!reusable) gl.deleteFramebuffer(fb);

  gl.bindVertexArray(null);
  gl.useProgram(null);
  gl.viewport(0, 0, canvasWidth, canvasHeight);

  if (blendWasEnabled) {
    gl.enable(gl.BLEND);
  }
}
