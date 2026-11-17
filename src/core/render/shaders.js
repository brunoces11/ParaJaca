// GLSL ES 3.0 shader source definitions for ParaJaca renderer.
// Implements R§14.2, R§14.3, R§14.5. Zero logic, purely exported string constants.

export const QUAD_VERTEX_SOURCE = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_corner;

uniform vec4 u_rect;      // x, y, w, h in Render px, top-left origin
uniform vec2 u_viewport;  // canvas width/height in Render px

out vec2 v_uv;

void main() {
  vec2 pos = u_rect.xy + a_corner * u_rect.zw;
  gl_Position = vec4(pos.x / u_viewport.x * 2.0 - 1.0,
                     1.0 - pos.y / u_viewport.y * 2.0, 0.0, 1.0);
  v_uv = a_corner;        // v = 0 is the TOP row of the image
}
`;

export const COMPOSITE_FRAGMENT_SOURCE = `#version 300 es
precision highp float;

in vec2 v_uv;

uniform sampler2D u_texture;
uniform float u_lod;
uniform float u_opacity;

out vec4 outColor;

void main() {
  outColor = textureLod(u_texture, v_uv, u_lod) * u_opacity;
}
`;

export const PYRAMID_VERTEX_SOURCE = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_corner;

void main() {
  gl_Position = vec4(a_corner.x * 2.0 - 1.0, a_corner.y * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const PYRAMID_FRAGMENT_SOURCE = `#version 300 es
precision highp float;

uniform sampler2D u_src;
uniform float u_srcLod;
uniform vec2 u_srcSize;
uniform vec2 u_dstSize;
uniform vec2 u_dir;

out vec4 outColor;

void main() {
  vec2 center = gl_FragCoord.xy * (u_srcSize / u_dstSize);  // in src texels
  vec4 sum = vec4(0.0);
  sum += textureLod(u_src, (center - 2.0 * u_dir) / u_srcSize, u_srcLod) * 1.0;
  sum += textureLod(u_src, (center - 1.0 * u_dir) / u_srcSize, u_srcLod) * 4.0;
  sum += textureLod(u_src, center / u_srcSize, u_srcLod) * 6.0;
  sum += textureLod(u_src, (center + 1.0 * u_dir) / u_srcSize, u_srcLod) * 4.0;
  sum += textureLod(u_src, (center + 2.0 * u_dir) / u_srcSize, u_srcLod) * 1.0;
  outColor = sum / 16.0;
}
`;
