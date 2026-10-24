// GLSL for the painted sky. Both shaders draw in a Ghibli style: soft gradients, clouds with
// crisp but billowy edges, warm light on top and cool lavender shadow underneath.

const noise = /* glsl */`
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return v;
}
float fbm3(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { v += a * noise(p); p = p * 2.1 + vec2(3.7, 1.9); a *= 0.5; }
  return v / 0.875;
}
float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
`;

export const skyVertex = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/** The whole sky behind the project clouds: gradient, sun or moon, stars, and drifting far clouds. */
export const skyFragment = /* glsl */`
uniform vec3 uZenith, uHorizon, uSun, uCloudLight, uCloudShadow;
uniform float uStars, uTime, uZoom, uDpr;
uniform vec2 uSunPos, uRes, uCam;
varying vec2 vUv;
${noise}
// Where a screen pixel lands in a far cloud layer. Matches layerScale() in sky-math.ts.
vec2 layerWorld(float depth) {
  float scale = pow(uZoom, 0.5 + 0.5 * depth) * (0.4 + 0.6 * depth);
  vec2 px = vec2(gl_FragCoord.x, uRes.y * uDpr - gl_FragCoord.y) / uDpr - uRes * 0.5;
  return uCam + px / scale;
}
void main() {
  float h = vUv.y;
  vec3 col = mix(uHorizon, uZenith, pow(smoothstep(-0.05, 1.0, h), 0.75));

  // Sun or moon: a soft halo and a bright disc.
  vec2 d = (vUv - uSunPos) * vec2(uRes.x / uRes.y, 1.0);
  float dist = length(d);
  col += uSun * (0.28 * exp(-dist * 2.6) + 0.16 * exp(-dist * 9.0));
  col = mix(col, uSun, smoothstep(0.052, 0.042, dist) * 0.95);

  // Stars at night, twinkling slowly.
  vec2 grid = floor(gl_FragCoord.xy / (2.6 * uDpr));
  float star = step(0.9965, hash(grid)) * (0.6 + 0.4 * sin(uTime * 1.3 + hash(grid + 3.1) * 40.0));
  col += vec3(star) * uStars * smoothstep(0.15, 0.6, h);

  // Thin cirrus streaks high up, and a far layer of soft cumulus lower down.
  vec2 cw = layerWorld(0.08) + vec2(uTime * 6.0, 0.0);
  float cirrus = smoothstep(0.56, 0.82, fbm(cw * vec2(0.0016, 0.0065)));
  col = mix(col, mix(uCloudLight, uHorizon, 0.35), cirrus * 0.35 * smoothstep(0.35, 0.85, h));

  // Soft light rays falling from the sun by day.
  vec2 fromSun = vUv - uSunPos;
  float angle = atan(fromSun.x, -fromSun.y);
  float rays = smoothstep(0.45, 1.0, noise(vec2(angle * 4.0, uTime * 0.04))) * smoothstep(1.0, 0.15, length(fromSun)) * (1.0 - uStars);
  col += uSun * rays * 0.025;

  // Painterly grain so gradients never look digital.
  col += (hash(gl_FragCoord.xy + uTime) - 0.5) * 0.012;
  gl_FragColor = vec4(col, 1.0);
}
`;

export const cloudVertex = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

/**
 * One project's cumulus cloud. Its shape comes from uSeed, so a project always has the same
 * cloud. uDepth is 1 for your projects in front and lower for other people's, further back.
 */
