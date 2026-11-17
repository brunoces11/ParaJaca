export const ERROR_CODES = Object.freeze(/** @type {const} */ ({
  WEBGL_UNAVAILABLE: 'webgl-unavailable',
  CONTEXT_LOST_UNRECOVERABLE: 'context-lost-unrecoverable',
  INVALID_SCENE: 'invalid-scene',
  UNSUPPORTED_FORMAT_VERSION: 'unsupported-format-version',
  ASSET_LOAD_FAILED: 'asset-load-failed',
  TEXTURE_TOO_LARGE: 'texture-too-large',
  MEMORY_BUDGET_EXCEEDED: 'memory-budget-exceeded',
}));

/** @typedef {typeof ERROR_CODES[keyof typeof ERROR_CODES]} ErrorCode */

export class ParaJacaError extends Error {
  /**
   * @param {ErrorCode} code
   * @param {string} message
   * @param {{ assetId?: string | null, cause?: unknown }} [details]
   */
  constructor(code, message, details = {}) {
    super(message, { cause: details.cause });
    this.name = 'ParaJacaError';
    /** @type {ErrorCode} */
    this.code = code;
    /** @type {string | null} */
    this.assetId = details.assetId ?? null;
  }
}

/**
 * Returns true if error is an object with name === 'AbortError' (including DOMException).
 * @param {unknown} error
 * @returns {boolean}
 */
export function isAbortError(error) {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}
