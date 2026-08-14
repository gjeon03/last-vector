/**
 * Screen-space ambient occlusion.
 *
 * The renderer had no occlusion and no shadowing of any kind. Form on a hard-surface object is
 * read almost entirely from the dark that collects where two planes meet; without it a
 * diffuse + specular + rim model can only vary value with surface normal, and a ship built from
 * large flat panels has very few distinct normals — so the airframe collapses to a single tone
 * and reads as a chalk maquette rather than a machine. Two independent reviewers landed on this
 * as the single biggest thing holding the image back.
 *
 * Normals are reconstructed from the depth buffer rather than carried in a G-buffer, because the
 * pipeline is forward-rendered and adding an MRT normal target would touch every material. The
 * cost is a slightly noisier normal at depth discontinuities, which the blur removes.
 */

import * as THREE from 'three';

export const SSAO_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D tDepth;
  uniform mat4 uProjection;
  uniform mat4 uInverseProjection;
  uniform vec2 uResolution;
  uniform float uRadius;
  uniform float uBias;
  uniform float uIntensity;
  uniform int uSamples;
  // See PostFX: dynamic resolution is a viewport change, so a viewport uv must be scaled into
  // texture space before every fetch. The NDC maths below stays in viewport space.
  uniform vec2 uSrcScale;
  uniform vec2 uSrcMax;
  vec2 srcUv(vec2 uv) { return min(uv * uSrcScale, uSrcMax); }

  const int MAX_SAMPLES = 16;
  // A fixed hemisphere kernel, weighted toward the origin so near-field contact darkening —
  // the wing root, the intake mouth, the socket a pylon sits in — dominates over broad shading.
  const vec3 KERNEL[MAX_SAMPLES] = vec3[MAX_SAMPLES](
    vec3( 0.2024,  0.8410,  0.2411), vec3(-0.5090,  0.3200,  0.4460),
    vec3( 0.6510, -0.2280,  0.3120), vec3(-0.2340, -0.6620,  0.2870),
    vec3( 0.0890,  0.1230,  0.7120), vec3(-0.7010,  0.1010,  0.2050),
    vec3( 0.4420,  0.5510,  0.1980), vec3(-0.1180, -0.2270,  0.6410),
    vec3( 0.3310, -0.5010,  0.4210), vec3(-0.4520,  0.6120,  0.1520),
    vec3( 0.7220,  0.2010,  0.1710), vec3(-0.0910, -0.7910,  0.2210),
    vec3( 0.1520,  0.3120,  0.5810), vec3(-0.6120, -0.3010,  0.3320),
    vec3( 0.5120, -0.1010,  0.5120), vec3(-0.2010,  0.4620,  0.4720)
  );

  vec3 viewPosition(vec2 uv, float depth) {
    vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 view = uInverseProjection * ndc;
    return view.xyz / view.w;
  }

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main() {
    float depth = texture2D(tDepth, srcUv(vUv)).r;
    // The sky is at the far plane and must not be occluded — the background is a cube map that
    // is nowhere near any geometry.
    if (depth >= 0.9999) {
      gl_FragColor = vec4(1.0);
      return;
    }

    vec3 P = viewPosition(vUv, depth);
    // Reconstructed from screen-space derivatives of the position. Cheaper than a normal buffer
    // and exact except across depth discontinuities, which the blur pass cleans up.
    vec3 N = normalize(cross(dFdx(P), dFdy(P)));

    // Per-pixel rotation of the kernel, so the sampling pattern becomes noise rather than a
    // repeating rosette — a fixed kernel produces visible banding on curved surfaces.
    float angle = hash12(gl_FragCoord.xy) * 6.2831853;
    float s = sin(angle);
    float c = cos(angle);
    vec3 randomVec = normalize(vec3(c, s, 0.0));
    vec3 tangent = normalize(randomVec - N * dot(randomVec, N));
    vec3 bitangent = cross(N, tangent);
    mat3 TBN = mat3(tangent, bitangent, N);

    float occlusion = 0.0;
    for (int i = 0; i < MAX_SAMPLES; i++) {
      if (i >= uSamples) break;
      vec3 samplePos = P + (TBN * KERNEL[i]) * uRadius;

      vec4 offset = uProjection * vec4(samplePos, 1.0);
      offset.xyz /= offset.w;
      vec2 sampleUv = offset.xy * 0.5 + 0.5;
      if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) continue;

      float sampleDepth = texture2D(tDepth, srcUv(sampleUv)).r;
      if (sampleDepth >= 0.9999) continue;
      float sceneZ = viewPosition(sampleUv, sampleDepth).z;

      // View space is right-handed with -Z forward, so a LARGER z is nearer the camera.
      if (sceneZ >= samplePos.z + uBias) {
        // Without the range check a distant surface behind a silhouette edge would darken the
        // foreground, producing a halo around every object.
        float rangeCheck = smoothstep(0.0, 1.0, uRadius / max(abs(P.z - sceneZ), 1e-4));
        occlusion += rangeCheck;
      }
    }

    float ao = 1.0 - (occlusion / float(uSamples)) * uIntensity;
    gl_FragColor = vec4(clamp(ao, 0.0, 1.0), 0.0, 0.0, 1.0);
  }
`;

export const SSAO_BLUR_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tAO;
  uniform vec2 uTexel;
  uniform vec2 uSrcScale;
  uniform vec2 uSrcMax;
  vec2 srcUv(vec2 uv) { return min(uv * uSrcScale, uSrcMax); }

  // A plain 4x4 box. The per-pixel kernel rotation turns the AO into high-frequency noise by
  // design, and a box of exactly the rotation period is what turns it back into shading.
  void main() {
    float sum = 0.0;
    for (int x = -2; x < 2; x++) {
      for (int y = -2; y < 2; y++) {
        sum += texture2D(tAO, srcUv(vUv + vec2(float(x), float(y)) * uTexel)).r;
      }
    }
    gl_FragColor = vec4(sum / 16.0, 0.0, 0.0, 1.0);
  }
`;

export interface SsaoQuality {
  /** 0 disables the pass entirely. */
  samples: number;
  /** World-space radius in metres. */
  radius: number;
  intensity: number;
}

export const SSAO_PROFILES: Record<'low' | 'medium' | 'high' | 'ultra', SsaoQuality> = {
  low: { samples: 0, radius: 3, intensity: 0 },
  medium: { samples: 8, radius: 3.2, intensity: 0.85 },
  high: { samples: 12, radius: 3.6, intensity: 0.95 },
  ultra: { samples: 16, radius: 4.0, intensity: 1.0 },
};

export function createSsaoUniforms(): Record<string, THREE.IUniform> {
  return {
    tDepth: { value: null },
    uProjection: { value: new THREE.Matrix4() },
    uInverseProjection: { value: new THREE.Matrix4() },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uRadius: { value: 3.6 },
    uBias: { value: 0.035 },
    uIntensity: { value: 0.95 },
    uSamples: { value: 12 },
  };
}