export const cloudFragment = /* glsl */`
uniform vec3 uLight, uShadow, uHaze, uSun;
uniform vec2 uSunDir;
uniform float uSeed, uDepth, uTime, uHover, uFade;
varying vec2 vUv;
${noise}
const float ASPECT = 0.62;
const int LOBES = 12;
// Lobe i of this cloud: center (xy), radius (z) and how far forward it sits (w).
vec4 lobe(int i) {
  float fi = float(i), a = hash(vec2(uSeed, fi + 1.0)), b = hash(vec2(fi + 5.0, uSeed + 3.1));
  if (i < 5) {           // the wide base row
    float t = fi / 4.0;
    return vec4(mix(-0.56, 0.56, t) + (a - 0.5) * 0.1, -0.08 + b * 0.05, 0.19 + 0.06 * a + 0.05 * (1.0 - abs(t - 0.5) * 2.0), 0.18);
  }
  if (i < 9) {           // the middle row
    float t = (fi - 5.0) / 3.0;
    return vec4(mix(-0.36, 0.36, t) + (a - 0.5) * 0.12, 0.1 + b * 0.08, 0.18 + 0.06 * b, 0.08);
  }
  float t = (fi - 9.0) / 2.0;   // towers on top
  return vec4(mix(-0.17, 0.17, t) + (a - 0.5) * 0.14, 0.25 + a * 0.1, 0.13 + 0.07 * b, 0.0);
}
const float BASE = -0.2;
void main() {
  vec2 p = (vUv - 0.5) * vec2(2.0, 2.0 * ASPECT);
  // Small bumps on every edge, drifting slowly, so lobes look like soft cauliflower.
  float drift = uTime * 0.015;
  vec2 w = p + 0.022 * (vec2(noise(p * 9.0 + uSeed + drift), noise(p * 9.0 + uSeed + 4.7 - drift)) - 0.5)
             + 0.035 * (vec2(fbm(p * 2.6 + uSeed), fbm(p * 2.6 + uSeed + 7.3)) - 0.5);

  // Each lobe is a sphere seen from the front; the front-most surface at this pixel wins.
  float sd = 1e3, front = -1e3;
  vec3 normal = vec3(0.0, 0.0, 1.0);
  for (int i = 0; i < LOBES; i++) {
    vec4 l = lobe(i);
    vec2 d = w - l.xy;
    float dist = length(d);
    sd = smin(sd, dist - l.z, 0.04);
    if (dist < l.z) {
      float z = sqrt(l.z * l.z - dist * dist) + l.w;
      if (z > front) { front = z; normal = normalize(vec3(d, sqrt(l.z * l.z - dist * dist))); }
    }
  }
  // Cumulus sit on a flat base.
  float base = BASE + 0.018 * sin(p.x * 5.0 + uSeed);
  sd = -smin(-sd, -(base - w.y), 0.025);
  float soft = mix(0.03, 0.004, uDepth);
  float alpha = 1.0 - smoothstep(-soft, soft, sd);
  if (alpha < 0.002) discard;

  // Painted light: the sun-side of every lobe is bright, the far side cool.
  vec3 sun = normalize(vec3(uSunDir * 0.85, 0.55));
  float diffuse = dot(normal, sun) * 0.5 + 0.5;
  float bands = 0.22 + 0.4 * smoothstep(0.42, 0.5, diffuse) + 0.38 * smoothstep(0.7, 0.78, diffuse);
  float light = mix(diffuse, bands, 0.7);
  light *= mix(0.62, 1.0, smoothstep(base, base + 0.2, w.y));   // shade under the base
  vec3 col = mix(uShadow, uLight, light);
  col = mix(col, uLight + uSun * 0.08, smoothstep(0.86, 0.95, diffuse) * 0.6);
  col *= 0.985 + 0.03 * fbm(p * 8.0 + uSeed);
  col += 0.05 * uHover;

  // Distance haze: further clouds fade toward the sky.
  col = mix(uHaze, col, mix(0.5, 1.0, uDepth));
  alpha *= mix(0.72, 1.0, uDepth) * uFade;
  gl_FragColor = vec4(col, alpha);
}
`;

/**
 * The sky around a 3D camera: every pixel looks along its own direction, so turning shows a
 * different part of the sky, with the sun fixed in place. Same colors as the flat sky.
 */
export const skyDomeFragment = /* glsl */`
uniform vec3 uZenith, uHorizon, uSun, uCloudLight, uCloudShadow, uSunDir, uRight, uUp, uForward;
uniform float uStars, uTime, uTanX, uTanY;
varying vec2 vUv;
${noise}
void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 dir = normalize(uForward + uRight * ndc.x * uTanX + uUp * ndc.y * uTanY);
  float h = dir.y;
  // Haze at the horizon, deep color overhead, and a little depth again far below.
  vec3 col = mix(uHorizon, uZenith, pow(smoothstep(-0.05, 0.9, h), 0.8));
  col = mix(col, mix(uHorizon, uZenith, 0.4), smoothstep(-0.05, -0.75, h));

  // Sun or moon, fixed in the sky.
  float toSun = dot(dir, uSunDir);
  float dist = acos(clamp(toSun, -1.0, 1.0));
  col += uSun * (0.28 * exp(-dist * 4.5) + 0.16 * exp(-dist * 16.0));
  col = mix(col, uSun, smoothstep(0.042, 0.034, dist) * 0.95);

  // Soft rays around the sun by day.
  vec3 side = normalize(cross(uSunDir, vec3(0.0, 1.0, 0.0)) + 1e-4);
  float angle = atan(dot(dir, side), dot(dir, cross(side, uSunDir)));
  // Sampled around a circle, so the pattern has no seam where the angle wraps.
  vec2 around = vec2(cos(angle), sin(angle)) * 2.2 + uTime * 0.03;
  col += uSun * smoothstep(0.45, 1.0, noise(around)) * smoothstep(1.4, 0.2, dist) * (1.0 - uStars) * 0.025;

  // Stars, stable as you turn.
  vec3 grid = floor(dir * 300.0);
  vec2 cell = grid.xy + grid.z * 17.31;
  float star = step(0.9965, hash(cell)) * (0.6 + 0.4 * sin(uTime * 1.3 + hash(cell + 3.1) * 40.0));
  col += vec3(star) * uStars * smoothstep(-0.1, 0.5, h);

  // Thin cirrus high overhead, painted on a far ceiling.
  if (h > 0.02) {
    vec2 ceiling = dir.xz / h * 900.0 + vec2(uTime * 6.0, 0.0);
    float cirrus = smoothstep(0.56, 0.82, fbm(ceiling * vec2(0.0016, 0.0065)));
    col = mix(col, mix(uCloudLight, uHorizon, 0.35), cirrus * 0.35 * smoothstep(0.05, 0.5, h));
  }
  col += (hash(gl_FragCoord.xy + uTime) - 0.5) * 0.012;
  gl_FragColor = vec4(col, 1.0);
}
`;
