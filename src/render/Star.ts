import * as THREE from 'three';
import { PALETTE } from '../core/art.ts';

/**
 * ACHRA — the dying star the drift orbits. It is the single key light of the whole game, so
 * it is drawn as a real emissive disc with limb darkening, a wide corona, and anamorphic
 * flare bars. Everything else (shafts, bloom, exposure) keys off it.
 */

const STAR_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform vec3 uCore;
  uniform vec3 uGlow;
  uniform vec3 uRim;
  uniform float uTime;
  uniform float uDiscRadius;
  uniform float uIntensity;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453);
  }

  void main() {
    vec2 d = (vUv - 0.5) * 2.0;
    float r = length(d);
    if (r > 1.0) discard;

    // Photosphere: hard-edged with limb darkening so it reads as a body, not a glow sprite.
    float disc = 1.0 - smoothstep(uDiscRadius * 0.94, uDiscRadius, r);
    float limb = sqrt(max(0.0, 1.0 - pow(min(r / uDiscRadius, 1.0), 2.0)));
    vec3 col = mix(uRim, uCore, pow(limb, 0.42)) * disc * 9.0;

    // Corona: two exponentials, the wide one carrying most of the scattered light.
    float inner = exp(-pow(max(r - uDiscRadius, 0.0) * 26.0, 0.9));
    float outer = exp(-pow(max(r - uDiscRadius, 0.0) * 4.2, 0.75));
    col += uGlow * (inner * 2.6 + outer * 0.85);

    // Anamorphic bar + a softer vertical companion. Subtle: the bloom chain amplifies these.
    float bar = exp(-abs(d.y) * 52.0) * exp(-abs(d.x) * 1.6);
    float barV = exp(-abs(d.x) * 84.0) * exp(-abs(d.y) * 2.6);
    col += uGlow * bar * 1.35;
    col += mix(uGlow, uCore, 0.4) * barV * 0.5;

    // Slow granulation on the disc keeps the star from looking like a decal.
    float gran = hash(floor(d * 34.0) + floor(uTime * 0.7));
    col *= 1.0 + disc * (gran - 0.5) * 0.06;

    float alpha = clamp(disc + inner * 0.9 + outer * 0.55 + bar * 0.5 + barV * 0.25, 0.0, 1.0);
    gl_FragColor = vec4(col * uIntensity, alpha);
  }
`;

const STAR_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export class Star {
  readonly object: THREE.Object3D;
  readonly direction = new THREE.Vector3();
  private readonly sprite: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  /**
   * @param distance   radius in far-scene units at which the billboard sits
   * @param angularRadius  apparent radius of the photosphere, in radians
   */
  constructor(distance: number, angularRadius: number, direction: THREE.Vector3) {
    this.direction.copy(direction).normalize();

    // The quad is sized for the corona; the photosphere occupies `uDiscRadius` of it.
    const coronaFactor = 11;
    const quadHalf = Math.tan(angularRadius * coronaFactor) * distance;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uCore: { value: new THREE.Color(PALETTE.starCore) },
        uGlow: { value: new THREE.Color(PALETTE.starGlow) },
        uRim: { value: new THREE.Color(PALETTE.starRim) },
        uTime: { value: 0 },
        uDiscRadius: { value: 1 / coronaFactor },
        uIntensity: { value: 1 },
      },
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });

    this.sprite = new THREE.Mesh(new THREE.PlaneGeometry(quadHalf * 2, quadHalf * 2), this.material);
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = -90;
    this.sprite.position.copy(this.direction).multiplyScalar(distance);

    this.object = new THREE.Object3D();
    this.object.add(this.sprite);
  }

  update(time: number, camera: THREE.Camera): void {
    this.material.uniforms.uTime.value = time;
    // Billboard against the camera's own orientation rather than lookAt, which keeps the
    // anamorphic bar horizontal on screen no matter how the ship rolls.
    this.sprite.quaternion.copy(camera.quaternion);
  }

  setIntensity(value: number): void {
    this.material.uniforms.uIntensity.value = value;
  }

  dispose(): void {
    this.sprite.geometry.dispose();
    this.material.dispose();
  }
}
