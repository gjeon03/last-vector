import * as THREE from 'three';

/**
 * Minimal full-screen pass plumbing. The vertex shader writes clip space directly and
 * ignores every matrix, so no camera transform can ever perturb a post-processing pass.
 */
export const FULLSCREEN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export class FullScreenQuad {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly mesh: THREE.Mesh;

  constructor() {
    const geometry = new THREE.PlaneGeometry(2, 2);
    this.mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  render(renderer: THREE.WebGLRenderer, material: THREE.Material, target: THREE.WebGLRenderTarget | null): void {
    this.mesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

export function makePassMaterial(
  fragmentShader: string,
  uniforms: Record<string, THREE.IUniform>,
  options: { blending?: THREE.Blending; transparent?: boolean } = {},
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    blending: options.blending ?? THREE.NoBlending,
    transparent: options.transparent ?? false,
  });
}
