import * as THREE from 'three';

const REFERENCE_FOV = 76;
const REFERENCE_TAN = Math.tan(THREE.MathUtils.degToRad(REFERENCE_FOV * 0.5));

/**
 * A deliberately sparse pilot-eye interior.
 *
 * Everything is authored in camera-local space and copied onto the active camera pose each
 * frame. The centre of the windshield stays completely open: the dashboard occupies only the
 * bottom quarter and the canopy members hug the edge, so the world-space gate markers and the
 * HTML HUD remain readable at the same time.
 */
export class CockpitModel {
  readonly object = new THREE.Group();

  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly instrumentMaterial: THREE.MeshBasicMaterial;

  constructor() {
    const structure = this.material(0x090d12);
    const panel = this.material(0x101922);
    const edge = this.material(0xc86f2c);
    this.instrumentMaterial = this.material(0x6edcff, true);

    const dashboardGeometry = new THREE.BufferGeometry();
    dashboardGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -0.64, -0.31, -0.72,
       0.64, -0.31, -0.72,
       0.86, -0.82, -0.58,
      -0.86, -0.82, -0.58,
    ], 3));
    dashboardGeometry.setIndex([0, 1, 2, 0, 2, 3]);
    dashboardGeometry.computeVertexNormals();
    this.geometries.push(dashboardGeometry);
    this.mesh(dashboardGeometry, panel, 100);

    // Canopy bow and two raked pillars. Their narrow silhouette frames motion without placing a
    // bar over the flight path or over the central reticle.
    this.bar(new THREE.Vector3(-0.5, 0.47, -0.72), new THREE.Vector3(0.5, 0.47, -0.72), 0.035, structure);
    this.bar(new THREE.Vector3(-0.5, 0.47, -0.72), new THREE.Vector3(-0.61, -0.3, -0.72), 0.045, structure);
    this.bar(new THREE.Vector3(0.5, 0.47, -0.72), new THREE.Vector3(0.61, -0.3, -0.72), 0.045, structure);
    this.bar(new THREE.Vector3(-0.62, -0.3, -0.7), new THREE.Vector3(0.62, -0.3, -0.7), 0.032, edge);

    // Two low, framed instrument slits suggest depth and state without duplicating the real HUD.
    for (const x of [-0.15, 0.15]) {
      const bezelGeometry = new THREE.PlaneGeometry(0.24, 0.075);
      const insetGeometry = new THREE.PlaneGeometry(0.21, 0.052);
      const displayGeometry = new THREE.PlaneGeometry(0.15, 0.016);
      this.geometries.push(bezelGeometry, insetGeometry, displayGeometry);

      const bezel = this.mesh(bezelGeometry, edge, 102);
      // Inboard and low: clear of the radio transcript at lower left and above the course ruler.
      bezel.position.set(x, -0.44, -0.675);
      const inset = this.mesh(insetGeometry, structure, 103);
      inset.position.copy(bezel.position);
      const display = this.mesh(displayGeometry, this.instrumentMaterial, 104);
      display.position.copy(bezel.position);
    }

    this.object.visible = false;
  }

  setVisible(visible: boolean): void {
    this.object.visible = visible;
  }

  update(camera: THREE.PerspectiveCamera, time: number, boost: number): void {
    this.object.position.copy(camera.position);
    this.object.quaternion.copy(camera.quaternion);
    // Keep the authored frame in the same SCREEN space across every supported lens. At a fixed
    // camera-local depth, projected x/y are divided by tan(fov / 2), so multiplying both axes by
    // that value cancels the lens change. X additionally follows aspect to keep the pillars at
    // the side edges on 4:3, 16:9 and ultrawide displays. Z deliberately stays fixed so the
    // cockpit never crosses the near plane at either end of the 60-100 degree settings range.
    const fovScale = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) / REFERENCE_TAN;
    this.object.scale.set(camera.aspect * fovScale, fovScale, 1);
    this.instrumentMaterial.opacity = 0.58 + boost * 0.24 + Math.sin(time * 3.2) * 0.06;
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
  }

  private material(color: number, emissiveOverlay = false): THREE.MeshBasicMaterial {
    const material = new THREE.MeshBasicMaterial({
      color,
      // Even the visually solid pieces use Three's transparent render list so renderOrder 100+
      // places the cockpit after every world-space glow/trail/dust pass. Alpha remains 1 for
      // those pieces, making this a deterministic final interior overlay rather than translucency.
      transparent: true,
      opacity: emissiveOverlay ? 0.65 : 1,
      depthTest: false,
      // Solid cockpit pieces render after world opaques and must then populate depth so later
      // post-processing sees an interior surface. The emissive readout remains a non-writing
      // overlay on top of its bezel.
      depthWrite: !emissiveOverlay,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    this.materials.push(material);
    return material;
  }

  private mesh(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    renderOrder: number,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = renderOrder;
    mesh.frustumCulled = false;
    this.object.add(mesh);
    return mesh;
  }

  private bar(
    from: THREE.Vector3,
    to: THREE.Vector3,
    width: number,
    material: THREE.Material,
  ): void {
    const delta = to.clone().sub(from);
    const geometry = new THREE.BoxGeometry(width, delta.length(), width);
    this.geometries.push(geometry);
    const mesh = this.mesh(geometry, material, 101);
    mesh.position.copy(from).add(to).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
  }
}
