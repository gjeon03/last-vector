import * as THREE from 'three';

const BODY_VERTEX = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vWorldNormal;
  varying vec3 vPosition;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vPosition = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const BODY_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec3 vNormal;
  varying vec3 vWorldNormal;
  varying vec3 vPosition;
  uniform vec3 uSunDir;
  uniform vec3 uDay;
  uniform vec3 uNight;
  uniform vec3 uLimb;
  uniform float uTime;
  uniform float uImpact;

  float hash(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
  }

  void main() {
    vec3 n = normalize(vWorldNormal);
    float light = smoothstep(-0.25, 0.7, dot(n, normalize(uSunDir)));
    float terrain = hash(floor(normalize(vPosition) * 42.0 + uTime * 0.018));
    vec3 col = mix(uNight, uDay, light * (0.75 + terrain * 0.25));
    float limb = pow(1.0 - abs(vNormal.z), 3.2);
    col += uLimb * limb * (0.22 + light * 0.38);
    vec3 impactAxis = normalize(vec3(0.32, 0.18, 0.93));
    float scar = smoothstep(0.975, 0.998, dot(normalize(vPosition), impactAxis));
    col += vec3(1.0, 0.24, 0.05) * scar * uImpact * 8.0;
    gl_FragColor = vec4(col, 1.0);
  }
`;

/** Far-scene ACHRA, guided moon and the impact bridge. No physical-body simulation. */
export class LastAscentCelestials {
  readonly object = new THREE.Group();
  readonly sunDirection = new THREE.Vector3(-0.32, 0.42, -0.85).normalize();

  private readonly achraMaterial: THREE.ShaderMaterial;
  private readonly moonMaterial: THREE.ShaderMaterial;
  private readonly atmosphereMaterial: THREE.MeshBasicMaterial;
  private readonly impactMaterial: THREE.MeshBasicMaterial;
  private readonly achra: THREE.Mesh;
  private readonly moon: THREE.Mesh;
  private readonly atmosphere: THREE.Mesh;
  private readonly impactBridge: THREE.Mesh;

  constructor() {
    const sphere = new THREE.SphereGeometry(1, 64, 40);
    this.achraMaterial = new THREE.ShaderMaterial({
      vertexShader: BODY_VERTEX,
      fragmentShader: BODY_FRAGMENT,
      uniforms: {
        uSunDir: { value: this.sunDirection },
        uDay: { value: new THREE.Color(0x2b6c78) },
        uNight: { value: new THREE.Color(0x030a15) },
        uLimb: { value: new THREE.Color(0x4de5ff) },
        uTime: { value: 0 },
        uImpact: { value: 1 },
      },
    });
    this.moonMaterial = new THREE.ShaderMaterial({
      vertexShader: BODY_VERTEX,
      fragmentShader: BODY_FRAGMENT,
      uniforms: {
        uSunDir: { value: this.sunDirection },
        uDay: { value: new THREE.Color(0x9e9387) },
        uNight: { value: new THREE.Color(0x151218) },
        uLimb: { value: new THREE.Color(0xffa35f) },
        uTime: { value: 0 },
        uImpact: { value: 0 },
      },
    });

    this.achra = new THREE.Mesh(sphere, this.achraMaterial);
    this.achra.scale.setScalar(18.5);
    this.achra.position.set(0, -24, -45);
    this.achra.rotation.set(0.2, -0.4, 0.05);

    this.moon = new THREE.Mesh(sphere.clone(), this.moonMaterial);
    this.moon.scale.setScalar(4.2);
    this.moon.position.set(12.5, -6, -42);

    this.atmosphereMaterial = new THREE.MeshBasicMaterial({
      color: 0x49d8ff,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
    });
    this.atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1, 48, 32),
      this.atmosphereMaterial,
    );
    this.atmosphere.position.copy(this.achra.position);
    this.atmosphere.scale.setScalar(19.25);

    this.impactMaterial = new THREE.MeshBasicMaterial({
      color: 0xff6938,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.impactBridge = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.75, 1, 12, 1, true),
      this.impactMaterial,
    );
    const impactPoint = new THREE.Vector3(6.5, -12, -42.5);
    const bridge = new THREE.Vector3().subVectors(this.moon.position, impactPoint);
    this.impactBridge.position.copy(impactPoint).addScaledVector(bridge, 0.5);
    this.impactBridge.scale.y = bridge.length();
    this.impactBridge.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      bridge.normalize(),
    );

    this.object.add(this.achra, this.atmosphere, this.moon, this.impactBridge);
  }

  update(time: number): void {
    this.achraMaterial.uniforms.uTime.value = time;
    this.moonMaterial.uniforms.uTime.value = time * 0.35;
    const pulse = 0.72 + Math.sin(time * 1.7) * 0.2 + Math.sin(time * 4.1) * 0.08;
    this.achraMaterial.uniforms.uImpact.value = pulse;
    this.impactMaterial.opacity = 0.27 + pulse * 0.18;
    this.atmosphereMaterial.opacity = 0.13 + pulse * 0.045;
  }

  dispose(): void {
    this.achra.geometry.dispose();
    this.moon.geometry.dispose();
    this.atmosphere.geometry.dispose();
    this.impactBridge.geometry.dispose();
    this.achraMaterial.dispose();
    this.moonMaterial.dispose();
    this.atmosphereMaterial.dispose();
    this.impactMaterial.dispose();
  }
}
