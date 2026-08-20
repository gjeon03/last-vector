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
  private readonly unitBoxGeometry: THREE.BoxGeometry;
  private readonly instrumentMaterial: THREE.MeshBasicMaterial;

  constructor() {
    const structure = this.material(0x090d12);
    const rail = this.material(0x24323d);
    const panel = this.material(0x101923);
    const shelf = this.material(0x1a2630);
    const recess = this.material(0x030609);
    const canopyHighlight = this.material(0x536674);
    const coolEdge = this.material(0x5d8b9d);
    const edge = this.material(0xa94f24);
    this.instrumentMaterial = this.material(0x6edcff, true);

    this.unitBoxGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.geometries.push(this.unitBoxGeometry);

    // The lower panel is split into a distant upper shelf, a nearer fascia, and the panel face.
    // Those three z planes are the depth cue the previous single quadrilateral could not supply.
    this.quad([
      new THREE.Vector3(-0.68, -0.36, -0.585),
      new THREE.Vector3(0.68, -0.36, -0.585),
      new THREE.Vector3(0.89, -0.84, -0.48),
      new THREE.Vector3(-0.89, -0.84, -0.48),
    ], panel, 100);
    this.quad([
      new THREE.Vector3(-0.6, -0.31, -0.79),
      new THREE.Vector3(-0.06, -0.31, -0.79),
      new THREE.Vector3(-0.075, -0.36, -0.585),
      new THREE.Vector3(-0.68, -0.36, -0.585),
    ], shelf, 101);
    this.quad([
      new THREE.Vector3(0.06, -0.31, -0.79),
      new THREE.Vector3(0.6, -0.31, -0.79),
      new THREE.Vector3(0.68, -0.36, -0.585),
      new THREE.Vector3(0.075, -0.36, -0.585),
    ], shelf, 101);
    this.quad([
      new THREE.Vector3(-0.06, -0.31, -0.795),
      new THREE.Vector3(0.06, -0.31, -0.795),
      new THREE.Vector3(0.075, -0.36, -0.59),
      new THREE.Vector3(-0.075, -0.36, -0.59),
    ], recess, 101);

    // The fascia repeats that left / recessed-centre / right rhythm instead of reading as one
    // broad overlay strip. Slightly splayed inner edges make the centre bay visibly inset.
    this.quad([
      new THREE.Vector3(-0.68, -0.36, -0.58),
      new THREE.Vector3(-0.07, -0.36, -0.58),
      new THREE.Vector3(-0.09, -0.405, -0.55),
      new THREE.Vector3(-0.65, -0.405, -0.55),
    ], rail, 102);
    this.quad([
      new THREE.Vector3(0.07, -0.36, -0.58),
      new THREE.Vector3(0.68, -0.36, -0.58),
      new THREE.Vector3(0.65, -0.405, -0.55),
      new THREE.Vector3(0.09, -0.405, -0.55),
    ], rail, 102);
    this.quad([
      new THREE.Vector3(-0.07, -0.36, -0.585),
      new THREE.Vector3(0.07, -0.36, -0.585),
      new THREE.Vector3(0.09, -0.405, -0.555),
      new THREE.Vector3(-0.09, -0.405, -0.555),
    ], recess, 103);

    // Fine AO seams make the shelf/fascia steps legible without another lighting pass. Cool trim
    // is deliberately short; it marks the mid-depth plane instead of outlining the whole panel.
    this.bar(new THREE.Vector3(-0.06, -0.31, -0.775), new THREE.Vector3(-0.075, -0.36, -0.57), 0.007, 0.014, recess, 104);
    this.bar(new THREE.Vector3(0.06, -0.31, -0.775), new THREE.Vector3(0.075, -0.36, -0.57), 0.007, 0.014, recess, 104);
    this.bar(new THREE.Vector3(-0.37, -0.31, -0.755), new THREE.Vector3(-0.19, -0.31, -0.755), 0.007, 0.014, coolEdge, 104);
    this.bar(new THREE.Vector3(0.19, -0.31, -0.755), new THREE.Vector3(0.37, -0.31, -0.755), 0.007, 0.014, coolEdge, 104);

    // Side wedges close the gap between the raked pillars and the lower panel. They remain below
    // the flight HUD columns and taper out of frame rather than boxing in the windshield.
    for (const side of [-1, 1]) {
      this.quad([
        new THREE.Vector3(side * 0.65, -0.28, -0.67),
        new THREE.Vector3(side * 0.87, -0.42, -0.53),
        new THREE.Vector3(side * 0.94, -0.86, -0.43),
        new THREE.Vector3(side * 0.69, -0.82, -0.5),
      ], panel, 100);
      this.bar(
        new THREE.Vector3(side * 0.66, -0.3, -0.62),
        new THREE.Vector3(side * 0.72, -0.7, -0.49),
        0.018,
        0.03,
        rail,
        103,
      );

      // A small raised side-console plate plus three physical controls establishes near-field
      // scale without reaching into either HUD column.
      this.box(
        new THREE.Vector3(side * 0.34, -0.3, -0.5),
        new THREE.Vector3(0.07, 0.04, 0.035),
        rail,
        107,
      );
      for (let i = -1; i <= 1; i++) {
        this.box(
          new THREE.Vector3(side * (0.34 + i * 0.018), -0.3, -0.475),
          new THREE.Vector3(0.009, 0.012, 0.014),
          i === 0 ? this.instrumentMaterial : edge,
          108,
        );
      }
    }

    // Three nested rails create a real canopy section: a broad near structural member, a smaller
    // recessed liner and a fine leading highlight. The centre stays entirely post-free.
    const outerLeftTop = new THREE.Vector3(-0.475, 0.39, -0.62);
    const outerRightTop = new THREE.Vector3(0.475, 0.39, -0.62);
    const outerLeftBottom = new THREE.Vector3(-0.46, -0.27, -0.6);
    const outerRightBottom = new THREE.Vector3(0.46, -0.27, -0.6);
    this.bar(outerLeftTop, outerRightTop, 0.04, 0.09, structure, 103);
    this.bar(outerLeftTop, outerLeftBottom, 0.01, 0.09, structure, 103);
    this.bar(outerRightTop, outerRightBottom, 0.01, 0.09, structure, 103);

    // Each depth layer is x-compensated to land on the same thin screen-edge footprint. Without
    // that compensation, the far liner projected inward across both HUD columns.
    this.bar(new THREE.Vector3(-0.535, 0.42, -0.7), new THREE.Vector3(0.535, 0.42, -0.7), 0.024, 0.05, rail, 104);
    this.bar(new THREE.Vector3(-0.535, 0.42, -0.7), new THREE.Vector3(-0.52, -0.27, -0.68), 0.008, 0.05, rail, 104);
    this.bar(new THREE.Vector3(0.535, 0.42, -0.7), new THREE.Vector3(0.52, -0.27, -0.68), 0.008, 0.05, rail, 104);

    this.bar(new THREE.Vector3(-0.43, 0.375, -0.56), new THREE.Vector3(0.43, 0.375, -0.56), 0.009, 0.025, canopyHighlight, 105);
    this.bar(new THREE.Vector3(-0.43, 0.375, -0.56), new THREE.Vector3(-0.421, -0.25, -0.55), 0.006, 0.025, canopyHighlight, 105);
    this.bar(new THREE.Vector3(0.43, 0.375, -0.56), new THREE.Vector3(0.421, -0.25, -0.55), 0.006, 0.025, canopyHighlight, 105);

    // One joint block per corner bridges all three projected rail layers, removing the clipped,
    // overlapping tips that previously read as three unrelated bars.
    this.box(new THREE.Vector3(-0.444, 0.39, -0.58), new THREE.Vector3(0.014, 0.05, 0.07), structure, 106);
    this.box(new THREE.Vector3(0.444, 0.39, -0.58), new THREE.Vector3(0.014, 0.05, 0.07), structure, 106);
    this.box(new THREE.Vector3(-0.405, 0.372, -0.535), new THREE.Vector3(0.006, 0.03, 0.012), coolEdge, 107);
    this.box(new THREE.Vector3(0.405, 0.372, -0.535), new THREE.Vector3(0.006, 0.03, 0.012), coolEdge, 107);

    // The glareshield gets a distant attachment seam, a dark joint and a nearer physical lip.
    // Only two short lip sections carry warning colour, avoiding another full-width flat band.
    this.bar(new THREE.Vector3(-0.59, -0.31, -0.77), new THREE.Vector3(0.59, -0.31, -0.77), 0.018, 0.025, rail, 103);
    this.bar(new THREE.Vector3(-0.66, -0.36, -0.575), new THREE.Vector3(0.66, -0.36, -0.575), 0.034, 0.04, structure, 105);
    this.bar(new THREE.Vector3(-0.65, -0.36, -0.535), new THREE.Vector3(0.65, -0.36, -0.535), 0.014, 0.03, rail, 106);
    this.bar(new THREE.Vector3(-0.63, -0.392, -0.53), new THREE.Vector3(0.63, -0.392, -0.53), 0.009, 0.012, recess, 107);
    this.bar(new THREE.Vector3(-0.57, -0.36, -0.515), new THREE.Vector3(-0.45, -0.36, -0.515), 0.01, 0.018, edge, 107);
    this.bar(new THREE.Vector3(0.45, -0.36, -0.515), new THREE.Vector3(0.57, -0.36, -0.515), 0.01, 0.018, edge, 107);

    // Two compact instrument pods use physical bezel depth, a black recessed well and a separate
    // emissive readout plane. Their outer/lower placement avoids the central 40%, the radio line,
    // both HUD columns and the centre course ruler.
    for (const x of [-0.26, 0.26]) {
      this.box(new THREE.Vector3(x, -0.365, -0.54), new THREE.Vector3(0.12, 0.045, 0.04), edge, 110);
      this.box(new THREE.Vector3(x, -0.365, -0.515), new THREE.Vector3(0.097, 0.029, 0.012), recess, 111);

      const displayGeometry = new THREE.PlaneGeometry(0.065, 0.012);
      this.geometries.push(displayGeometry);
      const display = this.mesh(displayGeometry, this.instrumentMaterial, 112);
      display.position.set(x, -0.365, -0.505);
    }

    // Keep the radio backing deliberately dark while adding a complete pair of near-field grips
    // below it. Their outer placement clears the centre ruler horizontally, and their low screen
    // position clears the radio vertically.
    this.quad([
      new THREE.Vector3(-0.65, -0.32, -0.6),
      new THREE.Vector3(-0.18, -0.32, -0.6),
      new THREE.Vector3(-0.22, -0.44, -0.53),
      new THREE.Vector3(-0.78, -0.44, -0.53),
    ], recess, 109);
    for (const side of [-1, 1]) {
      this.bar(
        new THREE.Vector3(side * 0.28, -0.34, -0.47),
        new THREE.Vector3(side * 0.28, -0.3, -0.45),
        0.014,
        0.026,
        rail,
        113,
      );
      this.box(
        new THREE.Vector3(side * 0.28, -0.335, -0.455),
        new THREE.Vector3(0.025, 0.012, 0.018),
        edge,
        114,
      );
      this.box(
        new THREE.Vector3(side * 0.28, -0.295, -0.42),
        new THREE.Vector3(0.035, 0.018, 0.035),
        rail,
        114,
      );
      this.box(
        new THREE.Vector3(side * 0.265, -0.28, -0.398),
        new THREE.Vector3(0.018, 0.009, 0.008),
        coolEdge,
        115,
      );
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

  private quad(points: readonly THREE.Vector3[], material: THREE.Material, renderOrder: number): THREE.Mesh {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.flatMap((point) => point.toArray()), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.computeVertexNormals();
    this.geometries.push(geometry);
    return this.mesh(geometry, material, renderOrder);
  }

  private box(
    position: THREE.Vector3,
    scale: THREE.Vector3,
    material: THREE.Material,
    renderOrder: number,
  ): THREE.Mesh {
    const mesh = this.mesh(this.unitBoxGeometry, material, renderOrder);
    mesh.position.copy(position);
    mesh.scale.copy(scale);
    return mesh;
  }

  private bar(
    from: THREE.Vector3,
    to: THREE.Vector3,
    width: number,
    depth: number,
    material: THREE.Material,
    renderOrder: number,
  ): void {
    const delta = to.clone().sub(from);
    const length = delta.length();
    const mesh = this.mesh(this.unitBoxGeometry, material, renderOrder);
    mesh.position.copy(from).add(to).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
    mesh.scale.set(width, length, depth);
  }
}
