import * as THREE from 'three';
import { FullScreenQuad, makePassMaterial } from './fullscreen.ts';
import type { QualityProfile } from '../core/Settings.ts';
import { clamp01 } from '../core/mathx.ts';

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

const PREFILTER_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform vec2 uTexel;
  uniform float uThreshold;
  uniform float uKnee;
  uniform float uClamp;
  varying vec2 vUv;

  vec3 sampleBox(vec2 uv) {
    vec3 a = texture2D(tDiffuse, uv + uTexel * vec2(-1.0, -1.0)).rgb;
    vec3 b = texture2D(tDiffuse, uv + uTexel * vec2( 1.0, -1.0)).rgb;
    vec3 c = texture2D(tDiffuse, uv + uTexel * vec2(-1.0,  1.0)).rgb;
    vec3 d = texture2D(tDiffuse, uv + uTexel * vec2( 1.0,  1.0)).rgb;
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
  uniform sampler2D tDiffuse;
  uniform vec2 uTexel;
  varying vec2 vUv;

  // 13-tap partial Karis filter: stable under motion, no fireflies crawling between frames.
  void main() {
    vec3 a = texture2D(tDiffuse, vUv + uTexel * vec2(-2.0,  2.0)).rgb;
    vec3 b = texture2D(tDiffuse, vUv + uTexel * vec2( 0.0,  2.0)).rgb;
    vec3 c = texture2D(tDiffuse, vUv + uTexel * vec2( 2.0,  2.0)).rgb;
    vec3 d = texture2D(tDiffuse, vUv + uTexel * vec2(-2.0,  0.0)).rgb;
    vec3 e = texture2D(tDiffuse, vUv).rgb;
    vec3 f = texture2D(tDiffuse, vUv + uTexel * vec2( 2.0,  0.0)).rgb;
    vec3 g = texture2D(tDiffuse, vUv + uTexel * vec2(-2.0, -2.0)).rgb;
    vec3 h = texture2D(tDiffuse, vUv + uTexel * vec2( 0.0, -2.0)).rgb;
    vec3 i = texture2D(tDiffuse, vUv + uTexel * vec2( 2.0, -2.0)).rgb;
    vec3 j = texture2D(tDiffuse, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
    vec3 k = texture2D(tDiffuse, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
    vec3 l = texture2D(tDiffuse, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
    vec3 m = texture2D(tDiffuse, vUv + uTexel * vec2( 1.0, -1.0)).rgb;

    vec3 result = e * 0.125;
    result += (a + c + g + i) * 0.03125;
    result += (b + d + f + h) * 0.0625;
    result += (j + k + l + m) * 0.125;
    gl_FragColor = vec4(result, 1.0);
  }
`;

const UPSAMPLE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform vec2 uTexel;
  uniform float uRadius;
  varying vec2 vUv;

  // 3x3 tent filter. Widening the radius per level is what produces the long, soft skirt.
  void main() {
    vec2 o = uTexel * uRadius;
    vec3 result = texture2D(tDiffuse, vUv + vec2(-o.x,  o.y)).rgb * 1.0;
    result += texture2D(tDiffuse, vUv + vec2( 0.0,  o.y)).rgb * 2.0;
    result += texture2D(tDiffuse, vUv + vec2( o.x,  o.y)).rgb * 1.0;
    result += texture2D(tDiffuse, vUv + vec2(-o.x,  0.0)).rgb * 2.0;
    result += texture2D(tDiffuse, vUv).rgb * 4.0;
    result += texture2D(tDiffuse, vUv + vec2( o.x,  0.0)).rgb * 2.0;
    result += texture2D(tDiffuse, vUv + vec2(-o.x, -o.y)).rgb * 1.0;
    result += texture2D(tDiffuse, vUv + vec2( 0.0, -o.y)).rgb * 2.0;
    result += texture2D(tDiffuse, vUv + vec2( o.x, -o.y)).rgb * 1.0;
    gl_FragColor = vec4(result / 16.0, 1.0);
  }
`;

const GODRAY_FRAG = /* glsl */ `
  precision highp float;
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
      float depth = texture2D(tDepth, c).r;
      float sky = step(0.9999, depth);
      // Only light close to the star seeds a shaft; anything else is a bright object that
      // merely happens to have nothing solid behind it.
      float nearSun = smoothstep(0.55, 0.06, length((c - uSun) * vec2(1.0, 0.5625)));
      vec3 s = texture2D(tScene, c).rgb * sky * nearSun;
      accum += s * illumination * uWeight;
      illumination *= uDecay;
    }
    gl_FragColor = vec4(accum / float(uSamples) * uVisible, 1.0);
  }
`;

const COMPOSITE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform sampler2D tGodrays;
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
  uniform float uGrain;
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
        accum.r += texture2D(tScene, base + ca).r * w;
        accum.g += texture2D(tScene, base).g * w;
        accum.b += texture2D(tScene, base - ca).b * w;
        total += w;
      }
      scene = accum / total;
    } else {
      scene = vec3(
        texture2D(tScene, uv + ca).r,
        texture2D(tScene, uv).g,
        texture2D(tScene, uv - ca).b
      );
    }

    vec3 bloom = texture2D(tBloom, uv).rgb;
    vec3 rays = texture2D(tGodrays, uv).rgb * uGodrayTint;

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

    if (uGrain > 0.0001) {
      float n = hash12(gl_FragCoord.xy + fract(uTime) * 733.7);
      color += (n - 0.5) * uGrain * (1.2 - luma * 0.8);
    }

    color *= uFade;

    // Ordered-ish dither kills banding in the huge smooth nebula gradients.
    float d = hash12(gl_FragCoord.xy * 1.7 + 11.3) - 0.5;
    color += d / 255.0;

    gl_FragColor = vec4(color, 1.0);
  }
`;

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

  private readonly prefilterMat: THREE.ShaderMaterial;
  private readonly downsampleMat: THREE.ShaderMaterial;
  private readonly upsampleMat: THREE.ShaderMaterial;
  private readonly godrayMat: THREE.ShaderMaterial;
  private readonly compositeMat: THREE.ShaderMaterial;

  private profile: QualityProfile;
  private width = 1;
  private height = 1;

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

    this.godrayTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      colorSpace: THREE.LinearSRGBColorSpace,
    });

    this.prefilterMat = makePassMaterial(PREFILTER_FRAG, {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: 1.05 },
      uKnee: { value: 0.62 },
      uClamp: { value: 42 },
    });

    this.downsampleMat = makePassMaterial(DOWNSAMPLE_FRAG, {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2() },
    });

    this.upsampleMat = makePassMaterial(UPSAMPLE_FRAG, {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 1.0 },
    }, { blending: THREE.AdditiveBlending, transparent: true });

    this.godrayMat = makePassMaterial(GODRAY_FRAG, {
      tScene: { value: null },
      tDepth: { value: null },
      uSun: { value: new THREE.Vector2(0.5, 0.5) },
      uDensity: { value: 0.72 },
      uDecay: { value: 0.955 },
      uWeight: { value: 0.62 },
      uVisible: { value: 0 },
      uSamples: { value: profile.godraySamples },
    });

    this.compositeMat = makePassMaterial(COMPOSITE_FRAG, {
      tScene: { value: null },
      tBloom: { value: null },
      tGodrays: { value: null },
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
      uGrain: { value: 0.035 },
      uDamage: { value: 0 },
      uFade: { value: 1 },
      uWarp: { value: 0 },
    });
  }

  setProfile(profile: QualityProfile): void {
    this.profile = profile;
    this.godrayMat.uniforms.uSamples.value = profile.godraySamples;
    this.compositeMat.uniforms.uBlurSamples.value = profile.motionBlurSamples;
    this.compositeMat.uniforms.uBloomStrength.value = profile.bloomStrength;
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.sceneTarget.setSize(this.width, this.height);
    this.sceneTarget.depthTexture?.image && (this.sceneTarget.depthTexture.image.width = this.width);
    if (this.sceneTarget.depthTexture?.image) this.sceneTarget.depthTexture.image.height = this.height;

    let w = this.width;
    let h = this.height;
    for (let i = 0; i < this.bloomTargets.length; i++) {
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      this.bloomTargets[i].setSize(w, h);
    }

    this.godrayTarget.setSize(Math.max(1, this.width >> 2), Math.max(1, this.height >> 2));
    this.compositeMat.uniforms.uResolution.value.set(this.width, this.height);
  }

  /** Applies the settings the player controls without disturbing the frame-level grade. */
  setFeatureFlags(flags: { motionBlur: boolean; grain: boolean; chromaticAberration: boolean }): void {
    this.compositeMat.uniforms.uBlurSamples.value = flags.motionBlur ? this.profile.motionBlurSamples : 0;
    this.compositeMat.uniforms.uGrain.value = flags.grain ? 0.035 : 0;
    this.compositeMat.userData.allowAberration = flags.chromaticAberration;
  }

  render(grade: GradeParams): void {
    const renderer = this.renderer;
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;

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

    this.quad.render(renderer, this.compositeMat, null);
    renderer.autoClear = prevAutoClear;
  }

  private renderBloom(): void {
    const renderer = this.renderer;
    const targets = this.bloomTargets;

    this.prefilterMat.uniforms.tDiffuse.value = this.sceneTarget.texture;
    this.prefilterMat.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
    this.quad.render(renderer, this.prefilterMat, targets[0]);

    for (let i = 1; i < targets.length; i++) {
      const src = targets[i - 1];
      this.downsampleMat.uniforms.tDiffuse.value = src.texture;
      this.downsampleMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this.quad.render(renderer, this.downsampleMat, targets[i]);
    }

    // Additive tent upsample back down the chain; each level widens the skirt.
    for (let i = targets.length - 1; i > 0; i--) {
      const src = targets[i];
      const dst = targets[i - 1];
      this.upsampleMat.uniforms.tDiffuse.value = src.texture;
      this.upsampleMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
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
    this.sceneTarget.dispose();
    this.sceneTarget.depthTexture?.dispose();
    for (const t of this.bloomTargets) t.dispose();
    this.godrayTarget.dispose();
    this.prefilterMat.dispose();
    this.downsampleMat.dispose();
    this.upsampleMat.dispose();
    this.godrayMat.dispose();
    this.compositeMat.dispose();
    this.quad.dispose();
  }
}
