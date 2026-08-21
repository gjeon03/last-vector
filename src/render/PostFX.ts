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
  uniform float uAberration;
  varying vec2 vUv;

  vec2 srcUv(vec2 uv) { return min(uv * uSrcScale, uSrcMax); }
  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

  /**
   * One fetch, with the lateral chromatic offset already applied per channel.
   *
   * Aberration used to run AFTER the edge blend, overwriting color.r and color.b with re-fetches
   * of the raw pre-FXAA source — so two of three channels lost their anti-aliasing entirely, and
   * every silhouette in the game carried a green/magenta fringe. Isolated by restricting to the
   * frame region where the radial ramp is exactly zero, so no channel displacement is possible:
   * red +187%, blue +143%, green +0.09%. The blend was being discarded, not merely tinted.
   *
   * Folding the offset into the sampler instead means FXAA runs ON the aberrated image and every
   * channel keeps its blend.
   */
  vec3 tap(vec2 uv) {
    if (uAberration <= 0.0001) return texture2D(tDiffuse, srcUv(uv)).rgb;
    vec2 fromAxis = uv - 0.5;
    float ramp = dot(fromAxis, fromAxis) * smoothstep(0.3, 0.75, length(fromAxis));
    vec2 ca = normalize(fromAxis + 1e-6) * min(uAberration * ramp * 260.0, 1.4) * uTexel;
    return vec3(
      texture2D(tDiffuse, srcUv(uv + ca)).r,
      texture2D(tDiffuse, srcUv(uv)).g,
      texture2D(tDiffuse, srcUv(uv - ca)).b
    );
  }

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main() {
    vec3 rgbM = tap(vUv);
    float lM = luma(rgbM);

    // Cross-neighbourhood contrast. Below the threshold the pixel is left exactly alone.
    //
    // CORRECTION: this said flat regions "pay four taps". They pay FIVE — rgbM plus the four
    // neighbours below — and every one of those taps issues three texture2D fetches whenever
    // uAberration > 0.0001, so a flat pixel costs fifteen dependent fetches and an edge pixel up
    // to thirty-nine. uAberration = speed01^2 * 0.0035 + boost * 0.011 (Game.ts), which is above
    // that threshold from roughly 17% of max speed upward — i.e. essentially all of gameplay, not
    // an exceptional case. Also worth knowing when reading this pass's cost: it renders to the
    // canvas at full drawing-buffer size while the composite renders into the reduced viewport
    // sub-rectangle, so lowering renderScale makes this pass a LARGER share of the frame.
    float lN = luma(tap(vUv + vec2(0.0, -uTexel.y)));
    float lS = luma(tap(vUv + vec2(0.0,  uTexel.y)));
    float lW = luma(tap(vUv + vec2(-uTexel.x, 0.0)));
    float lE = luma(tap(vUv + vec2( uTexel.x, 0.0)));

    float lMin = min(lM, min(min(lN, lS), min(lW, lE)));
    float lMax = max(lM, max(max(lN, lS), max(lW, lE)));
    float range = lMax - lMin;

    vec3 color = rgbM;
    if (range >= max(0.028, lMax * uEdgeThreshold)) {
      float lNW = luma(tap(vUv + vec2(-uTexel.x, -uTexel.y)));
      float lNE = luma(tap(vUv + vec2( uTexel.x, -uTexel.y)));
      float lSW = luma(tap(vUv + vec2(-uTexel.x,  uTexel.y)));
      float lSE = luma(tap(vUv + vec2( uTexel.x,  uTexel.y)));

      // Edge direction from the luma gradient, normalised so the step never exceeds 8 px.
      vec2 dir = vec2(
        -((lNW + lNE) - (lSW + lSE)),
         ((lNW + lSW) - (lNE + lSE))
      );
      float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
      float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
      dir = clamp(dir * rcpMin, -8.0, 8.0) * uTexel;

      vec3 rgbA = 0.5 * (tap(vUv + dir * (1.0 / 3.0 - 0.5)) + tap(vUv + dir * (2.0 / 3.0 - 0.5)));
      vec3 rgbB = rgbA * 0.5 + 0.25 * (tap(vUv + dir * -0.5) + tap(vUv + dir * 0.5));

      // The wide blend is only trusted while it stays inside the local luma range; outside it
      // the narrow blend is used, which is what keeps FXAA from bleeding across a silhouette.
      float lB = luma(rgbB);
      color = (lB < lMin || lB > lMax) ? rgbA : rgbB;
    }

    if (uGrain > 0.0001) {
      float n = hash12(gl_FragCoord.xy + fract(uTime) * 733.7);
      color += (n - 0.5) * uGrain * (1.2 - lM * 0.8);
    }
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

  /**
   * Interleaved gradient noise (Jimenez). A per-pixel value in [0,1) that is a pure function of
   * the pixel's own coordinate — deterministic across processes, which white noise from a
   * time-varying seed would not be, and which this project's cross-process screenshot
   * comparisons depend on.
   */
  float ign(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  }

  // Occlusion comes free from the depth buffer: only pixels at the far plane are "sky",
  // so any geometry between the camera and the star carves a real shadow into the shafts.
  void main() {
    if (uVisible <= 0.001) { gl_FragColor = vec4(0.0); return; }
    vec2 delta = (vUv - uSun) * (uDensity / float(uSamples));
    /* The ray START is dithered by up to one step, and without it this pass draws BEADS.
     *
     * The march is a fixed count of taps between the pixel and the star, so at the shipped 26
     * samples and density 0.72 a pixel half a screen out steps about 26 px at a time — wider
     * than ACHRA's own core. Every tap that lands on the disc therefore deposits a separate
     * copy of it, and the shaft renders as a row of discrete circles marching away from the
     * star: visible in the committed field-dive still, where the chain crosses the megastructure
     * and reads as lens dirt rather than as light.
     *
     * More samples would also fix it and cost linearly; offsetting each pixel's start by its own
     * fraction of a step costs one hash and converts the banding into noise that the bloom chain
     * and the /uSamples average then smooth out. The high profile stays at its tuned 26 taps.
     */
    vec2 uv = vUv - delta * ign(gl_FragCoord.xy);
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

  uniform sampler2D tSceneDepth;
  uniform float uNear;
  uniform vec2 uBlurCentre;
  uniform float uBlurStrength;
  uniform int uBlurSamples;

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

    // Motion blur.
    //
    // Chromatic aberration used to live INSIDE this loop, on the reasoning that blurring green
    // and then re-sampling the raw buffer for red and blue fringes every bright feature with a
    // green halo. That reasoning was right about the failure it was avoiding and wrong about the
    // cost: at boost the smear is ~54 px sampled by 8 taps, one tap per ~7 px, so a 2.5 px star
    // deposits 8 discrete beads — and drawing each bead once per channel at a different place
    // made them near-pure single channels. Measured at 102 pixels in a 70x40 box reading 96%
    // red, 98% green, 84% blue on adjacent pixels.
    //
    // Two changes. The tap count now follows the streak length, so a tap never has to cover more
    // than a couple of pixels; and CA moved to the present pass, AFTER the blur has spread the
    // source, where its offset is clamped below the smallest resolvable feature and cannot
    // separate anything the blur has not already smeared.
    vec3 scene;
    // Screen-space length of the smear at this pixel, in pixels.
    float smearPx = length((uv - uBlurCentre) * uBlurStrength * uResolution);
    // Distance falloff: a radial smear represents forward motion, and an object at infinity has
    // no screen-space velocity from translation. The planet at 2.9 million km was being smeared
    // into a brown streak alongside the star. Reconstructed from the depth buffer rather than
    // thresholded on it, because at a 90 km far plane every reachable object sits within 0.002
    // of the far value and a threshold cannot separate them.
    float rawDepth = texture2D(tSceneDepth, srcUv(uv)).r;
    float viewZ = uNear / max(1.0 - rawDepth, 1e-7);
    // Far falloff: an object at infinity has no screen-space velocity from translation.
    // Near falloff: neither does the player's own ship, which is rigidly attached to the camera
    // and was being smeared by its own motion — the far scene was already excluded and the ship
    // never was.
    float travelMask = smoothstep(26000.0, 5000.0, viewZ) * smoothstep(60.0, 140.0, viewZ);
    float strength = uBlurStrength * travelMask;

    if (strength > 0.0005 && uBlurSamples > 1) {
      // Radial smear along the direction of travel. The centre of the smear is the projected
      // velocity vector, so turning skews the streaks the way a real camera would.
      vec2 dir = (uv - uBlurCentre) * strength;
      // One tap per ~2.2 px of smear, floored at the profile's count and capped so the cost is
      // bounded. Below the cap the streak is continuous; above it the jitter carries the rest.
      int taps = int(clamp(smearPx / 2.2, float(uBlurSamples), 32.0));
      vec3 accum = vec3(0.0);
      float total = 0.0;
      for (int i = 0; i < 32; i++) {
        if (i >= taps) break;
        // Jittered per pixel. Evenly spaced taps deposit a visible chain of separate copies
        // once the streak is longer than about sixteen source-feature widths, and regular
        // discrete repetition is read as a rendering artefact, never as motion. Dithering the
        // tap position dissolves the residue into grain.
        float t = (float(i) + hash12(gl_FragCoord.xy + uTime * 61.0)) / float(taps);
        float w = 1.0 - t * 0.55;
        accum += texture2D(tScene, srcUv(uv - dir * t)).rgb * w;
        total += w;
      }
      scene = accum / max(total, 1e-4);
    } else {
      scene = texture2D(tScene, srcUv(uv)).rgb;
    }

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
    // Ordered-ish dither kills banding in the huge smooth nebula gradients. It belongs HERE,
    // ahead of the 8-bit write into the present target — downstream of that write the banding
    // has already been quantised in and a dither can only add noise on top of it.
    color += (hash12(gl_FragCoord.xy * 1.7 + 11.3) - 0.5) / 255.0;
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
      uAberration: { value: 0 },
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
      tSceneDepth: { value: null },
      uNear: { value: 0.5 },
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
    // The motion blur reconstructs view distance from depth to fall the smear off with range.
    this.compositeMat.uniforms.uNear.value = camera.near;
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
    u.tSceneDepth.value = this.sceneTarget.depthTexture;
    u.uTime.value = grade.time;
    u.uExposure.value = grade.exposure;
    u.uContrast.value = grade.contrast;
    u.uSaturation.value = grade.saturation;
    u.uBloomStrength.value = grade.bloomStrength;
    u.uGodrayStrength.value = grade.godrayStrength;
    u.uBlurCentre.value.copy(grade.blurCentre);
    u.uBlurStrength.value = grade.blurStrength;
    this.presentMat.uniforms.uAberration.value =
      this.compositeMat.userData.allowAberration === false ? 0 : grade.aberration;
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
