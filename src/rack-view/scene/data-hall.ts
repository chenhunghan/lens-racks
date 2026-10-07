import {
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  type Group,
  InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  type ShaderMaterial,
  SRGBColorSpace,
  type Vector3,
} from "three";
import { Reflector } from "three/addons/objects/Reflector.js";
import { PLINTH, RACK_D, RACK_H, RACK_UNITS, RACK_W, type RackGeometries, U } from "./geometry";
import { LedField, LedMode } from "./instance-pool";
import { type LensTheme, ledOf } from "./lens-theme";
import { fitText, LabelCanvas, UI_FONT } from "./textures";

// The hall around the cluster, without end. The cluster's racks stand under a plate with
// its name; other tenants' racks continue its rows and fill the rows behind and beyond,
// as far as the haze lets anyone see. They are a lattice laid around the camera and
// re-laid as it moves, each position always showing the same rack, so the hall seems
// endless at the cost of a fixed number of simple racks. A ceiling of panels over the
// aisles, a polished floor. Everything here is scenery: none of it is picked or carries data.

export interface ClusterBlock {
  readonly rowMinX: number; // the racks of the front row: the lattice's origin, and the plate's place
  readonly rowMaxX: number;
  readonly minX: number; // the cluster's block, network core included: no scenery inside it
  readonly maxX: number;
  readonly rowZs: readonly number[]; // rows of the cluster, front to back
  readonly aisle: number; // depth of the aisle in front of each row
}

export interface SolidBox {
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
  readonly top: number;
}

export interface DataHallHost {
  readonly parent: Group;
  readonly geometries: RackGeometries;
}

export const CEILING = 3.9;
// Open floor in front of the cluster, where the camera stands to look at it.
export const CORRIDOR = 9;
const REACH_X = 22; // how far around the camera the lattice is laid
const REACH_Z = 24;
const RELAY_CELL = 3; // the camera moves this far before the lattice is laid again
const CROSS_AISLE = 1.6;
const CROSS_EVERY = 14; // racks between cross aisles
const FACE_VARIANTS = 3;
const MAX_RACKS = 1400;
const LEDS_PER_RACK = 10;
const PLANE = 120; // floor, ceiling and mirror: big squares that follow the camera
const PLATE_W = 0.7;
const PLATE_H = 0.13;
const PLATE_LIFT = 0.29; // posts lift the plate clear of the racks' nameplates
const TROFFER_PITCH = 2.4;

const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;

  return seed / 4294967296;
};

// The same rack at the same place, every time it is laid.
const cellSeed = (i: number, k: number) => ((Math.imul(i, 73856093) ^ Math.imul(k, 19349663)) >>> 0) || 1;

