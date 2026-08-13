import * as THREE from 'three';

/**
 * Engine wake. A camera-facing ribbon built from a ring buffer of past nozzle positions.
 *
 * The plume shows *thrust*; the trail shows *the path you actually flew*. That distinction is
 * what makes a hard turn legible: the nose points one way, the ribbon arcs behind showing
 * where the ship has really been, and the gap between them is the drift the flight model is
 * simulating. Without it, fast turns read as the world rotating around a static ship.
 */

const TRAIL_VERT = /* glsl */ `
  attribute float aAge;
  attribute float aSide;
  varying float vAge;
  varying float vSide;
  void main() {
    vAge = aAge;
    vSide = aSide;
    gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
  }
`;

const TRAIL_FRAG = /* glsl */ `
  precision highp float;
  varying float vAge;
  varying float vSide;
  uniform vec3 uNear;
  uniform vec3 uFar;
  uniform float uIntensity;

  void main() {
    // vAge runs 0 at the nozzle to 1 at the tail.
    float across = 1.0 - abs(vSide);
    float body = pow(across, 1.6);
    float fade = pow(1.0 - vAge, 2.1);
    vec3 col = mix(uNear, uFar, vAge);
    float a = body * fade * uIntensity;
    gl_FragColor = vec4(col * a * 1.15, a * 0.8);
  }
`;

export interface TrailOptions {
  /** Number of recorded path samples. */
  capacity: number;
  /** Ribbon half-width at the nozzle, metres. */
  width: number;
  nearColor: THREE.Color;
  farColor: THREE.Color;
}

export class Trail {
  readonly object: THREE.Mesh;

  private readonly capacity: number;
  private readonly width: number;
  private readonly points: THREE.Vector3[] = [];
  private readonly positions: Float32Array;
  private readonly ages: Float32Array;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;

  private count = 0;
  private head = 0;
  private readonly segment = new THREE.Vector3();
  private readonly toCamera = new THREE.Vector3();
  private readonly side = new THREE.Vector3();

  constructor(options: TrailOptions) {
    this.capacity = options.capacity;
    this.width = options.width;

    for (let i = 0; i < this.capacity; i++) this.points.push(new THREE.Vector3());

    this.positions = new Float32Array(this.capacity * 2 * 3);
    this.ages = new Float32Array(this.capacity * 2);
    const sides = new Float32Array(this.capacity * 2);
    const indices: number[] = [];
    for (let i = 0; i < this.capacity; i++) {
      sides[i * 2] = -1;
      sides[i * 2 + 1] = 1;
      if (i < this.capacity - 1) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }

    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aAge', new THREE.BufferAttribute(this.ages, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aSide', new THREE.BufferAttribute(sides, 1));
    this.geometry.setIndex(indices);
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uNear: { value: options.nearColor.clone() },
        uFar: { value: options.farColor.clone() },
        uIntensity: { value: 0 },
      },
      vertexShader: TRAIL_VERT,
      fragmentShader: TRAIL_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });

    this.object = new THREE.Mesh(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 9;
  }

  /** Drops the whole ribbon; used when the ship is teleported so it does not smear across the map. */
  reset(): void {
    this.count = 0;
    this.head = 0;
    this.geometry.setDrawRange(0, 0);
  }

  /**
   * @param intensity 0..1 overall brightness; 0 stops recording and lets the tail decay.
   * @param widthScale multiplies the ribbon width, e.g. wider under boost.
   */
  update(nozzleWorld: THREE.Vector3, cameraPosition: THREE.Vector3, intensity: number, widthScale: number): void {
    this.material.uniforms.uIntensity.value = intensity;

    this.head = (this.head + 1) % this.capacity;
    this.points[this.head].copy(nozzleWorld);
    if (this.count < this.capacity) this.count++;

    if (this.count < 3) {
      this.geometry.setDrawRange(0, 0);
      return;
    }

    // Walk newest -> oldest so index 0 is always the nozzle end and the age ramp is stable.
    for (let i = 0; i < this.count; i++) {
      const index = (this.head - i + this.capacity * 2) % this.capacity;
      const point = this.points[index];
      const nextIndex = (this.head - Math.min(i + 1, this.count - 1) + this.capacity * 2) % this.capacity;
      this.segment.copy(this.points[nextIndex]).sub(point);
      if (this.segment.lengthSq() < 1e-6) this.segment.set(0, 0, 1);

      this.toCamera.copy(cameraPosition).sub(point);
      this.side.crossVectors(this.segment, this.toCamera);
      const len = this.side.length();
      if (len < 1e-6) this.side.set(1, 0, 0);
      else this.side.divideScalar(len);

      const age = i / (this.count - 1);
      // Taper: widest just behind the nozzle, pinching to nothing at the tail.
      const w = this.width * widthScale * (0.35 + 0.65 * Math.sin(Math.min(1, age * 3.2) * Math.PI * 0.5)) * (1 - age * 0.85);

      const base = i * 6;
      this.positions[base] = point.x - this.side.x * w;
      this.positions[base + 1] = point.y - this.side.y * w;
      this.positions[base + 2] = point.z - this.side.z * w;
      this.positions[base + 3] = point.x + this.side.x * w;
      this.positions[base + 4] = point.y + this.side.y * w;
      this.positions[base + 5] = point.z + this.side.z * w;

      this.ages[i * 2] = age;
      this.ages[i * 2 + 1] = age;
    }

    (this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.aAge as THREE.BufferAttribute).needsUpdate = true;
    this.geometry.setDrawRange(0, (this.count - 1) * 6);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
