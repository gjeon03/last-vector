import * as THREE from 'three';
import { FullScreenQuad, makePassMaterial } from './fullscreen.ts';
import type { QualityProfile } from '../core/Settings.ts';
import { clamp01 } from '../core/mathx.ts';
import { SSAO_BLUR_FRAG, SSAO_FRAG, SSAO_PROFILES, createSsaoUniforms } from './ssao.ts';

/**
 * The look of the game lives here.
 *
 * Pipeline: scene -> HDR half-float target -> physically-flavoured bloom chain
 * (progressive downsample / tent upsample, the same approach modern engines use, which
 * gives a wide soft skirt without the ringing of a fixed-radius gaussian) -> god rays
 * masked by the depth buffer -> a single grade pass doing ACES tonemapping, velocity-driven
 * radial blur, chromatic aberration, vignette, grain and dither.
 *
 * Everything is HDR until the final pass, which is why emissives bloom like light instead of
 * like white paint.
 */

const BLOOM_MIPS = 5;

/**
 * Present: anti-aliasing, then grain, then the blit to the canvas.
 *
 * The renderer had no anti-aliasing of any kind — the context is created without it and no
 * target carried samples, so every hard edge in a scene made almost entirely of hard-edged
 * hulls and rocks against a near-black void was a raw staircase.
 *
 * This is a separate pass because FXAA has to see the FINAL display-referred image: it works on
 * perceptual luma, so it has to run after the tonemap and the grade. Grain and dither moved here
 * with it and now run AFTER the edge blend — as part of the composite they were high-frequency
 * noise on exactly the luma signal FXAA uses to find edges, which both softens real edges and
 * invents false ones.
 */
const PRESENT_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform vec2 uSrcScale;
  uniform vec2 uSrcMax;
  uniform vec2 uTexel;
  uniform float uGrain;
  uniform float uTime;
  uniform float uEdgeThreshold;
  varying vec2 vUv;

  vec2 srcUv(vec2 uv) { return min(uv * uSrcScale, uSrcMax); }
  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main() {
    vec3 rgbM = texture2D(tDiffuse, srcUv(vUv)).rgb;
    float lM = luma(rgbM);

    // Cross-neighbourhood contrast. Below the threshold the pixel is left exactly alone, so
    // flat regions — most of a starfield — pay four taps and are never touched.
    float lN = luma(texture2D(tDiffuse, srcUv(vUv + vec2(0.0, -uTexel.y))).rgb);
    float lS = luma(texture2D(tDiffuse, srcUv(vUv + vec2(0.0,  uTexel.y))).rgb);
    float lW = luma(texture2D(tDiffuse, srcUv(vUv + vec2(-uTexel.x, 0.0))).rgb);
    float lE = luma(texture2D(tDiffuse, srcUv(vUv + vec2( uTexel.x, 0.0))).rgb);

    float lMin = min(lM, min(min(lN, lS), min(lW, lE)));
    float lMax = max(lM, max(max(lN, lS), max(lW, lE)));
    float range = lMax - lMin;

    vec3 color = rgbM;
    if (range >= max(0.028, lMax * uEdgeThreshold)) {
      float lNW = luma(texture2D(tDiffuse, srcUv(vUv + vec2(-uTexel.x, -uTexel.y))).rgb);
      float lNE = luma(texture2D(tDiffuse, srcUv(vUv + vec2( uTexel.x, -uTexel.y))).rgb);
      float lSW = luma(texture2D(tDiffuse, srcUv(vUv + vec2(-uTexel.x,  uTexel.y))).rgb);
      float lSE = luma(texture2D(tDiffuse, srcUv(vUv + vec2( uTexel.x,  uTexel.y))).rgb);

      // Edge direction from the luma gradient, normalised so the step never exceeds 8 px.
      vec2 dir = vec2(
        -((lNW + lNE) - (lSW + lSE)),
         ((lNW + lSW) - (lNE + lSE))
      );
      float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
      float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
      dir = clamp(dir * rcpMin, -8.0, 8.0) * uTexel;

      vec3 rgbA = 0.5 * (
        texture2D(tDiffuse, srcUv(vUv + dir * (1.0 / 3.0 - 0.5))).rgb +
        texture2D(tDiffuse, srcUv(vUv + dir * (2.0 / 3.0 - 0.5))).rgb
      );
      vec3 rgbB = rgbA * 0.5 + 0.25 * (
        texture2D(tDiffuse, srcUv(vUv + dir * -0.5)).rgb +
        texture2D(tDiffuse, srcUv(vUv + dir *  0.5)).rgb
      );

      // The wide blend is only trusted while it stays inside the local luma range; outside it
      // the narrow blend is used, which is what keeps FXAA from bleeding across a silhouette.
      float lB = luma(rgbB);
      color = (lB < lMin || lB > lMax) ? rgbA : rgbB;
    }

    if (uGrain > 0.0001) {
      float n = hash12(gl_FragCoord.xy + fract(uTime) * 733.7);
      color += (n - 0.5) * uGrain * (1.2 - lM * 0.8);
    }
    // Ordered-ish dither kills banding in the huge smooth nebula gradients.
    color += (hash12(gl_FragCoord.xy * 1.7 + 11.3) - 0.5) / 255.0;

    gl_FragColor = vec4(color, 1.0);
  }