// The front of a rack full of someone else's servers: 1U and 2U boxes, drive bays,
// vents, a few blanks. Drawn once per variant.
const drawServerFace = (seed: number) => {
  const W = 256;
  const H = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const random = rng(seed);
  const unit = H / RACK_UNITS;
  ctx.fillStyle = "#0b0d10";
  ctx.fillRect(0, 0, W, H);

  for (let u = 0; u < RACK_UNITS;) {
    const roll = random();
    const height = roll < 0.55 ? 1 : roll < 0.85 ? 2 : roll < 0.95 ? 4 : 1;
    const y = H - (u + height) * unit;
    const blank = random() < 0.12;
    const shade = 30 + Math.floor(random() * 22);
    ctx.fillStyle = blank ? "#15181c" : `rgb(${shade},${shade + 3},${shade + 8})`;
    ctx.fillRect(8, y + 1, W - 16, height * unit - 2);

    if (!blank) {
      // Drive bays or vents across the front.
      const bays = height >= 2 ? 12 : 8;

      for (let b = 0; b < bays; b++) {
        const bx = 40 + b * ((W - 70) / bays);
        ctx.fillStyle = random() < 0.5 ? "#1c2026" : "#262b32";
        ctx.fillRect(bx, y + 4, (W - 70) / bays - 3, height * unit - 8);
      }

      ctx.fillStyle = "#596170";
      ctx.fillRect(14, y + 4, 18, height * unit - 8);
    }

    u += height;
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;

  return texture;
};

export class DataHall {
  private readonly root = new Object3D();
  private readonly materials: Material[] = [];
  private readonly faceTextures = Array.from({ length: FACE_VARIANTS }, (_, i) => drawServerFace(17 + i * 101));
  // Simplified stand-ins: one cabinet box and a front image. Far from the camera, soft in its
  // depth of field, they need no more.
  private readonly bodyGeometry = new BoxGeometry(RACK_W - 0.004, RACK_H, RACK_D).translate(0, RACK_H / 2, 0);
  private readonly faceGeometry = new PlaneGeometry(RACK_W - 0.1, RACK_UNITS * U).translate(0, PLINTH + (RACK_UNITS * U) / 2, RACK_D / 2 + 0.002);
  private readonly bodies: InstancedMesh;
  private readonly faces: InstancedMesh[];
  private readonly leds: LedField<never>;
  private readonly strips: LedField<never>;
  private readonly stripGeometry = new BoxGeometry(0.008, RACK_UNITS * U * 0.96, 0.006);
  private readonly troffers: InstancedMesh;
  private readonly housings: InstancedMesh;
  private readonly ceiling: Mesh;
  private readonly sign = new LabelCanvas(1024, 190, 2);
  private readonly signMesh = new Object3D();
  private readonly ceilingMaterial: MeshStandardMaterial;
  private reflector?: Reflector;
  private block?: ClusterBlock;
  private cell = "";
  private clusterName = "";
  private theme: LensTheme;

  constructor(private readonly host: DataHallHost, theme: LensTheme) {
    this.theme = theme;
    this.root.name = "data-hall";
    host.parent.add(this.root);

    const body = this.track(new MeshStandardMaterial({ color: 0x1b1f24, roughness: 0.6, metalness: 0.45 }));
    this.bodies = this.instanced(this.bodyGeometry, body, MAX_RACKS);
    this.faces = this.faceTextures.map((map) => this.instanced(this.faceGeometry, this.track(new MeshStandardMaterial({ map, roughness: 0.55, metalness: 0.4 })), MAX_RACKS));
    this.leds = new LedField<never>("hallLeds", host.geometries.led, this.root, MAX_RACKS * LEDS_PER_RACK);
    this.strips = new LedField<never>("hallStrips", this.stripGeometry, this.root, MAX_RACKS * 2);

    // Ceiling: one plane, and recessed panels in dark housings over every aisle. Dim enough to
    // stay under the bloom threshold, so they light the hall without glare.
    this.ceilingMaterial = this.track(new MeshStandardMaterial({ color: 0x0d1117, roughness: 0.9, metalness: 0.1 }));
    this.ceiling = new Mesh(new PlaneGeometry(PLANE, PLANE).rotateX(Math.PI / 2), this.ceilingMaterial);
    this.ceiling.position.y = CEILING;
    // Ambient, like the rest of the room: not one of the hall's racks.
    this.ceiling.userData["thermal"] = "field";
    this.root.add(this.ceiling);
    const panel = this.track(new MeshBasicMaterial({ color: new Color(0.7, 0.74, 0.8), toneMapped: false }));
    const housing = this.track(new MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.5, metalness: 0.6 }));
    this.troffers = this.instanced(new BoxGeometry(1.2, 0.01, 0.3).translate(0, CEILING - 0.032, 0), panel, 900);
    this.housings = this.instanced(new BoxGeometry(1.32, 0.03, 0.4).translate(0, CEILING - 0.015, 0), housing, 900);
    this.troffers.userData["thermal"] = this.housings.userData["thermal"] = "field";

    // A mirror under a translucent floor, softened: the polish of a datacenter floor.
    this.reflector = new Reflector(new PlaneGeometry(PLANE, PLANE), { clipBias: 0.003, textureWidth: 512, textureHeight: 512, color: new Color(0x8a96a6), multisample: 0 });
    const reflectorMaterial = this.reflector.material as ShaderMaterial;
    reflectorMaterial.fragmentShader = reflectorMaterial.fragmentShader.replace(
      "vec4 base = texture2DProj( tDiffuse, vUv );",
      `vec2 reflectedUv = vUv.xy / vUv.w;
      vec4 base = vec4( 0.0 );
      for ( int i = -2; i <= 2; i ++ ) {
        for ( int j = -2; j <= 2; j ++ ) {
          base += texture2D( tDiffuse, reflectedUv + vec2( float( i ), float( j ) ) * 0.0045 );
        }
      }
      base /= 25.0;`,
    );
    reflectorMaterial.needsUpdate = true;
    this.reflector.userData["thermal"] = "hide";
    this.reflector.rotation.x = -Math.PI / 2;
    this.reflector.position.y = -0.002;
    this.root.add(this.reflector);

    // The cluster's plate: brushed aluminium, the name engraved, on two posts standing on
    // the front row's roof. Lit by the room like the rest of the hardware.
    const metal = this.track(new MeshStandardMaterial({ color: 0xaab1ba, roughness: 0.32, metalness: 0.9 }));
    const face = this.track(new MeshStandardMaterial({ map: this.sign.texture, roughness: 0.36, metalness: 0.85 }));
    const plate = new Mesh(new BoxGeometry(PLATE_W, PLATE_H, 0.008), [metal, metal, metal, metal, face, metal]);
    plate.position.y = PLATE_LIFT + PLATE_H / 2;
    plate.castShadow = true;
    this.signMesh.add(plate);

    for (const side of [-1, 1]) {
      const post = new Mesh(new CylinderGeometry(0.006, 0.006, PLATE_LIFT, 10), metal);
      post.position.set(side * PLATE_W * 0.36, PLATE_LIFT / 2, -0.008);
      this.signMesh.add(post);
    }

    this.root.add(this.signMesh);
  }

  private track<T extends Material>(material: T): T {
    this.materials.push(material);

    return material;
  }

  private instanced(geometry: BoxGeometry | PlaneGeometry, material: Material, capacity: number) {
    const mesh = new InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    // In the thermal view the hall's racks and ceiling keep steady temperatures of their own.
    mesh.userData["thermal"] = "background";
    this.root.add(mesh);

    return mesh;
  }

  setTheme(theme: LensTheme) {
    this.theme = theme;
    this.ceilingMaterial.color.set(theme.isDark ? 0x0d1117 : 0x6c7682);
    this.cell = ""; // LED colours come from the theme: lay again
    this.drawSign();
  }

  setClusterName(name: string) {
    if (name === this.clusterName) return;
    this.clusterName = name;
    this.drawSign();
  }

  setReflections(enabled: boolean) {
    if (this.reflector) this.reflector.visible = enabled;
  }

  setSize(width: number, height: number, pixelRatio: number) {
    this.reflector?.getRenderTarget().setSize(Math.round(width * pixelRatio * 0.4), Math.round(height * pixelRatio * 0.4));
  }

  // The open floor in front of the cluster, for the camera's overview.
  corridorEnd() {
    return this.block ? this.block.rowZs[0]! + RACK_D / 2 + this.block.aisle + CORRIDOR : 10;
  }

  // ---------------------------------------------------------------------------

  build(block: ClusterBlock) {
    this.block = block;
    this.cell = "";

    // Over the middle of the front row, behind the racks' own nameplates and above them.
    this.signMesh.position.set((block.rowMinX + block.rowMaxX) / 2, RACK_H, block.rowZs[0]! + RACK_D / 2 - 0.06);
    this.drawSign();
  }

  // Follows the camera: the planes every frame, the lattice whenever it has moved a cell.
  tick(time: number, camera: Vector3) {
    this.leds.tick(time);
    this.strips.tick(time);

    const block = this.block;
    if (!block) return;

    const pitch = RACK_D + block.aisle;
    // Planes move in whole tiles of the rack grid, so their patterns never slide.
    const sx = block.rowMinX + Math.round((camera.x - block.rowMinX) / RACK_W) * RACK_W;
    const sz = block.rowZs[0]! + Math.round((camera.z - block.rowZs[0]!) / RACK_W) * RACK_W;
    this.ceiling.position.x = sx;
    this.ceiling.position.z = sz;
    if (this.reflector) this.reflector.position.set(sx, -0.002, sz);

    const cell = `${Math.round(camera.x / RELAY_CELL)}:${Math.round(camera.z / RELAY_CELL)}`;
    if (cell === this.cell) return;
    this.cell = cell;
    this.lay(block, camera, pitch);
  }

  // The floor follows the same grid; the scene owns its material.
  floorCentre(camera: Vector3) {
    const block = this.block;
    if (!block) return { x: 0, z: 0, size: PLANE };

    return {
      x: block.rowMinX + Math.round((camera.x - block.rowMinX) / RACK_W) * RACK_W,
      z: block.rowZs[0]! + Math.round((camera.z - block.rowZs[0]!) / RACK_W) * RACK_W,
      size: PLANE,
    };
  }

  private lay(block: ClusterBlock, camera: Vector3, pitch: number) {
    const row0 = block.rowZs[0]!;
    const clusterRows = block.rowZs.length;
    const corridorRows = Math.ceil((CORRIDOR + block.aisle) / pitch);
    const kMin = Math.floor((row0 - (camera.z + REACH_Z)) / pitch);
    const kMax = Math.ceil((row0 - (camera.z - REACH_Z)) / pitch);
    const iMin = Math.floor((camera.x - REACH_X - block.rowMinX) / RACK_W);
    const iMax = Math.ceil((camera.x + REACH_X - block.rowMinX) / RACK_W);
    const matrix = new Matrix4();
    const variantCounts = this.faces.map(() => 0);
    let count = 0;
    let led = 0;
    let strip = 0;
    const theme = this.theme;
    const ledColours = [ledOf(theme.success, 1.3), ledOf(theme.primary, 1.6), ledOf(theme.warning, 1.6)];
    const stripColour = ledOf(theme.primary, 0.9).lerp(new Color(0.6, 0.8, 1.2), 0.3);

    for (let k = kMin; k <= kMax && count < MAX_RACKS; k++) {
      // Rows count back from the cluster's front row; the open corridor is in front of it.
      if (k < 0 && k >= -corridorRows) continue;
      const z = row0 - k * pitch;
      const clusterRow = k >= 0 && k < clusterRows;

      for (let i = iMin; i <= iMax && count < MAX_RACKS; i++) {
        const x = block.rowMinX + (i + 0.5) * RACK_W;

        // Cross aisles at intervals, and nothing inside the cluster's own block.
        if ((((i % (CROSS_EVERY + 2)) + CROSS_EVERY + 2) % (CROSS_EVERY + 2)) >= CROSS_EVERY) continue;
        if (clusterRow && x > block.minX - CROSS_AISLE && x < block.maxX + CROSS_AISLE) continue;

        const random = rng(cellSeed(i, k));
        matrix.makeTranslation(x, 0, z);
        this.bodies.setMatrixAt(count, matrix);
        const variant = Math.floor(random() * FACE_VARIANTS);
        this.faces[variant]!.setMatrixAt(variantCounts[variant]!++, matrix);

        for (let n = 0; n < LEDS_PER_RACK; n++) {
          const u = Math.floor(random() * RACK_UNITS);
          const lx = -RACK_W / 2 + 0.09 + random() * (RACK_W - 0.18);
          this.leds.pool.setMatrix(led, matrix.clone().multiply(new Matrix4().makeTranslation(lx, PLINTH + (u + 0.5) * U, RACK_D / 2 + 0.006)));
          const roll = random();
          this.leds.set(led, ledColours[roll < 0.7 ? 0 : roll < 0.9 ? 1 : 2]!, roll < 0.5 ? LedMode.flicker : LedMode.steady, 4 + random() * 12, random() * 50, 0.3 + random() * 0.5);
          led++;
        }

        for (const side of [-1, 1]) {
          this.strips.pool.setMatrix(strip, matrix.clone().multiply(new Matrix4().makeTranslation(side * (RACK_W / 2 - 0.03), PLINTH + (RACK_UNITS * U) / 2, RACK_D / 2 - 0.004)));
          this.strips.set(strip, stripColour, LedMode.steady);
          strip++;
        }

        count++;
      }
    }

    this.bodies.count = count;
    this.bodies.instanceMatrix.needsUpdate = true;
    this.faces.forEach((mesh, v) => {
      mesh.count = variantCounts[v]!;
      mesh.instanceMatrix.needsUpdate = true;
    });
    this.hideFrom(this.leds, led);
    this.hideFrom(this.strips, strip);

    // Ceiling panels over every aisle in reach, in step with the racks' rows.
    let troffers = 0;
    const tx0 = Math.floor((camera.x - REACH_X) / TROFFER_PITCH) * TROFFER_PITCH;

    for (let k = kMin - 1; k <= kMax && troffers < 900; k++) {
      const z = row0 - k * pitch + RACK_D / 2 + block.aisle / 2;

      for (let x = tx0; x <= camera.x + REACH_X && troffers < 900; x += TROFFER_PITCH) {
        matrix.makeTranslation(x, 0, z);
        this.troffers.setMatrixAt(troffers, matrix);
        this.housings.setMatrixAt(troffers, matrix);
        troffers++;
      }
    }

    this.troffers.count = this.housings.count = troffers;
    this.troffers.instanceMatrix.needsUpdate = this.housings.instanceMatrix.needsUpdate = true;
  }

  // The solid runs of background racks near a point, as boxes, for keeping the camera out
  // of them: each run between cross aisles is one box, so nothing slips between two racks.
  solidsNear(point: Vector3, out: SolidBox[]) {
    const block = this.block;
    if (!block) return;

    const pitch = RACK_D + block.aisle;
    const row0 = block.rowZs[0]!;
    const corridorRows = Math.ceil((CORRIDOR + block.aisle) / pitch);
    const kNear = Math.round((row0 - point.z) / pitch);
    const run = CROSS_EVERY + 2;
    const jNear = Math.floor((point.x - block.rowMinX) / (run * RACK_W));

    for (let k = kNear - 1; k <= kNear + 1; k++) {
      if (k < 0 && k >= -corridorRows) continue;
      const z = row0 - k * pitch;
      const clusterRow = k >= 0 && k < block.rowZs.length;

      for (let j = jNear - 1; j <= jNear + 1; j++) {
        let x0 = block.rowMinX + j * run * RACK_W;
        let x1 = x0 + CROSS_EVERY * RACK_W;

        // In the cluster's rows, the background stops short of the cluster's block.
        if (clusterRow) {
          const gap0 = block.minX - CROSS_AISLE;
          const gap1 = block.maxX + CROSS_AISLE;
          if (x0 >= gap0 && x1 <= gap1) continue;
          if (x1 > gap0 && x0 < gap0) x1 = gap0;
          else if (x0 < gap1 && x1 > gap1) x0 = gap1;
        }

        out.push({ x0, x1, z0: z - RACK_D / 2, z1: z + RACK_D / 2, top: RACK_H });
      }
    }
  }

  // LEDs beyond those laid this time are collapsed; the pool keeps its size.
  private hideFrom(field: LedField<never>, from: number) {
    const zero = new Matrix4().makeScale(0, 0, 0);
    const pool = field.pool;

    while (pool.mesh.count < from) pool.alloc();
    for (let i = from; i < pool.mesh.count; i++) pool.setMatrix(i, zero);
  }

  private drawSign() {
    const theme = this.theme;
    const name = this.clusterName || "Cluster";

    this.sign.draw([name, theme.key].join("|"), (ctx, w, h) => {
      // Brushed aluminium.
      const gradient = ctx.createLinearGradient(0, 0, 0, h);
      gradient.addColorStop(0, "#c9ced5");
      gradient.addColorStop(1, "#a7adb5");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
      const random = rng(31);

      for (let i = 0; i < 260; i++) {
        const y = random() * h;
        ctx.strokeStyle = random() > 0.5 ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.08)";
        ctx.lineWidth = random() * 1.4;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y + (random() - 0.5) * 2);
        ctx.stroke();
      }

      // Bevel, four rivets, and the name engraved: dark, with a light lip below each cut.
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.lineWidth = 4;
      ctx.strokeRect(2, 2, w - 4, h - 4);

      for (const [x, y] of [[22, 22], [w - 22, 22], [22, h - 22], [w - 22, h - 22]]) {
        ctx.fillStyle = "#7d848d";
        ctx.beginPath();
        ctx.arc(x!, y!, 7, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.textBaseline = "middle";
      const engrave = (text: string, font: string, x: number, y: number) => {
        ctx.font = font;
        ctx.fillStyle = "rgba(255,255,255,0.55)";
        ctx.fillText(text, x, y + 2);
        ctx.fillStyle = "#23272c";
        ctx.fillText(text, x, y);
      };

      engrave("KUBERNETES CLUSTER", `700 24px ${UI_FONT}`, 52, 48);
      ctx.font = `700 76px ${UI_FONT}`;
      engrave(fitText(ctx, name, w - 110), `700 76px ${UI_FONT}`, 50, 118);

      // A Lens-blue inlay along the foot of the plate.
      ctx.fillStyle = theme.css.primary;
      ctx.fillRect(52, h - 30, w - 104, 6);
    });
  }

  dispose() {
    this.host.parent.remove(this.root);
    this.root.traverse((object) => {
      if (object instanceof InstancedMesh) object.dispose();
    });
    this.leds.dispose();
    this.strips.dispose();
    this.reflector?.dispose();
    this.faceTextures.forEach((t) => t.dispose());
    this.materials.forEach((m) => m.dispose());
    this.bodyGeometry.dispose();
    this.faceGeometry.dispose();
    this.stripGeometry.dispose();
    this.troffers.geometry.dispose();
    this.housings.geometry.dispose();
    this.ceiling.geometry.dispose();
    this.sign.dispose();
    this.signMesh.traverse((object) => object instanceof Mesh && object.geometry.dispose());
  }
}
