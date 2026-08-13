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

    // A rim keyed to the star direction, so silhouettes separate from the background even
    // when a surface is facing away from the light.
    float rim = pow(1.0 - ndv, uRimPower) * (0.35 + 0.65 * smoothstep(-0.6, 0.4, dot(N, L)));
    vec3 rimLight = uRimColor * rim * ao;

    return (direct + ambient + rimLight) * uExposureBias;
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
}

/**
 * A single set of uniform objects is shared by reference across every material, so moving
 * the key light moves the whole sector at once.
 */
export function createLightingUniforms(sunDirection: THREE.Vector3): LightingUniforms {
  return {
    uSunDir: { value: sunDirection.clone().normalize() },
    uSunColor: { value: new THREE.Color(PALETTE.starGlow).multiplyScalar(3.1) },
    uSkyColor: { value: new THREE.Color(PALETTE.nebulaTeal).multiplyScalar(0.062) },
    uGroundColor: { value: new THREE.Color(PALETTE.nebulaIndigo).multiplyScalar(0.05) },
    uRimColor: { value: new THREE.Color(PALETTE.starRim).multiplyScalar(0.34) },
    uRimPower: { value: 3.1 },
    uExposureBias: { value: 1 },
  };
}

/** Merges the shared lighting uniforms into a material's own uniform block, by reference. */
export function withLighting(
  lighting: LightingUniforms,
  own: Record<string, THREE.IUniform>,
): Record<string, THREE.IUniform> {
  return { ...(lighting as unknown as Record<string, THREE.IUniform>), ...own };
}
