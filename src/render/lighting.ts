import * as THREE from 'three';
import { PALETTE } from '../core/art.ts';

/**
 * One shading model for every solid surface in the sector — hull, rock, monolith, station.
 * Sharing it is what makes the scene read as a single lit space rather than a pile of assets.
 *
 * The model is deliberately simple: one directional key (the star), a two-tone hemisphere
 * ambient standing in for the nebula, GGX specular, and a fresnel rim. No IBL, no shadow
 * maps, no textures — but the rim and the coloured ambient do most of the work that an
 * expensive pipeline would, and it stays cheap enough to run at any resolution.
 */

export const GLSL_LIGHTING = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uSkyColor;
  uniform vec3 uGroundColor;
  uniform vec3 uRimColor;
  uniform float uRimPower;
  uniform float uExposureBias;
  uniform vec3 uHazeColor;
  uniform vec3 uHazeWarm;
  uniform float uHazeDensity;

  float distributionGGX(float ndh, float roughness) {
    float a = roughness * roughness;
    float a2 = a * a;
    float d = ndh * ndh * (a2 - 1.0) + 1.0;
    return a2 / max(3.14159265 * d * d, 1e-6);
  }

  float geometrySchlick(float ndv, float roughness) {
    float r = roughness + 1.0;
    float k = (r * r) / 8.0;
    return ndv / (ndv * (1.0 - k) + k);
  }

  vec3 fresnelSchlick(float cosTheta, vec3 f0) {
    return f0 + (1.0 - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
  }

  vec3 shadeSurface(vec3 N, vec3 V, vec3 albedo, float roughness, float metalness, float ao) {
    vec3 L = uSunDir;
    vec3 H = normalize(L + V);
    float ndl = max(dot(N, L), 0.0);
    float ndv = max(dot(N, V), 1e-4);
    float ndh = max(dot(N, H), 0.0);
    float vdh = max(dot(V, H), 0.0);

    vec3 f0 = mix(vec3(0.04), albedo, metalness);
    vec3 F = fresnelSchlick(vdh, f0);
    float D = distributionGGX(ndh, roughness);
    float G = geometrySchlick(ndl, roughness) * geometrySchlick(ndv, roughness);
    vec3 spec = (D * G * F) / max(4.0 * ndl * ndv, 1e-4);

    vec3 kd = (1.0 - F) * (1.0 - metalness);
    vec3 direct = (kd * albedo / 3.14159265 + spec) * uSunColor * ndl;

    // Hemisphere ambient keyed to the sky rather than a flat grey: the shadow side of every
    // object picks up the nebula, which is what stops dark surfaces going muddy.
    float hemi = N.y * 0.5 + 0.5;
    vec3 ambient = mix(uGroundColor, uSkyColor, hemi) * albedo * ao;

    // Backlight. When the star is behind an object from the camera's point of view, the
    // grazing edge of that object catches the light and burns — it is the single strongest
    // shape cue there is, and without it a backlit rock is just a hole cut out of the sky.
    // The term keys off the *view* direction against the light, not the surface normal, so it
    // peaks exactly when you are looking into the star past the object's silhouette.
    float fres = pow(1.0 - ndv, uRimPower);
    float backlight = pow(max(dot(-V, L), 0.0), 2.2);
    float sideLight = smoothstep(-0.35, 0.55, dot(N, L));
    vec3 rimLight = uRimColor * fres * (0.2 + sideLight * 0.5 + backlight * 4.2) * ao;

    return (direct + ambient + rimLight) * uExposureBias;
  }

  /**
   * Atmospheric perspective. There is no air in space, but there *is* dust and scattered
   * nebula light, and without a distance term every object in the frame sits at the same
   * apparent depth. This single mix is the strongest depth cue in the whole renderer: it
   * separates the rock two hundred metres away from the wreck nine kilometres out.
   */
  vec3 applyHaze(vec3 color, float distance, vec3 viewDir) {
    float t = 1.0 - exp(-distance * uHazeDensity);
    // Only genuinely bright emissives punch through; at 0.35 this term was strong enough to
    // cancel the haze on ordinary rock, which is what it exists to affect.
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    t *= 1.0 - clamp(luma * 0.12, 0.0, 0.3);
    // Warm toward the star, cold away from it.
    float toSun = max(dot(-viewDir, uSunDir), 0.0);
    vec3 haze = mix(uHazeColor, uHazeWarm, pow(toSun, 1.5));
    return mix(color, haze, clamp(t, 0.0, 1.0));
  }
`;

export interface LightingUniforms {
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uSkyColor: THREE.IUniform<THREE.Color>;
  uGroundColor: THREE.IUniform<THREE.Color>;
  uRimColor: THREE.IUniform<THREE.Color>;
  uRimPower: THREE.IUniform<number>;
  uExposureBias: THREE.IUniform<number>;
  uHazeColor: THREE.IUniform<THREE.Color>;
  uHazeWarm: THREE.IUniform<THREE.Color>;
  uHazeDensity: THREE.IUniform<number>;
}

/**
 * A single set of uniform objects is shared by reference across every material, so moving
 * the key light moves the whole sector at once.
 */
export function createLightingUniforms(sunDirection: THREE.Vector3): LightingUniforms {
  return {
    uSunDir: { value: sunDirection.clone().normalize() },
    // A hot star reads as near-white with a warm bias, not as orange paint. Saturating the
    // key light is what turned every rock in the field into terracotta.
    uSunColor: { value: new THREE.Color(0xffe2bd).multiplyScalar(2.7) },
    // Four times the old values. At 0.05/0.038 a rock's unlit side received about 0.004
    // linear — black by construction — which removed the entire midtone band from the image
    // and left every object reading as a hole cut in the sky rather than as a solid.
    uSkyColor: { value: new THREE.Color(PALETTE.nebulaTeal).multiplyScalar(0.14) },
    uGroundColor: { value: new THREE.Color(PALETTE.nebulaIndigo).multiplyScalar(0.1) },
    // The rim takes the star's colour, because that is what is lighting it.
    uRimColor: { value: new THREE.Color(0xffcf9e).multiplyScalar(0.5) },
    uRimPower: { value: 2.8 },
    uExposureBias: { value: 1 },
    uHazeColor: { value: new THREE.Color(0x121d33) },
    // Looking toward the star, the dust between you and a distant object scatters warm. A
    // single constant haze colour made far objects converge on near-black, so against a lit
    // nebula a six-kilometre rock had MORE contrast than a three-hundred-metre one and the
    // depth cue was not weak but inverted.
    uHazeWarm: { value: new THREE.Color(0x4a3526) },
    uHazeDensity: { value: 1 / 5600 },
  };
}

/** Merges the shared lighting uniforms into a material's own uniform block, by reference. */
export function withLighting(
  lighting: LightingUniforms,
  own: Record<string, THREE.IUniform>,
): Record<string, THREE.IUniform> {
  return { ...(lighting as unknown as Record<string, THREE.IUniform>), ...own };
}