`;

const PREFILTER_FRAG = /* glsl */ `
  precision highp float;
  // ---------------------------------------------------------------- dynamic resolution
  // Dynamic resolution is a VIEWPORT change, never a texture reallocation. Every target is
  // allocated once at the largest size the window can require, and only a sub-rectangle of it
  // is rendered. Reallocating nine targets per scale step cost more than it saved: measured at
  // 21 ms/sec of CPU against 1.11 ms/frame for all game logic combined, and each realloc stall
  // registered as a long frame, which drove the controller down another step — a closed
  // positive-feedback loop that made the scaler net-negative (52.2 fps free vs 59.5 fps pinned).
  //
  // So a viewport uv must be scaled into texture space before every fetch, and clamped, because
  // a wide tap that walked past the rendered region would read the stale margin beyond it.
  uniform vec2 uSrcScale;
  uniform vec2 uSrcMax;
  vec2 srcUv(vec2 uv) { return min(uv * uSrcScale, uSrcMax); }

  uniform sampler2D tDiffuse;
  uniform vec2 uTexel;
  uniform float uThreshold;
  uniform float uKnee;
  uniform float uClamp;
  varying vec2 vUv;

  vec3 sampleBox(vec2 uv) {
    vec3 a = texture2D(tDiffuse, srcUv(uv + uTexel * vec2(-1.0, -1.0))).rgb;
    vec3 b = texture2D(tDiffuse, srcUv(uv + uTexel * vec2( 1.0, -1.0))).rgb;
    vec3 c = texture2D(tDiffuse, srcUv(uv + uTexel * vec2(-1.0,  1.0))).rgb;
    vec3 d = texture2D(tDiffuse, srcUv(uv + uTexel * vec2( 1.0,  1.0))).rgb;
    return (a + b + c + d) * 0.25;
  }

  void main() {
    vec3 color = min(sampleBox(vUv), vec3(uClamp));
    float luma = max(color.r, max(color.g, color.b));
    // Soft knee: bright pixels ramp in smoothly instead of popping at the threshold.
    float soft = clamp(luma - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    soft = soft * soft / (4.0 * uKnee + 1e-5);
    float contribution = max(soft, luma - uThreshold) / max(luma, 1e-5);
    gl_FragColor = vec4(color * contribution, 1.0);
  }
`;

const DOWNSAMPLE_FRAG = /* glsl */ `
  precision highp float;
  // ---------------------------------------------------------------- dynamic resolution
  // Dynamic resolution is a VIEWPORT change, never a texture reallocation. Every target is
  // allocated once at the largest size the window can require, and only a sub-rectangle of it
  // is rendered. Reallocating nine targets per scale step cost more than it saved: measured at
  // 21 ms/sec of CPU against 1.11 ms/frame for all game logic combined, and each realloc stall
  // registered as a long frame, which drove the controller down another step — a closed
  // positive-feedback loop that made the scaler net-negative (52.2 fps free vs 59.5 fps pinned).
  //
  // So a viewport uv must be scaled into texture space before every fetch, and clamped, because
  // a wide tap that walked past the rendered region would read the stale margin beyond it.
  uniform vec2 uSrcScale;
  uniform vec2 uSrcMax;
  vec2 srcUv(vec2 uv) { return min(uv * uSrcScale, uSrcMax); }

  uniform sampler2D tDiffuse;
  uniform vec2 uTexel;
  varying vec2 vUv;

  // 13-tap partial Karis filter: stable under motion, no fireflies crawling between frames.
  void main() {
    vec3 a = texture2D(tDiffuse, srcUv(vUv + uTexel * vec2(-2.0,  2.0))).rgb;
    vec3 b = texture2D(tDiffuse, srcUv(vUv + uTexel * vec2( 0.0,  2.0))).rgb;
    vec3 c = texture2D(tDiffuse, srcUv(vUv + uTexel * vec2( 2.0,  2.0))).rgb;
    vec3 d = texture2D(tDiffuse, srcUv(vUv + uTexel * vec2(-2.0,  0.0))).rgb;
    vec3 e = texture2D(tDiffuse, srcUv(vUv)).rgb;
    vec3 f = texture2D(tDiffuse, srcUv(vUv + uTexel * vec2( 2.0,  0.0))).rgb;
    vec3 g = texture2D(tDiffuse, srcUv(vUv + uTexel * vec2(-2.0, -2.0))).rgb;
    vec3 h = texture2D(tDiffuse, srcUv(vUv + uTexel * vec2( 0.0, -2.0))).rgb;
    vec3 i = texture2D(tDiffuse, srcUv(vUv + uTexel * vec2( 2.0, -2.0))).rgb;
    vec3 j = texture2D(tDiffuse, srcUv(vUv + uTexel * vec2(-1.0,  1.0))).rgb;
    vec3 k = texture2D(tDiffuse, srcUv(vUv + uTexel * vec2( 1.0,  1.0))).rgb;
    vec3 l = texture2D(tDiffuse, srcUv(vUv + uTexel * vec2(-1.0, -1.0))).rgb;
    vec3 m = texture2D(tDiffuse, srcUv(vUv + uTexel * vec2( 1.0, -1.0))).rgb;

    vec3 result = e * 0.125;
    result += (a + c + g + i) * 0.03125;
    result += (b + d + f + h) * 0.0625;
    result += (j + k + l + m) * 0.125;
    gl_FragColor = vec4(result, 1.0);
  }
`;

const UPSAMPLE_FRAG = /* glsl */ `
  precision highp float;
  // ---------------------------------------------------------------- dynamic resolution
  // Dynamic resolution is a VIEWPORT change, never a texture reallocation. Every target is
  // allocated once at the largest size the window can require, and only a sub-rectangle of it
  // is rendered. Reallocating nine targets per scale step cost more than it saved: measured at
  // 21 ms/sec of CPU against 1.11 ms/frame for all game logic combined, and each realloc stall
  // registered as a long frame, which drove the controller down another step — a closed
  // positive-feedback loop that made the scaler net-negative (52.2 fps free vs 59.5 fps pinned).
  //
  // So a viewport uv must be scaled into texture space before every fetch, and clamped, because
  // a wide tap that walked past the rendered region would read the stale margin beyond it.
  uniform vec2 uSrcScale;
  uniform vec2 uSrcMax;
  vec2 srcUv(vec2 uv) { return min(uv * uSrcScale, uSrcMax); }

  uniform sampler2D tDiffuse;
  uniform vec2 uTexel;
  uniform float uRadius;
  varying vec2 vUv;

  // 3x3 tent filter. Widening the radius per level is what produces the long, soft skirt.
  void main() {
    vec2 o = uTexel * uRadius;
    vec3 result = texture2D(tDiffuse, srcUv(vUv + vec2(-o.x,  o.y))).rgb * 1.0;
    result += texture2D(tDiffuse, srcUv(vUv + vec2( 0.0,  o.y))).rgb * 2.0;
    result += texture2D(tDiffuse, srcUv(vUv + vec2( o.x,  o.y))).rgb * 1.0;
    result += texture2D(tDiffuse, srcUv(vUv + vec2(-o.x,  0.0))).rgb * 2.0;
    result += texture2D(tDiffuse, srcUv(vUv)).rgb * 4.0;
    result += texture2D(tDiffuse, srcUv(vUv + vec2( o.x,  0.0))).rgb * 2.0;
    result += texture2D(tDiffuse, srcUv(vUv + vec2(-o.x, -o.y))).rgb * 1.0;
    result += texture2D(tDiffuse, srcUv(vUv + vec2( 0.0, -o.y))).rgb * 2.0;
    result += texture2D(tDiffuse, srcUv(vUv + vec2( o.x, -o.y))).rgb * 1.0;
    gl_FragColor = vec4(result / 16.0, 1.0);
  }
`;

const GODRAY_FRAG = /* glsl */ `
  precision highp float;
  // ---------------------------------------------------------------- dynamic resolution
  // Dynamic resolution is a VIEWPORT change, never a texture reallocation. Every target is
  // allocated once at the largest size the window can require, and only a sub-rectangle of it
  // is rendered. Reallocating nine targets per scale step cost more than it saved: measured at
  // 21 ms/sec of CPU against 1.11 ms/frame for all game logic combined, and each realloc stall
  // registered as a long frame, which drove the controller down another step — a closed
  // positive-feedback loop that made the scaler net-negative (52.2 fps free vs 59.5 fps pinned).
  //
  // So a viewport uv must be scaled into texture space before every fetch, and clamped, because
  // a wide tap that walked past the rendered region would read the stale margin beyond it.
  uniform vec2 uSrcScale;
  uniform vec2 uSrcMax;
  vec2 srcUv(vec2 uv) { return min(uv * uSrcScale, uSrcMax); }

  uniform sampler2D tScene;
  uniform sampler2D tDepth;
  uniform vec2 uSun;
  uniform float uDensity;
  uniform float uDecay;
  uniform float uWeight;
  uniform float uVisible;
  uniform int uSamples;
  varying vec2 vUv;

  // Occlusion comes free from the depth buffer: only pixels at the far plane are "sky",
  // so any geometry between the camera and the star carves a real shadow into the shafts.
  void main() {
    if (uVisible <= 0.001) { gl_FragColor = vec4(0.0); return; }
    vec2 delta = (vUv - uSun) * (uDensity / float(uSamples));
    vec2 uv = vUv;
    float illumination = 1.0;
    vec3 accum = vec3(0.0);
    for (int i = 0; i < 64; i++) {
      if (i >= uSamples) break;
      uv -= delta;
      vec2 c = clamp(uv, 0.0, 1.0);
      float depth = texture2D(tDepth, srcUv(c)).r;
      float sky = step(0.9999, depth);
      // Only light close to the star seeds a shaft; anything else is a bright object that
      // merely happens to have nothing solid behind it.
      float nearSun = smoothstep(0.55, 0.06, length((c - uSun) * vec2(1.0, 0.5625)));
      vec3 s = texture2D(tScene, srcUv(c)).rgb * sky * nearSun;
      accum += s * illumination * uWeight;
      illumination *= uDecay;
    }
    gl_FragColor = vec4(accum / float(uSamples) * uVisible, 1.0);
  }
`;

const COMPOSITE_FRAG = /* glsl */ `
  precision highp float;
  // ---------------------------------------------------------------- dynamic resolution
  // Dynamic resolution is a VIEWPORT change, never a texture reallocation. Every target is
  // allocated once at the largest size the window can require, and only a sub-rectangle of it
  // is rendered. Reallocating nine targets per scale step cost more than it saved: measured at
  // 21 ms/sec of CPU against 1.11 ms/frame for all game logic combined, and each realloc stall
  // registered as a long frame, which drove the controller down another step — a closed
  // positive-feedback loop that made the scaler net-negative (52.2 fps free vs 59.5 fps pinned).
  //
  // So a viewport uv must be scaled into texture space before every fetch, and clamped, because
  // a wide tap that walked past the rendered region would read the stale margin beyond it.
  uniform vec2 uSrcScale;
  uniform vec2 uSrcMax;
  vec2 srcUv(vec2 uv) { return min(uv * uSrcScale, uSrcMax); }
  uniform vec2 uBloomScale;
  uniform vec2 uBloomMax;
  uniform vec2 uRayScale;
  uniform vec2 uRayMax;
  uniform vec2 uAOScale;
  uniform vec2 uAOMax;
  vec2 bloomUv(vec2 uv) { return min(uv * uBloomScale, uBloomMax); }
  vec2 rayUv(vec2 uv)   { return min(uv * uRayScale, uRayMax); }
  vec2 aoUv(vec2 uv)    { return min(uv * uAOScale, uAOMax); }

  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform sampler2D tGodrays;
  uniform sampler2D tAO;
  uniform float uAOStrength;
  uniform vec2 uResolution;
  uniform float uTime;

  uniform float uBloomStrength;
  uniform float uGodrayStrength;
  uniform vec3 uGodrayTint;
  uniform float uExposure;
  uniform float uContrast;
  uniform float uGamma;
  uniform float uPivot;
  uniform float uSaturation;
  uniform vec3 uLift;
  uniform vec3 uGain;

  uniform vec2 uBlurCentre;
  uniform float uBlurStrength;
  uniform int uBlurSamples;

  uniform float uAberration;
  uniform float uVignette;
  uniform float uDamage;
  uniform float uFade;
  uniform float uWarp;
  varying vec2 vUv;

  // Narkowicz-style ACES fit, applied to a scalar.
  float acesFilm(float x) {
    const float a = 2.51;
    const float b = 0.03;
    const float c = 2.43;
    const float d = 0.59;
    const float e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
  }

  /**
   * Hue-preserving tonemap. Applying ACES per channel drives anything bright to (1,1,1), so a
   * dying AMBER star tonemapped to a neutral white core and read as a lens-flare brush rather
   * than as a body. Mapping the peak channel and rescaling the ratio keeps the hue all the way
   * into the highlight; a controlled desaturation at the very top still lets it reach white.
   */
  vec3 tonemap(vec3 c) {
    float peak = max(c.r, max(c.g, c.b));
    if (peak < 1e-5) return vec3(0.0);
    vec3 ratio = c / peak;
    float mapped = acesFilm(peak);
    ratio = mix(ratio, vec3(1.0), pow(mapped, 5.0) * 0.6);
    return ratio * mapped;
  }

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main() {
    vec2 uv = vUv;

    // Boost warps the frame outward from the velocity vector: a lens reacting to speed.
    vec2 toCentre = uv - uBlurCentre;
    float r2 = dot(toCentre, toCentre);
    uv += toCentre * r2 * uWarp;

    // Motion blur and chromatic aberration share ONE sampling loop.
    //
    // They must: doing the blur first and then re-sampling the raw buffer for red and blue
    // gives a blurred green channel against sharp red and blue, which fringes every small
    // bright feature with a pure green halo. That defect is invisible in a still of a static
    // scene and screams the moment the camera moves.
    //
    // Lateral aberration is an edge-of-frame effect, so it ramps in with radius and stays out
    // of the centre where the ship and the reticle live.
    vec2 fromAxis = uv - 0.5;
    vec2 ca = fromAxis * dot(fromAxis, fromAxis) * uAberration
      * smoothstep(0.3, 0.75, length(fromAxis));

    vec3 scene;
    if (uBlurStrength > 0.0005 && uBlurSamples > 1) {
      // Radial smear along the direction of travel. The centre of the smear is the projected
      // velocity vector, so turning skews the streaks the way a real camera would.
      vec2 dir = (uv - uBlurCentre) * uBlurStrength;
      vec3 accum = vec3(0.0);
      float total = 0.0;
      for (int i = 0; i < 16; i++) {
        if (i >= uBlurSamples) break;
        // Jittered per pixel. Evenly spaced taps deposit a visible chain of separate copies
        // once the streak is longer than about sixteen source-feature widths, and regular
        // discrete repetition is read as a rendering artefact, never as motion. Dithering the
        // tap position dissolves the beads into grain.
        float t = (float(i) + hash12(gl_FragCoord.xy + uTime * 61.0)) / float(uBlurSamples);
        float w = 1.0 - t * 0.55;
        vec2 base = uv - dir * t;
        accum.r += texture2D(tScene, srcUv(base + ca)).r * w;
        accum.g += texture2D(tScene, srcUv(base)).g * w;
        accum.b += texture2D(tScene, srcUv(base - ca)).b * w;
        total += w;
      }
      scene = accum / total;
    } else {
      scene = vec3(
        texture2D(tScene, srcUv(uv + ca)).r,
        texture2D(tScene, srcUv(uv)).g,
        texture2D(tScene, srcUv(uv - ca)).b
      );
    }

    // Ambient occlusion. It should darken the AMBIENT term only — occlusion does not dim a
    // surface the key light is hitting directly — but this is a forward pipeline with no
    // separate ambient buffer to multiply into. The weight below is the standing approximation:
    // apply it in full where the pixel is dim (and therefore ambient-dominated) and taper it
    // away where the pixel is bright (and therefore key-lit). It is a heuristic, not physics,
    // and it is here because the alternative is an MRT that touches every material in the game.
    if (uAOStrength > 0.001) {
      float ao = texture2D(tAO, aoUv(uv)).r;
      float sceneLuma = dot(scene, vec3(0.2126, 0.7152, 0.0722));
      float ambientWeight = 1.0 - smoothstep(0.12, 0.55, sceneLuma);
      scene *= mix(1.0, ao, ambientWeight * uAOStrength);
    }

    vec3 bloom = texture2D(tBloom, bloomUv(uv)).rgb;
    vec3 rays = texture2D(tGodrays, rayUv(uv)).rgb * uGodrayTint;

    vec3 color = scene + bloom * uBloomStrength + rays * uGodrayStrength;

    // Damage goes in BEFORE the tonemap, in HDR, so it rolls off like light instead of
    // flooding. Applied after tonemapping it was an additive constant on a display-referred
    // image, which lifts the black point uniformly — and an elevated black reads as fog, so
    // every value relationship in the frame compressed at once.
    if (uDamage > 0.001) {
      float dr = length((vUv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0));
      float dEdge = smoothstep(0.62, 1.0, dr) * min(uDamage, 0.35);
      color = color * (1.0 + 0.6 * dEdge) + vec3(0.5, 0.03, 0.06) * dEdge;
    }

    color *= uExposure;
    color = tonemap(color);

    // Grade in display space: lift/gain for the cold-shadow, warm-highlight separation.
    color = uLift + color * uGain;
    // Midtone lift, then contrast about a LOW pivot. A symmetric contrast pivoted at 0.5 was
    // subtracting from everything below mid, which cancelled the lift exactly and left the
    // whole image crushed into the bottom of the range with no midtone shelf at all.
    color = pow(max(color, 0.0), vec3(uGamma));
    color = (color - uPivot) * uContrast + uPivot;
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(vec3(luma), color, uSaturation);

    // Vignette, plus a hot red edge when the hull is taking damage.
    // Starting to darken 28% of the way to the corner read as a spotlight on a black stage
    // rather than as a lens. It now stays open across the middle two thirds of the frame.
    float vig = smoothstep(1.15, 0.62, length((vUv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0)));
    color *= mix(1.0, vig, uVignette);
    color = clamp(color, 0.0, 1.0);
    color = pow(color, vec3(0.4545454545));

    // Grain and dither moved to the present pass, so they are applied after the edge blend
    // instead of being fed into its luma edge detector.
    color *= uFade;
    gl_FragColor = vec4(color, 1.0);
  }
`;

interface SizedTarget {
  target: THREE.WebGLRenderTarget;
  /** Allocation divisor against the scene target. */
  div: number;
  allocW: number;
  allocH: number;
  renderW: number;
  renderH: number;
}

/** Half a texel of clamp, so a wide tap can never walk off the rendered region. */
function setScalePair(mat: THREE.ShaderMaterial, scaleKey: string, maxKey: string, src: SizedTarget): void {
  const sx = src.renderW / src.allocW;
  const sy = src.renderH / src.allocH;
  (mat.uniforms[scaleKey].value as THREE.Vector2).set(sx, sy);
  (mat.uniforms[maxKey].value as THREE.Vector2).set(
    sx - 0.5 / src.allocW,
    sy - 0.5 / src.allocH,
  );
}

function applyScale(mat: THREE.ShaderMaterial, src: SizedTarget): void {
  setScalePair(mat, 'uSrcScale', 'uSrcMax', src);
}

export interface GradeParams {
  exposure: number;
  contrast: number;
  saturation: number;
  bloomStrength: number;
  godrayStrength: number;
  /** Screen-space position of the star, 0..1. */
  sunScreen: THREE.Vector2;
  sunVisible: number;
  /** Screen-space origin of the motion streaks, 0..1. */
  blurCentre: THREE.Vector2;
  blurStrength: number;
  aberration: number;
  warp: number;
  vignette: number;
  grain: number;
  damage: number;
  /** 0 = black, 1 = fully visible. Used for screen fades. */
  fade: number;
  time: number;
}

export class PostFX {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly quad = new FullScreenQuad();

  readonly sceneTarget: THREE.WebGLRenderTarget;
  private readonly bloomTargets: THREE.WebGLRenderTarget[] = [];
  private readonly godrayTarget: THREE.WebGLRenderTarget;
  private readonly aoTarget: THREE.WebGLRenderTarget;
  private readonly aoBlurTarget: THREE.WebGLRenderTarget;

  private readonly prefilterMat: THREE.ShaderMaterial;
  private readonly downsampleMat: THREE.ShaderMaterial;
  private readonly upsampleMat: THREE.ShaderMaterial;
  private readonly godrayMat: THREE.ShaderMaterial;
  private readonly ssaoMat: THREE.ShaderMaterial;
  private readonly ssaoBlurMat: THREE.ShaderMaterial;
  private ssaoSamples = 12;
  private readonly compositeMat: THREE.ShaderMaterial;
  private readonly presentMat: THREE.ShaderMaterial;
  private readonly presentTarget: THREE.WebGLRenderTarget;

  private profile: QualityProfile;
  /** Allocation size — the largest sub-rectangle any target can be asked to render. */
  private allocWidth = 1;
  private allocHeight = 1;
  /** Currently rendered sub-rectangle. Always <= the allocation. */
  private width = 1;
  private height = 1;
  private readonly sized: SizedTarget[] = [];

  constructor(renderer: THREE.WebGLRenderer, profile: QualityProfile) {
    this.renderer = renderer;
    this.profile = profile;

    const depthTexture = new THREE.DepthTexture(1, 1);
    depthTexture.type = THREE.UnsignedIntType;

    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      depthTexture,
      stencilBuffer: false,
      colorSpace: THREE.LinearSRGBColorSpace,
    });

    for (let i = 0; i < BLOOM_MIPS; i++) {
      const t = new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
        colorSpace: THREE.LinearSRGBColorSpace,
      });
      t.texture.wrapS = THREE.ClampToEdgeWrapping;
      t.texture.wrapT = THREE.ClampToEdgeWrapping;
      this.bloomTargets.push(t);
    }

    // Half resolution: AO is low-frequency shading and the blur would throw away the extra
    // detail anyway. Single channel would be nicer still but RGBA is the portable choice.
    const aoOptions: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      colorSpace: THREE.LinearSRGBColorSpace,
    };
    // Display-referred, so 8 bits is exactly right and costs a quarter of the bandwidth.
    this.presentTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
    this.aoTarget = new THREE.WebGLRenderTarget(1, 1, aoOptions);
    this.aoBlurTarget = new THREE.WebGLRenderTarget(1, 1, aoOptions);

    this.godrayTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      colorSpace: THREE.LinearSRGBColorSpace,
    });

    // Order matters: setRenderSize indexes this list as [scene, ...bloom mips, godray, ao, aoBlur].
    const register = (target: THREE.WebGLRenderTarget, div: number): void => {
      this.sized.push({ target, div, allocW: 1, allocH: 1, renderW: 1, renderH: 1 });
    };
    register(this.sceneTarget, 1);
    for (let i = 0; i < BLOOM_MIPS; i++) register(this.bloomTargets[i], 2 << i);
    register(this.godrayTarget, 4);
    register(this.aoTarget, 2);
    register(this.aoBlurTarget, 2);
    register(this.presentTarget, 1);

    this.presentMat = makePassMaterial(PRESENT_FRAG, {
      tDiffuse: { value: this.presentTarget.texture },
      uSrcScale: { value: new THREE.Vector2(1, 1) },
      uSrcMax: { value: new THREE.Vector2(1, 1) },
      uTexel: { value: new THREE.Vector2() },
      uGrain: { value: 0.035 },
      uTime: { value: 0 },
      uEdgeThreshold: { value: 0.125 },
    });

    this.prefilterMat = makePassMaterial(PREFILTER_FRAG, {
      tDiffuse: { value: null },
      uSrcScale: { value: new THREE.Vector2(1, 1) },
      uSrcMax: { value: new THREE.Vector2(1, 1) },

      uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: 1.05 },
      uKnee: { value: 0.62 },
      uClamp: { value: 42 },
    });

    this.downsampleMat = makePassMaterial(DOWNSAMPLE_FRAG, {
      tDiffuse: { value: null },
      uSrcScale: { value: new THREE.Vector2(1, 1) },
      uSrcMax: { value: new THREE.Vector2(1, 1) },

      uTexel: { value: new THREE.Vector2() },
    });

    this.upsampleMat = makePassMaterial(UPSAMPLE_FRAG, {
      tDiffuse: { value: null },
      uSrcScale: { value: new THREE.Vector2(1, 1) },
      uSrcMax: { value: new THREE.Vector2(1, 1) },

      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 1.0 },
    }, { blending: THREE.AdditiveBlending, transparent: true });

    this.godrayMat = makePassMaterial(GODRAY_FRAG, {
      tScene: { value: null },
      uSrcScale: { value: new THREE.Vector2(1, 1) },
      uSrcMax: { value: new THREE.Vector2(1, 1) },

      tDepth: { value: null },
      uSun: { value: new THREE.Vector2(0.5, 0.5) },
      uDensity: { value: 0.72 },
      uDecay: { value: 0.955 },
      uWeight: { value: 0.62 },
      uVisible: { value: 0 },
      uSamples: { value: profile.godraySamples },
    });

    this.ssaoMat = makePassMaterial(SSAO_FRAG, {
      ...createSsaoUniforms(),
      uSrcScale: { value: new THREE.Vector2(1, 1) },
      uSrcMax: { value: new THREE.Vector2(1, 1) },
    });
    this.ssaoBlurMat = makePassMaterial(SSAO_BLUR_FRAG, {
      uSrcScale: { value: new THREE.Vector2(1, 1) },
      uSrcMax: { value: new THREE.Vector2(1, 1) },

      tAO: { value: null },
      uTexel: { value: new THREE.Vector2() },
    });

    this.compositeMat = makePassMaterial(COMPOSITE_FRAG, {
      uSrcScale: { value: new THREE.Vector2(1, 1) },
      uSrcMax: { value: new THREE.Vector2(1, 1) },
      uBloomScale: { value: new THREE.Vector2(1, 1) },
      uBloomMax: { value: new THREE.Vector2(1, 1) },
      uRayScale: { value: new THREE.Vector2(1, 1) },
      uRayMax: { value: new THREE.Vector2(1, 1) },
      uAOScale: { value: new THREE.Vector2(1, 1) },
      uAOMax: { value: new THREE.Vector2(1, 1) },

      tScene: { value: null },
      tBloom: { value: null },
      tGodrays: { value: null },
      tAO: { value: null },
      uAOStrength: { value: 1 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uBloomStrength: { value: profile.bloomStrength },
      uGodrayStrength: { value: 1 },
      uGodrayTint: { value: new THREE.Color(1.0, 0.72, 0.42) },
      uExposure: { value: 1 },
      uContrast: { value: 1.14 },
      uGamma: { value: 0.86 },
      uPivot: { value: 0.22 },
      uSaturation: { value: 1.08 },
      uLift: { value: new THREE.Vector3(0.008, 0.012, 0.028) },
      uGain: { value: new THREE.Vector3(1.02, 0.995, 0.96) },
      uBlurCentre: { value: new THREE.Vector2(0.5, 0.5) },
      uBlurStrength: { value: 0 },
      uBlurSamples: { value: profile.motionBlurSamples },
      uAberration: { value: 0 },
      uVignette: { value: 0.85 },
      uDamage: { value: 0 },
      uFade: { value: 1 },
      uWarp: { value: 0 },
    });
  }

  setProfile(profile: QualityProfile): void {
    this.profile = profile;
    const ssao = SSAO_PROFILES[profile.ssao];
    this.ssaoSamples = ssao.samples;
    this.ssaoMat.uniforms.uSamples.value = ssao.samples;
    this.ssaoMat.uniforms.uRadius.value = ssao.radius;
    this.ssaoMat.uniforms.uIntensity.value = ssao.intensity;
    this.compositeMat.uniforms.uAOStrength.value = ssao.samples > 0 ? 1 : 0;
    this.godrayMat.uniforms.uSamples.value = profile.godraySamples;
    this.compositeMat.uniforms.uBlurSamples.value = profile.motionBlurSamples;
    this.compositeMat.uniforms.uBloomStrength.value = profile.bloomStrength;
  }

  /** The sub-rectangle actually being rendered, for telemetry. */
  get renderWidth(): number { return this.width; }
  get renderHeight(): number { return this.height; }

  /**
   * Reallocates every target. Called ONLY when the window itself changes size — never by the
   * dynamic-resolution controller, which uses `setRenderSize` instead.
   */
  setSize(width: number, height: number): void {
    this.allocWidth = Math.max(1, Math.floor(width));
    this.allocHeight = Math.max(1, Math.floor(height));

    for (const s of this.sized) {
      const w = Math.max(1, Math.floor(this.allocWidth / s.div));
      const h = Math.max(1, Math.floor(this.allocHeight / s.div));
      s.allocW = w;
      s.allocH = h;
      s.target.setSize(w, h);
    }
    const depth = this.sceneTarget.depthTexture;
    if (depth?.image) {
      depth.image.width = this.allocWidth;
      depth.image.height = this.allocHeight;
    }
    this.setRenderSize(this.allocWidth, this.allocHeight);
  }

  /**
   * Moves the rendered sub-rectangle without touching a single allocation. This is the whole
   * dynamic-resolution mechanism: each target keeps its own `viewport`/`scissor`, which three
   * applies on bind, so there is no per-frame renderer state change either.
   */
  setRenderSize(width: number, height: number): void {
    this.width = Math.min(this.allocWidth, Math.max(1, Math.floor(width)));
    this.height = Math.min(this.allocHeight, Math.max(1, Math.floor(height)));

    for (const s of this.sized) {
      s.renderW = Math.min(s.allocW, Math.max(1, Math.round(this.width / s.div)));
      s.renderH = Math.min(s.allocH, Math.max(1, Math.round(this.height / s.div)));
      s.target.viewport.set(0, 0, s.renderW, s.renderH);
      s.target.scissor.set(0, 0, s.renderW, s.renderH);
      // Scissoring the clear as well means the dead margin is never even touched.
      s.target.scissorTest = true;
    }

    const scene = this.sized[0];
    const bloom0 = this.sized[1];
    const rays = this.sized[1 + BLOOM_MIPS];
    const ao = this.sized[2 + BLOOM_MIPS];
    applyScale(this.presentMat, this.sized[4 + BLOOM_MIPS]);
    this.presentMat.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);

    applyScale(this.prefilterMat, scene);
    applyScale(this.godrayMat, scene);
    applyScale(this.ssaoMat, scene);
    applyScale(this.ssaoBlurMat, ao);
    applyScale(this.compositeMat, scene);
    setScalePair(this.compositeMat, 'uBloomScale', 'uBloomMax', bloom0);
    setScalePair(this.compositeMat, 'uRayScale', 'uRayMax', rays);
    setScalePair(this.compositeMat, 'uAOScale', 'uAOMax', ao);

    this.prefilterMat.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
    this.ssaoMat.uniforms.uResolution.value.set(ao.renderW, ao.renderH);
    this.ssaoBlurMat.uniforms.uTexel.value.set(1 / ao.renderW, 1 / ao.renderH);
    this.compositeMat.uniforms.uResolution.value.set(this.width, this.height);
  }

  /** Applies the settings the player controls without disturbing the frame-level grade. */
  setFeatureFlags(flags: { motionBlur: boolean; grain: boolean; chromaticAberration: boolean }): void {
    this.compositeMat.uniforms.uBlurSamples.value = flags.motionBlur ? this.profile.motionBlurSamples : 0;
    this.presentMat.uniforms.uGrain.value = flags.grain ? 0.035 : 0;
    this.compositeMat.userData.allowAberration = flags.chromaticAberration;
  }

  /** The AO pass needs the camera's projection to reconstruct view-space position from depth. */
  setCamera(camera: THREE.PerspectiveCamera): void {
    this.ssaoMat.uniforms.uProjection.value.copy(camera.projectionMatrix);
    this.ssaoMat.uniforms.uInverseProjection.value.copy(camera.projectionMatrixInverse);
  }

  render(grade: GradeParams): void {
    const renderer = this.renderer;
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;

    if (this.ssaoSamples > 0) {
      this.ssaoMat.uniforms.tDepth.value = this.sceneTarget.depthTexture;
      this.quad.render(renderer, this.ssaoMat, this.aoTarget);
      this.ssaoBlurMat.uniforms.tAO.value = this.aoTarget.texture;
      this.quad.render(renderer, this.ssaoBlurMat, this.aoBlurTarget);
    }

    if (this.profile.bloom) this.renderBloom();
    else this.clearTarget(this.bloomTargets[0]);

    if (this.profile.godrays && grade.sunVisible > 0.001 && this.profile.godraySamples > 0) {
      this.godrayMat.uniforms.tScene.value = this.sceneTarget.texture;
      this.godrayMat.uniforms.tDepth.value = this.sceneTarget.depthTexture;
      this.godrayMat.uniforms.uSun.value.copy(grade.sunScreen);
      this.godrayMat.uniforms.uVisible.value = grade.sunVisible;
      this.quad.render(renderer, this.godrayMat, this.godrayTarget);
    } else {
      this.clearTarget(this.godrayTarget);
    }

    const u = this.compositeMat.uniforms;
    u.tScene.value = this.sceneTarget.texture;
    u.tBloom.value = this.bloomTargets[0].texture;
    u.tGodrays.value = this.godrayTarget.texture;
    u.tAO.value = this.aoBlurTarget.texture;
    u.uTime.value = grade.time;
    u.uExposure.value = grade.exposure;
    u.uContrast.value = grade.contrast;
    u.uSaturation.value = grade.saturation;
    u.uBloomStrength.value = grade.bloomStrength;
    u.uGodrayStrength.value = grade.godrayStrength;
    u.uBlurCentre.value.copy(grade.blurCentre);
    u.uBlurStrength.value = grade.blurStrength;
    u.uAberration.value = this.compositeMat.userData.allowAberration === false ? 0 : grade.aberration;
    u.uWarp.value = grade.warp;
    u.uVignette.value = grade.vignette;
    u.uDamage.value = clamp01(grade.damage);
    u.uFade.value = clamp01(grade.fade);

    // At native the composite writes straight to the drawing buffer. Below native it writes to
    // the sub-rectangle of an 8-bit target and one bilinear blit scales it up, so the expensive
    // pass in the chain — an 8-tap blur with a per-channel offset — runs at the reduced size
    // too. Rendering it at native would have given back most of what the scaler saves.
    this.presentMat.uniforms.uTime.value = grade.time;
    this.quad.render(renderer, this.compositeMat, this.presentTarget);
    this.quad.render(renderer, this.presentMat, null);
    renderer.autoClear = prevAutoClear;
  }

  private renderBloom(): void {
    const renderer = this.renderer;
    const targets = this.bloomTargets;

    const mips = this.sized.slice(1, 1 + BLOOM_MIPS);

    this.prefilterMat.uniforms.tDiffuse.value = this.sceneTarget.texture;
    this.quad.render(renderer, this.prefilterMat, targets[0]);

    for (let i = 1; i < targets.length; i++) {
      const src = mips[i - 1];
      this.downsampleMat.uniforms.tDiffuse.value = src.target.texture;
      this.downsampleMat.uniforms.uTexel.value.set(1 / src.renderW, 1 / src.renderH);
      applyScale(this.downsampleMat, src);
      this.quad.render(renderer, this.downsampleMat, targets[i]);
    }

    // Additive tent upsample back down the chain; each level widens the skirt.
    for (let i = targets.length - 1; i > 0; i--) {
      const src = mips[i];
      const dst = targets[i - 1];
      this.upsampleMat.uniforms.tDiffuse.value = src.target.texture;
      this.upsampleMat.uniforms.uTexel.value.set(1 / src.renderW, 1 / src.renderH);
      applyScale(this.upsampleMat, src);
      this.upsampleMat.uniforms.uRadius.value = 1.0 + i * 0.35;
      renderer.autoClear = false;
      this.quad.render(renderer, this.upsampleMat, dst);
      renderer.autoClear = true;
    }
  }

  private clearTarget(target: THREE.WebGLRenderTarget): void {
    const renderer = this.renderer;
    const prev = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.setClearColor(prev, prevAlpha);
  }

  dispose(): void {
    this.presentTarget.dispose();
    this.presentMat.dispose();
    this.sceneTarget.dispose();
    this.sceneTarget.depthTexture?.dispose();
    for (const t of this.bloomTargets) t.dispose();
    this.godrayTarget.dispose();
    this.aoTarget.dispose();
    this.aoBlurTarget.dispose();
    this.prefilterMat.dispose();
    this.downsampleMat.dispose();
    this.upsampleMat.dispose();
    this.godrayMat.dispose();
    this.ssaoMat.dispose();
    this.ssaoBlurMat.dispose();
    this.compositeMat.dispose();
    this.quad.dispose();
  }
}
