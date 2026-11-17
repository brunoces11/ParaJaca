// WebGL2 context initialization, resource creation, limits, and program compilation.
// Implements R§14.1, R§14.3.

import { ParaJacaError, ERROR_CODES } from '../errors.js';

export const CONTEXT_ATTRIBUTES = Object.freeze(/** @type {const} */ ({
  alpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
}));

export const COLOR_PIPELINE = 'srgb';

/**
 * @typedef {Object} Limits
 * @property {number} maxTextureSize
 * @property {number} maxRenderbufferSize
 * @property {number} maxViewportWidth
 * @property {number} maxViewportHeight
 */

/**
 * Creates WebGL2 rendering context with project-wide context attributes.
 * @param {HTMLCanvasElement | OffscreenCanvas} canvas
 * @returns {WebGL2RenderingContext}
 */
export function createGlContext(canvas) {
  const gl = /** @type {WebGL2RenderingContext | null} */ (
    canvas.getContext('webgl2', CONTEXT_ATTRIBUTES)
  );
  if (!gl) {
    throw new ParaJacaError(ERROR_CODES.WEBGL_UNAVAILABLE, 'WebGL2 context creation failed');
  }
  return gl;
}

/**
 * Reads hardware implementation limits from WebGL2 context.
 * @param {WebGL2RenderingContext} gl
 * @returns {Limits}
 */
export function readLimits(gl) {
  const maxTextureSize = /** @type {number} */ (gl.getParameter(gl.MAX_TEXTURE_SIZE));
  const maxRenderbufferSize = /** @type {number} */ (gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
  const maxViewportDims = /** @type {Int32Array} */ (gl.getParameter(gl.MAX_VIEWPORT_DIMS));
  return {
    maxTextureSize,
    maxRenderbufferSize,
    maxViewportWidth: maxViewportDims[0],
    maxViewportHeight: maxViewportDims[1],
  };
}

/**
 * Compiles a WebGL program, links it, detaches and deletes shaders, and caches uniform locations.
 * Owner: Renderer or caller must call gl.deleteProgram(program) when disposing.
 * @param {WebGL2RenderingContext} gl
 * @param {string} name
 * @param {string} vertexSource
 * @param {string} fragmentSource
 * @param {readonly string[]} uniformNames
 * @returns {{ program: WebGLProgram, uniforms: Record<string, WebGLUniformLocation> }}
 */
export function compileProgram(gl, name, vertexSource, fragmentSource, uniformNames) {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  if (!vs) {
    throw new ParaJacaError(ERROR_CODES.WEBGL_UNAVAILABLE, `Failed to create vertex shader for ${name}`);
  }
  gl.shaderSource(vs, vertexSource);
  gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(vs) ?? 'Unknown compile error';
    gl.deleteShader(vs);
    throw new ParaJacaError(ERROR_CODES.WEBGL_UNAVAILABLE, `Shader ${name} (vertex) failed: ${log}`);
  }

  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  if (!fs) {
    gl.deleteShader(vs);
    throw new ParaJacaError(ERROR_CODES.WEBGL_UNAVAILABLE, `Failed to create fragment shader for ${name}`);
  }
  gl.shaderSource(fs, fragmentSource);
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(fs) ?? 'Unknown compile error';
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new ParaJacaError(ERROR_CODES.WEBGL_UNAVAILABLE, `Shader ${name} (fragment) failed: ${log}`);
  }

  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new ParaJacaError(ERROR_CODES.WEBGL_UNAVAILABLE, `Failed to create program for ${name}`);
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);

  // Detach and delete shaders after linking
  gl.detachShader(program, vs);
  gl.detachShader(program, fs);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? 'Unknown link error';
    gl.deleteProgram(program);
    throw new ParaJacaError(ERROR_CODES.WEBGL_UNAVAILABLE, `Program ${name} link failed: ${log}`);
  }

  /** @type {Record<string, WebGLUniformLocation>} */
  const uniforms = {};
  for (const uName of uniformNames) {
    const loc = gl.getUniformLocation(program, uName);
    if (!loc) {
      gl.deleteProgram(program);
      throw new ParaJacaError(ERROR_CODES.WEBGL_UNAVAILABLE, `Uniform location not found: ${uName} in ${name}`);
    }
    uniforms[uName] = loc;
  }

  return { program, uniforms };
}

/**
 * Creates shared quad geometry for TRIANGLE_STRIP rendering with layout location 0.
 * Owner: Renderer must delete VAO and buffer upon dispose.
 * @param {WebGL2RenderingContext} gl
 * @returns {{ vao: WebGLVertexArrayObject, buffer: WebGLBuffer }}
 */
export function createQuadGeometry(gl) {
  const vao = gl.createVertexArray();
  if (!vao) {
    throw new ParaJacaError(ERROR_CODES.WEBGL_UNAVAILABLE, 'Failed to create Vertex Array Object');
  }
  gl.bindVertexArray(vao);

  const buffer = gl.createBuffer();
  if (!buffer) {
    gl.deleteVertexArray(vao);
    throw new ParaJacaError(ERROR_CODES.WEBGL_UNAVAILABLE, 'Failed to create vertex buffer');
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);

  // 4 corners: (0,0), (1,0), (0,1), (1,1)
  const vertices = new Float32Array([
    0.0, 0.0,
    1.0, 0.0,
    0.0, 1.0,
    1.0, 1.0,
  ]);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  return { vao, buffer };
}
