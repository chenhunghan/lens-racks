import {
  AdditiveBlending,
  BoxGeometry,
  CircleGeometry,
  CylinderGeometry,
  TorusGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  FloatType,
  type Group,
  InstancedBufferAttribute,
  InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NearestFilter,
  Object3D,
  OctahedronGeometry,
  Quaternion,
  RGBAFormat,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
} from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import type { BladeModel, DatacenterModel } from "../model/datacenter-model";
import type { NetworkModel, ServiceModel } from "../model/network-model";
import { CABLE_MGR_U, EQUIPMENT_W, FRONT_Z, RACK_H, RACK_W, type RackGeometries, U, uY } from "./geometry";
import { LedField, LedMode } from "./instance-pool";
import { type LensTheme, ledOf } from "./lens-theme";
import type { NetworkMode } from "./scene-types";
import { PATCH_PORTS, patchPortX, type SceneTextures, LabelCanvas, UI_FONT } from "./textures";
import { CEILING } from "./data-hall";

// The cluster's network drawn the way a datacenter wires it: every Service is a lit
// port on the network core's patch panel (or on the edge router, when the outside world
// reaches it), and a fibre runs from that port through the overhead trays into every
// blade that serves it. Light pulses travel the fibres at the rate the pods send and
// receive; trunks carry each node's traffic, an uplink the traffic in and out of the cluster.


export interface NetworkHost {
  readonly parent: Group;
  readonly geometries: RackGeometries;
  readonly textures: SceneTextures;
  readonly rackMaterials: Readonly<Record<"frame" | "sidePanels" | "rails" | "roof" | "rearDoor" | "chassis" | "cableManager", Material>>;
  // Final (not animated) placement, so fibres are laid where racks come to rest.
  rackPose(key: string): { x: number; z: number } | undefined;
  bladeAnchor(uid: string): { position: Vector3; rackKey: string; enclosureTop: number } | undefined;
}

export interface CorePlacement {
  readonly x: number;
  readonly z: number;
}

const TRAY_Y = 2.75;
const GATEWAY_SIGN_Y = 3.1;
const ROUTER_U = 41; // 2U: 41–42
const FIRST_PANEL_U = 39;
const LAST_PANEL_U = 3;
const PATH_SAMPLES = 64;
const MAX_PULSES = 6; // per direction per link
// Symbolic: light crosses the hall in nanoseconds. A calm pace reads as flow; traffic is
// shown by how many pulses a link carries, not by how fast they go.
const PULSE_SPEED = 0.6; // m/s
const PULSE_RADIUS = 0.0055;
const PULSE_TAIL = 7; // a comet: the head, and a tail this many radii long
const FIBRE_RADIUS = 0.0032;
const TRUNK_RADIUS = 0.0075;
const ROUTER_FIRST_PORT = (() => {
  for (let i = 0; i < PATCH_PORTS; i++) if (patchPortX(i) * 1024 >= 330) return i;

  return PATCH_PORTS;
})();

type LinkKind = "service" | "trunk" | "uplink" | "mesh";

interface Link {
  readonly id: string;
  readonly kind: LinkKind;
  path: Vector3[];
  length: number;
  readonly color: Color;
  readonly radius: number;
  readonly serviceKey?: string;
  readonly external?: boolean; // a Service the outside world reaches
  readonly podUid?: string;
  readonly rackKey?: string;
  rx: number; // bytes/s towards the far end (the pod, the rack, the cluster)
  tx: number; // bytes/s back
  pulseStart: number;
  vertexStart: number;
  vertexCount: number;
}

interface Port {
  readonly service: ServiceModel;
  readonly position: Vector3; // world, at the bore
  readonly led: number;
  readonly pick: number;
}

type FocusTarget =
  | { type: "internet" }
  | { type: "blade"; uid: string }
  | { type: "rack"; name: string }
  | { type: "service"; key: string }
  | { type: "pods"; uids: ReadonlySet<string> };

// ---------------------------------------------------------------------------
// Paths: polylines whose corners are rounded with quadratic arcs.

const rounded = (corners: Vector3[], radius = 0.07): Vector3[] => {
  const points: Vector3[] = [corners[0]!.clone()];

  for (let i = 1; i < corners.length - 1; i++) {
    const prev = corners[i - 1]!;
    const corner = corners[i]!;
    const next = corners[i + 1]!;
    const inLength = corner.distanceTo(prev);
    const outLength = corner.distanceTo(next);

    if (inLength < 1e-4 || outLength < 1e-4) continue;

    const r = Math.min(radius, inLength / 2, outLength / 2);
    const a = corner.clone().addScaledVector(prev.clone().sub(corner).normalize(), r);
    const b = corner.clone().addScaledVector(next.clone().sub(corner).normalize(), r);

    for (let k = 0; k <= 5; k++) {
      const t = k / 5;
      const p = a.clone().multiplyScalar((1 - t) ** 2).addScaledVector(corner, 2 * (1 - t) * t).addScaledVector(b, t * t);
      points.push(p);
    }
  }

  points.push(corners[corners.length - 1]!.clone());

  // Drop duplicates, which would give a tube a zero-length segment.
  return points.filter((p, i) => i === 0 || p.distanceToSquared(points[i - 1]!) > 1e-10);
};

const pathLength = (points: Vector3[]) => points.reduce((total, p, i) => (i ? total + p.distanceTo(points[i - 1]!) : 0), 0);

// Evenly spaced samples by arc length, for the GPU to move pulses along.
const resample = (points: Vector3[], count: number) => {
  const total = pathLength(points);
  const out: Vector3[] = [];
  let segment = 1;
  let travelled = 0;

  for (let i = 0; i < count; i++) {
    const target = (total * i) / (count - 1);

    while (segment < points.length - 1 && travelled + points[segment]!.distanceTo(points[segment - 1]!) < target) {
      travelled += points[segment]!.distanceTo(points[segment - 1]!);
      segment++;
    }

    const a = points[segment - 1]!;
    const b = points[segment]!;
    const length = a.distanceTo(b) || 1;
    out.push(a.clone().lerp(b, Math.min(1, Math.max(0, (target - travelled) / length))));
  }

  return out;
};

// A low-poly tube along a polyline, rings oriented by parallel transport.
const tube = (points: Vector3[], radius: number, radial: number, color: Color, positions: number[], normals: number[], colors: number[], indices: number[]) => {
  const base = positions.length / 3;
  let normal = new Vector3();
  const tangent = new Vector3();
  const binormal = new Vector3();

  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const next = points[Math.min(i + 1, points.length - 1)]!;
    const prev = points[Math.max(i - 1, 0)]!;
    tangent.subVectors(next, prev).normalize();

    if (i === 0) {
      normal = Math.abs(tangent.y) < 0.9 ? new Vector3(0, 1, 0).cross(tangent).normalize() : new Vector3(1, 0, 0).cross(tangent).normalize();
    } else {
      // Transport the previous normal onto the new tangent.
      normal.sub(tangent.clone().multiplyScalar(normal.dot(tangent))).normalize();
    }

    binormal.crossVectors(tangent, normal);

    for (let k = 0; k < radial; k++) {
      const angle = (k / radial) * Math.PI * 2;
      const nx = Math.cos(angle) * normal.x + Math.sin(angle) * binormal.x;
      const ny = Math.cos(angle) * normal.y + Math.sin(angle) * binormal.y;
      const nz = Math.cos(angle) * normal.z + Math.sin(angle) * binormal.z;
      positions.push(p.x + nx * radius, p.y + ny * radius, p.z + nz * radius);
      normals.push(nx, ny, nz);
      colors.push(color.r, color.g, color.b);
    }

    if (i > 0) {
      const a = base + (i - 1) * radial;
      const b = base + i * radial;

      for (let k = 0; k < radial; k++) {
        const k1 = (k + 1) % radial;
        indices.push(a + k, b + k, a + k1, a + k1, b + k, b + k1);
      }
    }
  }

  return points.length * radial;
};

// ---------------------------------------------------------------------------
// Pulses: an instanced octahedron per pulse, placed on its path in the vertex shader.

const pulseVertex = /* glsl */ `
  uniform sampler2D paths;
  uniform float time;
  uniform float speed;
  attribute vec4 pulse; // link row, phase, direction (+1 out, -1 back), active
  attribute vec3 pulseColor;
  uniform float radius;
  uniform float tail;
  varying vec3 vColor;
  varying float vFade;
  #include <fog_pars_vertex>

  vec3 pathAt(int row, float t) {
    float f = clamp(t, 0.0, 1.0) * float(${PATH_SAMPLES - 1});
    int i0 = int(floor(f));
    int i1 = min(i0 + 1, ${PATH_SAMPLES - 1});
    vec3 a = texelFetch(paths, ivec2(i0, row), 0).xyz;
    vec3 b = texelFetch(paths, ivec2(i1, row), 0).xyz;
    return mix(a, b, fract(f));
  }

  void main() {
    int row = int(pulse.x + 0.5);
    float pathLength = texelFetch(paths, ivec2(0, row), 0).w;
    float t = fract(pulse.y + time * speed / max(pathLength, 0.2));
    if (pulse.z < 0.0) t = 1.0 - t;

    vec3 p = pathAt(row, t);
    vec3 ahead = pathAt(row, t + 0.004 * sign(pulse.z));
    vec3 w = normalize(ahead - p + vec3(1e-5));
    vec3 u = normalize(cross(abs(w.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), w));
    vec3 v = cross(w, u);
    // A comet along the fibre: a round head ahead, a tail fading behind; gone when inactive.
    float along = position.z < 0.0 ? position.z * tail : position.z;
    vec3 local = (u * position.x + v * position.y + w * along) * radius * pulse.w;
    vFade = position.z < 0.0 ? pow(1.0 + position.z, 1.6) : 1.0;
    vec4 mvPosition = viewMatrix * vec4(p + local, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    vColor = pulseColor;
    #include <fog_vertex>
  }
`;

const pulseFragment = /* glsl */ `
  varying vec3 vColor;
  varying float vFade;
  #include <fog_pars_fragment>

  void main() {
    vec3 colour = vColor * vFade;
    // Added light fades into the haze rather than turning the haze's colour.
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        colour *= exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      #else
        colour *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
      #endif
    #endif
    gl_FragColor = vec4(colour, 1.0);
  }
`;

const pulsesFor = (bytesPerSec: number) => (bytesPerSec <= 1 ? 0 : Math.min(MAX_PULSES, Math.max(1, Math.round(Math.log10(1 + bytesPerSec / 400) * 2))));

// Busier links glow a little brighter; quiet ones stay a soft glimmer.
const pulseGain = (bytesPerSec: number) => 0.55 + 0.45 * Math.min(1, Math.log10(1 + bytesPerSec / 1000) / 3);

const hash = (text: string) => {
  let h = 2166136261;

  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return h >>> 0;
};

// ---------------------------------------------------------------------------

export class NetworkLayer {
  private readonly root = new Object3D();
  private readonly coreGroup = new Object3D();
  private core?: CorePlacement;
  private rows: Array<{ z: number; x0: number; x1: number }> = [];
  private readonly portLeds: LedField<string>;
  private readonly pickMaterial = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  private pickMesh?: InstancedMesh;
  private fibreMesh?: Mesh;
  private readonly fibreMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.05 });
  private pulseMesh?: InstancedMesh;
  private glowLines: Line2[] = [];
  private readonly uplinkGlowMaterial = new LineMaterial({ color: 0xffffff, linewidth: 2.5, worldUnits: false, transparent: true, opacity: 0.85 });
  // Screen-space width: a selected path stays legible from across the room.
  private readonly glowMaterial = new LineMaterial({ color: 0xffffff, linewidth: 3, worldUnits: false, transparent: true, opacity: 0.95, depthTest: true });
  private readonly pulseMaterial: ShaderMaterial;
  private pathTexture?: DataTexture;
  private pathData?: Float32Array;
  private links: Link[] = [];
  private ports = new Map<string, Port>();
  private portOrder: string[] = [];
  private topologyKey = "";
  private model?: DatacenterModel;
  private network?: NetworkModel;
  private mode: NetworkMode = "all";
  private focus = new Set<string>(); // link ids to emphasise; empty means all
  private focusTarget: FocusTarget | undefined;
  private theme: LensTheme;

  constructor(private readonly host: NetworkHost, theme: LensTheme) {
    this.theme = theme;
    this.root.name = "network";
    this.root.add(this.coreGroup);
    host.parent.add(this.root);
    this.portLeds = new LedField<string>("portLeds", host.geometries.led, this.root, 128);
    this.pulseMaterial = new ShaderMaterial({
      fog: true,
      uniforms: UniformsUtils.merge([UniformsLib.fog, { paths: { value: null }, time: { value: 0 }, speed: { value: PULSE_SPEED }, radius: { value: PULSE_RADIUS }, tail: { value: PULSE_TAIL } }]),
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      vertexShader: pulseVertex,
      fragmentShader: pulseFragment,
    });
  }

  // ---------------------------------------------------------------------------
  // The core rack

  setLayout(core: CorePlacement, rows: Array<{ z: number; x0: number; x1: number }>) {
    const moved = !this.core || this.core.x !== core.x || this.core.z !== core.z;
    this.core = core;
    this.rows = rows;

    if (moved) this.buildCoreRack();
  }

  corePlacement() {
    return this.core;
  }

  private buildCoreRack() {
    const core = this.core!;
    const { geometries: g, rackMaterials: m, textures } = this.host;

    for (const child of [...this.coreGroup.children]) this.coreGroup.remove(child);
    this.coreGroup.position.set(core.x, 0, core.z);

    const add = (geometry: BufferGeometry, material: Material, y = 0, z = 0, cast = true) => {
      const mesh = new Mesh(geometry, material);
      mesh.position.set(0, y, z);
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      this.coreGroup.add(mesh);

      return mesh;
    };

    add(g.frame, m.frame);
    add(g.sidePanels, m.sidePanels);
    add(g.rails, m.rails, 0, 0, false);
    add(g.roof, m.roof);
    add(g.rearDoor, m.rearDoor);
    add(g.cableManager, m.cableManager, uY(CABLE_MGR_U), FRONT_Z, false);

    this.routerMaterial ??= new MeshStandardMaterial({ map: textures.edgeRouter, roughness: 0.45, metalness: 0.55 });
    this.panelMaterial ??= new MeshStandardMaterial({ map: textures.patchPanel, roughness: 0.5, metalness: 0.5 });
    this.routerGeometry ??= new BoxGeometry(EQUIPMENT_W, 2 * U - 0.002, 0.006).translate(0, U, 0.003);
    this.panelGeometry ??= new BoxGeometry(EQUIPMENT_W, U - 0.0015, 0.006).translate(0, U / 2, 0.003);

    add(g.mgmtBody, m.chassis, uY(ROUTER_U), FRONT_Z, false);
    add(this.routerGeometry, this.routerMaterial, uY(ROUTER_U), FRONT_Z, false);

    for (let u = FIRST_PANEL_U; u >= LAST_PANEL_U; u--) add(this.panelGeometry, this.panelMaterial, uY(u), FRONT_Z, false);

    // The ceiling penetration the uplink leaves the room through.
    this.sleeveMaterial ??= new MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.5, metalness: 0.7 });
    const sleeve = add(new BoxGeometry(0.22, 0.05, 0.22), this.sleeveMaterial, 4.2, 0.1);
    sleeve.castShadow = false;

    this.topologyKey = ""; // ports and fibres follow the core
  }

  private routerMaterial?: MeshStandardMaterial;
  private panelMaterial?: MeshStandardMaterial;
  private sleeveMaterial?: MeshStandardMaterial;
  private routerGeometry?: BufferGeometry;
  private panelGeometry?: BufferGeometry;

  private portLocal(index: number, external: boolean) {
    // External services take the edge router's ports first, then the panels after the internal ones.
    if (external && index < PATCH_PORTS - ROUTER_FIRST_PORT) {
      const i = ROUTER_FIRST_PORT + index;

      return new Vector3((patchPortX(i) - 0.5) * EQUIPMENT_W, uY(ROUTER_U) + 2 * U * (1 - 47 / 96), FRONT_Z + 0.007);
    }

    const panel = Math.floor(index / PATCH_PORTS);
    const u = FIRST_PANEL_U - panel;

    if (u < LAST_PANEL_U) return undefined;

    return new Vector3((patchPortX(index % PATCH_PORTS) - 0.5) * EQUIPMENT_W, uY(u) + U * (1 - 28 / 48), FRONT_Z + 0.007);
  }

  // ---------------------------------------------------------------------------
  // Updates

  setMode(mode: NetworkMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.root.visible = mode !== "off";
    this.topologyKey = "";
    this.rebuild();
  }

  setTheme(theme: LensTheme) {
    this.theme = theme;
    this.topologyKey = "";
    this.rebuild();
  }

  update(model: DatacenterModel, network: NetworkModel | undefined) {
    this.model = model;
    this.network = network;
    this.rebuild();
  }

  // Emphasises what touches the hovered or selected thing; undefined shows everything.
  setFocus(target: FocusTarget | undefined) {
    this.focusTarget = target;
    this.resolveFocus(false);
  }

  private resolveFocus(force: boolean) {
    const target = this.focusTarget;
    const focus = new Set<string>();

    if (target) {
      for (const link of this.links) {
        if (
          (target.type === "blade" && link.podUid === target.uid) ||
          (target.type === "rack" && link.rackKey === target.name) ||
          (target.type === "service" && link.serviceKey === target.key) ||
          (target.type === "pods" && link.podUid !== undefined && target.uids.has(link.podUid)) ||
          (target.type === "internet" && (link.kind === "uplink" || link.external === true))
        ) {
          focus.add(link.id);
        }
      }
    }

    const same = focus.size === this.focus.size && [...focus].every((id) => this.focus.has(id));
    if (same && !force) return;
    this.focus = focus;
    this.applyLook();
  }

  private rebuild() {
    if (!this.core || !this.model || !this.network) return;

    const services = this.network.services;
    const external = services.filter((s) => s.exposure !== "internal");
    const internal = services.filter((s) => s.exposure === "internal");
    const traffic = this.network.traffic;

    // Topology: what is wired where. Traffic alone changes pulses, not fibres, unless
    // the mode hides idle links.
    const busyKey = this.mode === "busy" && traffic ? [...traffic.pods.entries()].filter(([, t]) => t.rxBytesPerSec + t.txBytesPerSec > 1).map(([k]) => k).join(",") : "";
    const key = [
      this.mode,
      this.core.x,
      this.core.z,
      this.rows.map((r) => `${r.z}:${r.x0}`).join(";"),
      services.map((s) => `${s.key}:${s.exposure}:${s.podUids.join("+")}`).join("|"),
      this.model.racks.map((r) => `${r.name}@${this.host.rackPose(r.name)?.x}:${this.host.rackPose(r.name)?.z}`).join("|"),
      this.model.racks.flatMap((r) => r.blades.map((b) => `${b.uid}@${this.host.bladeAnchor(b.uid)?.position.toArray().map((n) => n.toFixed(3)).join(",")}`)).join("|"),
      (traffic?.mesh ?? []).map((e) => `${e.fromWorkload}>${e.toService}`).join("|"),
      busyKey,
    ].join("#");

    if (key !== this.topologyKey) {
      this.topologyKey = key;
      this.layPorts(external, internal);
      this.layFibres();
    }

    this.applyTraffic();
  }

  private layPorts(external: readonly ServiceModel[], internal: readonly ServiceModel[]) {
    for (const port of this.ports.values()) this.portLeds.pool.release(port.led);
    this.ports.clear();

    if (this.pickMesh) {
      this.root.remove(this.pickMesh);
      this.pickMesh.dispose();
    }

    const coreMatrix = new Matrix4().makeTranslation(this.core!.x, 0, this.core!.z);
    const routerPorts = PATCH_PORTS - ROUTER_FIRST_PORT;
    const placed: Array<{ service: ServiceModel; local: Vector3 }> = [];

    external.forEach((service, i) => {
      const local = i < routerPorts ? this.portLocal(i, true) : this.portLocal(internal.length + (i - routerPorts), false);
      if (local) placed.push({ service, local });
    });

    internal.forEach((service, i) => {
      const local = this.portLocal(i, false);
      if (local) placed.push({ service, local });
    });

    this.pickMesh = new InstancedMesh(new BoxGeometry(0.019, 0.03, 0.02), this.pickMaterial, Math.max(1, placed.length));
    this.pickMesh.count = placed.length;
    this.pickMesh.frustumCulled = false;
    this.pickMesh.userData["thermal"] = "keep";
    this.root.add(this.pickMesh);
    this.portOrder = [];

    placed.forEach(({ service, local }, i) => {
      const position = local.clone().applyMatrix4(coreMatrix);
      const led = this.portLeds.pool.alloc(service.key);
      this.portLeds.pool.setMatrix(led, new Matrix4().makeTranslation(position.x - 0.006, position.y - U * 0.3, position.z));
      this.pickMesh!.setMatrixAt(i, new Matrix4().makeTranslation(position.x, position.y, position.z));
      this.ports.set(service.key, { service, position, led, pick: i });
      this.portOrder.push(service.key);
    });

    this.pickMesh.instanceMatrix.needsUpdate = true;
    this.pickMesh.computeBoundingSphere();
  }

  // ---------------------------------------------------------------------------
  // Fibres

  private trayZ(rowZ: number) {
    return rowZ - 0.25;
  }

  private rowOf(z: number) {
    return this.rows.reduce((best, row) => (Math.abs(row.z - z) < Math.abs(best.z - z) ? row : best), this.rows[0] ?? { z, x0: 0, x1: 0 });
  }

  // Port → core front channel → over the core → tray → spine → row tray → over the
  // rack's roof under its sign → down its front channel → across to the blade.
  private serviceRoute(port: Vector3, blade: Vector3, rackX: number, rackZ: number, enclosureTop: number, lane: number) {
    const core = this.core!;
    const laneA = ((lane % 9) - 4) * 0.02;
    const laneB = (lane % 3) * 0.009;
    const coreFront = core.z + FRONT_Z + 0.035;
    const coreChannel = core.x + RACK_W / 2 - 0.066 - (lane % 4) * 0.004;
    const coreTray = this.trayZ(core.z);
    const rowTray = this.trayZ(this.rowOf(rackZ).z);
    const y = TRAY_Y + 0.02 + laneB;
    const rackFront = rackZ + FRONT_Z + 0.03;
    const rackChannel = rackX + RACK_W / 2 - 0.066 - (lane % 4) * 0.004;
    const overRoof = RACK_H + 0.035 + laneB;

    const corners = [
      port,
      new Vector3(port.x, port.y, coreFront),
      new Vector3(coreChannel, port.y, coreFront),
      new Vector3(coreChannel, overRoof, coreFront),
      new Vector3(coreChannel, overRoof, core.z - 0.1),
      new Vector3(coreChannel, y, coreTray + laneA),
      ...(Math.abs(rowTray - coreTray) > 0.05 ? [new Vector3(core.x + laneA, y, coreTray + laneA), new Vector3(core.x + laneA, y, rowTray + laneA)] : []),
      new Vector3(rackChannel, y, rowTray + laneA),
      new Vector3(rackChannel, overRoof, rackZ - 0.1),
      new Vector3(rackChannel, overRoof, rackFront),
      new Vector3(rackChannel, enclosureTop, rackFront),
      new Vector3(blade.x, enclosureTop, rackFront),
      new Vector3(blade.x, blade.y, blade.z + 0.012),
      blade,
    ];

    return rounded(corners, 0.06);
  }

  private trunkRoute(rackX: number, rackZ: number, lane: number) {
    const core = this.core!;
    const coreTray = this.trayZ(core.z);
    const rowTray = this.trayZ(this.rowOf(rackZ).z);
    const y = TRAY_Y + 0.05 + (lane % 2) * 0.014;
    const offset = (lane % 5) * 0.016 - 0.03;

    return rounded([
      new Vector3(core.x - 0.12, RACK_H - 0.01, core.z - 0.3),
      new Vector3(core.x - 0.12, y, coreTray + offset),
      ...(Math.abs(rowTray - coreTray) > 0.05 ? [new Vector3(core.x - 0.05 + offset, y, coreTray + offset), new Vector3(core.x - 0.05 + offset, y, rowTray + offset)] : []),
      new Vector3(rackX - 0.18, y, rowTray + offset),
      new Vector3(rackX - 0.18, RACK_H - 0.01, rackZ - 0.3),
    ], 0.12);
  }

  private uplinkRoute() {
    const core = this.core!;
    const router = new Vector3(core.x - 0.17, uY(ROUTER_U) + U, core.z + FRONT_Z + 0.007);
    const front = core.z + FRONT_Z + 0.04;
    const channel = core.x - RACK_W / 2 + 0.066;

    return rounded([
      router,
      new Vector3(router.x, router.y, front),
      new Vector3(channel, router.y, front),
      new Vector3(channel, RACK_H + 0.05, front),
      new Vector3(core.x, RACK_H + 0.4, core.z + 0.1),
      new Vector3(core.x, CEILING - 0.02, core.z + 0.1),
    ], 0.12);
  }

  private meshRoute(from: Vector3, to: Vector3) {
    // A patch cord looped out in front of the panels.
    const bulge = 0.08 + Math.min(0.25, from.distanceTo(to) * 0.3);

    return rounded([from, from.clone().add(new Vector3(0, 0, bulge)), to.clone().add(new Vector3(0, 0, bulge)), to], 0.06);
  }

  private layFibres() {
    const theme = this.theme;
    const links: Link[] = [];
    const busy = (key: string) => {
      const t = this.network?.traffic?.pods.get(key);

      return Boolean(t && t.rxBytesPerSec + t.txBytesPerSec > 1);
    };
    const bladeByUid = new Map<string, BladeModel>();

    for (const rack of this.model!.racks) for (const blade of rack.blades) bladeByUid.set(blade.uid, blade);

    const internalColour = new Color(0xd9b43a); // OS2 single-mode yellow
    const externalColour = ledOf(theme.primary, 0.75);
    const meshColour = new Color(0x2fc6c6); // OM3 aqua
    const trunkColour = theme.primary.clone().multiplyScalar(0.55);

    for (const port of this.ports.values()) {
      const service = port.service;

      for (const podUid of service.podUids) {
        const blade = bladeByUid.get(podUid);
        const anchor = this.host.bladeAnchor(podUid);
        if (!blade || !anchor) continue;
        if (this.mode === "busy" && !busy(`${blade.namespace}/${blade.name}`)) continue;

        const pose = this.host.rackPose(anchor.rackKey);
        if (!pose) continue;

        const path = this.serviceRoute(port.position, anchor.position, pose.x, pose.z, anchor.enclosureTop, hash(service.key + podUid));
        links.push({
          id: `svc:${service.key}:${podUid}`,
          kind: "service",
          path,
          length: pathLength(path),
          color: service.exposure === "internal" ? internalColour : externalColour,
          radius: FIBRE_RADIUS,
          serviceKey: service.key,
          external: service.exposure !== "internal",
          podUid,
          rackKey: anchor.rackKey,
          rx: 0,
          tx: 0,
          pulseStart: 0,
          vertexStart: 0,
          vertexCount: 0,
        });
      }
    }

    this.model!.racks.forEach((rack, i) => {
      const pose = this.host.rackPose(rack.name);
      if (!pose) return;
      const path = this.trunkRoute(pose.x, pose.z, i);
      links.push({ id: `trunk:${rack.name}`, kind: "trunk", path, length: pathLength(path), color: trunkColour, radius: TRUNK_RADIUS, rackKey: rack.name, rx: 0, tx: 0, pulseStart: 0, vertexStart: 0, vertexCount: 0 });
    });

    const uplink = this.uplinkRoute();
    links.push({ id: "uplink", kind: "uplink", path: uplink, length: pathLength(uplink), color: externalColour.clone().multiplyScalar(0.8), radius: TRUNK_RADIUS * 2.4, rx: 0, tx: 0, pulseStart: 0, vertexStart: 0, vertexCount: 0 });
    this.placeGateway();

    // Who calls whom, where the mesh says so: cords between ports on the core.
    for (const edge of this.network?.traffic?.mesh ?? []) {
      const to = this.ports.get(edge.toService);
      const from = this.callerPort(edge.fromWorkload);
      if (!to || !from || from === to) continue;
      const path = this.meshRoute(from.position, to.position);
      links.push({ id: `mesh:${edge.fromWorkload}>${edge.toService}`, kind: "mesh", path, length: pathLength(path), color: meshColour, radius: FIBRE_RADIUS * 1.2, serviceKey: edge.toService, rx: 0, tx: 0, pulseStart: 0, vertexStart: 0, vertexCount: 0 });
    }

    this.links = links;
    this.buildFibreMesh();
    this.buildPulses();
    // Links are new objects: find the focused ones again.
    this.focus = new Set();
    this.resolveFocus(true);
  }

  // The port of a Service in front of the calling workload's pods, if it has one.
  private callerPort(workload: string) {
    const [namespace, name] = workload.split("/");
    const pods = new Set(
      this.model!.racks.flatMap((rack) => rack.blades)
        .filter((blade) => blade.namespace === namespace && (blade.ownerName === name || blade.ownerName?.startsWith(`${name}-`)))
        .map((blade) => blade.uid),
    );

    for (const port of this.ports.values()) {
      if (port.service.namespace === namespace && port.service.podUids.some((uid) => pods.has(uid))) return port;
    }

    return undefined;
  }

  private buildFibreMesh() {
    if (this.fibreMesh) {
      this.root.remove(this.fibreMesh);
      this.fibreMesh.geometry.dispose();
    }

    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];

    for (const link of this.links) {
      link.vertexStart = positions.length / 3;
      link.vertexCount = tube(link.path, link.radius, link.kind === "service" ? 5 : 7, link.color, positions, normals, colors, indices);
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute("normal", new BufferAttribute(new Float32Array(normals), 3));
    geometry.setAttribute("color", new BufferAttribute(new Float32Array(colors), 3));
    geometry.setIndex(positions.length / 3 > 65535 ? new BufferAttribute(new Uint32Array(indices), 1) : new BufferAttribute(new Uint16Array(indices), 1));
    geometry.computeBoundingSphere();

    this.fibreMesh = new Mesh(geometry, this.fibreMaterial);
    this.fibreMesh.name = "fibres";
    this.root.add(this.fibreMesh);
  }

  private buildPulses() {
    if (this.pulseMesh) {
      this.root.remove(this.pulseMesh);
      this.pulseMesh.geometry.dispose();
      this.pulseMesh.dispose();
    }

    this.pathTexture?.dispose();

    const rows = Math.max(1, this.links.length);
    const data = new Float32Array(PATH_SAMPLES * rows * 4);

    this.links.forEach((link, row) => {
      resample(link.path, PATH_SAMPLES).forEach((p, i) => data.set([p.x, p.y, p.z, link.length], (row * PATH_SAMPLES + i) * 4));
    });

    this.pathData = data;
    this.pathTexture = new DataTexture(data, PATH_SAMPLES, rows, RGBAFormat, FloatType);
    this.pathTexture.minFilter = this.pathTexture.magFilter = NearestFilter;
    this.pathTexture.needsUpdate = true;
    this.pulseMaterial.uniforms["paths"]!.value = this.pathTexture;

    const perLink = MAX_PULSES * 2;
    const count = this.links.length * perLink;
    const geometry = new OctahedronGeometry(1, 1);
    const pulse = new Float32Array(count * 4);
    const colour = new Float32Array(count * 3);

    this.links.forEach((link, row) => {
      link.pulseStart = row * perLink;
      const seed = hash(link.id);

      for (let k = 0; k < perLink; k++) {
        const outward = k < MAX_PULSES;
        const j = outward ? k : k - MAX_PULSES;
        // Spread evenly with a per-link jitter, so pulses never march in lockstep.
        pulse.set([row, (j / MAX_PULSES + ((seed >> (j % 16)) & 7) * 0.013) % 1, outward ? 1 : -1, 0], (link.pulseStart + k) * 4);
      }
    });

    geometry.setAttribute("pulse", new InstancedBufferAttribute(pulse, 4));
    geometry.setAttribute("pulseColor", new InstancedBufferAttribute(colour, 3));

    this.pulseMesh = new InstancedMesh(geometry, this.pulseMaterial, Math.max(1, count));
    this.pulseMesh.count = count;
    this.pulseMesh.frustumCulled = false;
    this.pulseMesh.name = "pulses";
    this.pulseMesh.userData["thermal"] = "hide";
    this.root.add(this.pulseMesh);
  }

  // ---------------------------------------------------------------------------
  // Traffic

  private applyTraffic() {
    const traffic = this.network?.traffic;
    const bladeByUid = new Map<string, BladeModel>();

    for (const rack of this.model!.racks) for (const blade of rack.blades) bladeByUid.set(blade.uid, blade);

    // A pod behind several Services splits its traffic between them.
    const servicesPerPod = new Map<string, number>();

    for (const link of this.links) if (link.kind === "service") servicesPerPod.set(link.podUid!, (servicesPerPod.get(link.podUid!) ?? 0) + 1);

    const rackTotals = new Map<string, { rx: number; tx: number }>();
    const exposedPods = new Set<string>();

    for (const port of this.ports.values()) {
      if (port.service.exposure !== "internal") port.service.podUids.forEach((uid) => exposedPods.add(uid));
    }

    let uplinkRx = 0;
    let uplinkTx = 0;

    for (const rack of this.model!.racks) {
      const total = { rx: 0, tx: 0 };

      for (const blade of rack.blades) {
        // Host-network pods report the node's own counters, not their own.
        if (blade.hostNetwork) continue;
        const t = traffic?.pods.get(`${blade.namespace}/${blade.name}`);
        if (!t) continue;
        total.rx += t.rxBytesPerSec;
        total.tx += t.txBytesPerSec;

        if (exposedPods.has(blade.uid)) {
          uplinkRx += t.rxBytesPerSec;
          uplinkTx += t.txBytesPerSec;
        }
      }

      rackTotals.set(rack.name, total);
    }

    const meshRates = new Map((traffic?.mesh ?? []).map((edge) => [`mesh:${edge.fromWorkload}>${edge.toService}`, edge.requestsPerSec]));

    for (const link of this.links) {
      if (link.kind === "service") {
        const blade = bladeByUid.get(link.podUid!);
        const t = blade && !blade.hostNetwork ? traffic?.pods.get(`${blade.namespace}/${blade.name}`) : undefined;
        const share = servicesPerPod.get(link.podUid!) ?? 1;
        link.rx = (t?.rxBytesPerSec ?? 0) / share;
        link.tx = (t?.txBytesPerSec ?? 0) / share;
      } else if (link.kind === "trunk") {
        const total = rackTotals.get(link.rackKey!);
        link.rx = total?.rx ?? 0;
        link.tx = total?.tx ?? 0;
      } else if (link.kind === "uplink") {
        // Down the uplink is what the exposed pods receive, up what they send.
        link.rx = uplinkRx;
        this.northSouth = { rx: uplinkRx, tx: uplinkTx };
        link.tx = uplinkTx;
      } else {
        // Requests per second, drawn as if each were a kilobyte.
        link.rx = (meshRates.get(link.id) ?? 0) * 1024;
        link.tx = 0;
      }
    }

    this.updatePortLeds();
    this.drawGatewaySign();
    this.applyLook();
  }

  private updatePortLeds() {
    const theme = this.theme;
    const traffic = this.network?.traffic;
    const bladeByUid = new Map(this.model!.racks.flatMap((r) => r.blades).map((b) => [b.uid, b]));

    for (const port of this.ports.values()) {
      const service = port.service;
      let rate = 0;

      for (const uid of service.podUids) {
        const blade = bladeByUid.get(uid);
        const t = blade && !blade.hostNetwork ? traffic?.pods.get(`${blade.namespace}/${blade.name}`) : undefined;
        rate += (t?.rxBytesPerSec ?? 0) + (t?.txBytesPerSec ?? 0);
      }

      if (service.podUids.length === 0 && !service.headless) {
        // A Service nothing answers: a dead port, worth a blink.
        this.portLeds.set(port.led, ledOf(theme.warning, 2), LedMode.blink, 1);
      } else if (rate > 1) {
        this.portLeds.set(port.led, service.exposure === "internal" ? ledOf(theme.success, 1.6) : ledOf(theme.primary, 2), LedMode.flicker, 8 + Math.log10(rate) * 2, hash(service.key) % 97, Math.min(1, 0.25 + Math.log10(1 + rate) / 7));
      } else {
        this.portLeds.set(port.led, service.exposure === "internal" ? ledOf(theme.success, 0.9) : ledOf(theme.primary, 1.2), LedMode.steady);
      }
    }
  }

  // The focused links again, a little fatter and lit in the accent, so a path reads end to end.
  private buildGlow() {
    for (const line of this.glowLines) {
      this.root.remove(line);
      line.geometry.dispose();
    }

    this.glowLines = [];
    this.glowMaterial.color.copy(ledOf(this.theme.primary, 2.2));
    this.uplinkGlowMaterial.color.copy(ledOf(this.theme.primary, 1.3));

    for (const link of this.links) {
      // The way out of the cluster glows always, so the eye can find it.
      if (link.kind === "uplink" && !this.focus.has(link.id)) {
        const geometry = new LineGeometry();
        geometry.setPositions(link.path.flatMap((p) => [p.x, p.y, p.z]));
        const line = new Line2(geometry, this.uplinkGlowMaterial);
        line.userData["thermal"] = "hide";
        line.computeLineDistances();
        this.root.add(line);
        this.glowLines.push(line);
        continue;
      }

      if (!this.focus.has(link.id)) continue;
      const geometry = new LineGeometry();
      geometry.setPositions(link.path.flatMap((p) => [p.x, p.y, p.z]));
      const line = new Line2(geometry, this.glowMaterial);
      line.userData["thermal"] = "hide";
      line.computeLineDistances();
      line.renderOrder = 2;
      this.root.add(line);
      this.glowLines.push(line);
    }
  }

  setResolution(width: number, height: number) {
    this.glowMaterial.resolution.set(width, height);
    this.uplinkGlowMaterial.resolution.set(width, height);
  }

  // Colours and pulse counts from traffic and focus, without rebuilding geometry.
  private applyLook() {
    this.buildGlow();

    const theme = this.theme;
    const out = ledOf(theme.primary, 1.5); // towards the pod / into the cluster
    const back = ledOf(theme.warning, 1.25); // from the pod / out of the cluster
    const meshPulse = new Color(0.2, 1.3, 1.3);

    if (this.fibreMesh) {
      const colors = this.fibreMesh.geometry.getAttribute("color") as BufferAttribute;
      const array = colors.array as Float32Array;

      for (const link of this.links) {
        const dim = this.focus.size === 0 || this.focus.has(link.id) ? 1 : 0.12;
        const lit = this.focus.has(link.id) ? 1.8 : 1;

        for (let v = link.vertexStart; v < link.vertexStart + link.vertexCount; v++) {
          array[v * 3] = link.color.r * dim * lit;
          array[v * 3 + 1] = link.color.g * dim * lit;
          array[v * 3 + 2] = link.color.b * dim * lit;
        }
      }

      colors.needsUpdate = true;
    }

    if (this.pulseMesh) {
      const pulse = this.pulseMesh.geometry.getAttribute("pulse") as InstancedBufferAttribute;
      const colour = this.pulseMesh.geometry.getAttribute("pulseColor") as InstancedBufferAttribute;
      const p = pulse.array as Float32Array;
      const c = colour.array as Float32Array;

      for (const link of this.links) {
        const visible = this.focus.size === 0 || this.focus.has(link.id);
        // Along its path the uplink runs from the router up to the hatch: what leaves the
        // cluster travels that way, what arrives comes down it. Every other link runs towards
        // the pod, the rack, the cluster.
        const uplink = link.kind === "uplink";
        const forward = uplink ? link.tx : link.rx;
        const backward = uplink ? link.rx : link.tx;
        const atLeast = (n: number, rate: number) => (uplink && rate > 1 ? Math.max(2, n) : n);
        const outward = visible ? atLeast(pulsesFor(forward), forward) : 0;
        const inward = visible ? atLeast(pulsesFor(backward), backward) : 0;
        const scale = link.kind === "service" ? 1 : link.kind === "mesh" ? 1.2 : uplink ? 2.6 : 1.7;

        for (let k = 0; k < MAX_PULSES * 2; k++) {
          const i = link.pulseStart + k;
          const isOut = k < MAX_PULSES;
          const j = isOut ? k : k - MAX_PULSES;
          p[i * 4 + 3] = (isOut ? j < outward : j < inward) ? scale : 0;
          // Blue travels into the cluster, amber out of it.
          const colourOf = link.kind === "mesh" ? meshPulse : uplink ? (isOut ? back : out) : isOut ? out : back;
          const gain = uplink ? 1.2 : pulseGain(isOut ? link.rx : link.tx);
          c.set([colourOf.r * gain, colourOf.g * gain, colourOf.b * gain], i * 3);
        }
      }

      pulse.needsUpdate = true;
      colour.needsUpdate = true;
    }
  }

  // A blade moving on its rails (drawn out, pushed back): its fibres follow it frame by
  // frame, rewritten in place, so nothing else is rebuilt.
  refreshBlade(uid: string) {
    const anchor = this.host.bladeAnchor(uid);
    const pose = anchor && this.host.rackPose(anchor.rackKey);
    const positions = this.fibreMesh?.geometry.getAttribute("position") as BufferAttribute | undefined;
    const normals = this.fibreMesh?.geometry.getAttribute("normal") as BufferAttribute | undefined;
    if (!anchor || !pose || !positions || !normals) return;

    let touched = false;

    this.links.forEach((link, row) => {
      if (link.kind !== "service" || link.podUid !== uid) return;
      const port = this.ports.get(link.serviceKey!);
      if (!port) return;

      const path = this.serviceRoute(port.position, anchor.position, pose.x, pose.z, anchor.enclosureTop, hash(link.serviceKey! + uid));
      const p: number[] = [];
      const n: number[] = [];
      const c: number[] = [];
      const count = tube(path, link.radius, 5, link.color, p, n, c, []);

      // Same shape of path, same vertices: rewrite them. (A path that changed shape waits
      // for the next full re-lay.)
      if (count !== link.vertexCount) return;

      (positions.array as Float32Array).set(p, link.vertexStart * 3);
      (normals.array as Float32Array).set(n, link.vertexStart * 3);
      link.path = path;
      link.length = pathLength(path);

      if (this.pathData) {
        resample(path, PATH_SAMPLES).forEach((point, i) => this.pathData!.set([point.x, point.y, point.z, link.length], (row * PATH_SAMPLES + i) * 4));
      }

      touched = true;
    });

    if (!touched) return;
    positions.needsUpdate = true;
    normals.needsUpdate = true;
    if (this.pathTexture) this.pathTexture.needsUpdate = true;
    this.buildGlow();
  }

  // ---------------------------------------------------------------------------
  // The internet: a lit hatch in the ceiling over the core, where the uplink leaves the
  // hall, and a plate beside it with what goes in and out.

  private northSouth = { rx: 0, tx: 0 };
  private readonly gateway = new Object3D();
  private readonly gatewaySign = new LabelCanvas(640, 200, 2);
  private gatewayParts: Mesh[] = [];

  private buildGateway() {
    const metal = new MeshStandardMaterial({ color: 0xaab1ba, roughness: 0.32, metalness: 0.9 });
    const glow = new MeshBasicMaterial({ color: ledOf(this.theme.primary, 1.3), toneMapped: false });
    const face = new MeshStandardMaterial({ map: this.gatewaySign.texture, roughness: 0.36, metalness: 0.8 });

    const ring = new Mesh(new TorusGeometry(0.24, 0.025, 12, 40).rotateX(Math.PI / 2), metal);
    ring.position.y = CEILING - 0.03;
    const hatch = new Mesh(new CircleGeometry(0.22, 40).rotateX(Math.PI / 2), glow);
    hatch.position.y = CEILING - 0.035;
    hatch.userData["thermal"] = "hide";

    // The plate hangs from the ceiling on two rods, beside the hatch, facing the aisle.
    const plate = new Mesh(new BoxGeometry(0.56, 0.175, 0.008), [metal, metal, metal, metal, face, metal]);
    plate.position.set(0.62, GATEWAY_SIGN_Y, 0.2);
    const rods = [-1, 1].map((side) => {
      const length = CEILING - (GATEWAY_SIGN_Y + 0.0875);
      const rod = new Mesh(new CylinderGeometry(0.004, 0.004, length, 8), metal);
      rod.position.set(0.62 + side * 0.22, GATEWAY_SIGN_Y + 0.0875 + length / 2, 0.2);

      return rod;
    });

    this.gatewayParts = [ring, hatch, plate, ...rods];
    this.gateway.add(...this.gatewayParts);
    this.root.add(this.gateway);
  }

  private placeGateway() {
    if (!this.gatewayParts.length) this.buildGateway();
    this.gateway.position.set(this.core!.x, 0, this.core!.z + 0.1);
    this.drawGatewaySign();
  }

  private drawGatewaySign() {
    const theme = this.theme;
    const exposed = this.network?.services.filter((service) => service.exposure !== "internal").length ?? 0;
    const rate = (b: number) => {
      const bits = b * 8;

      return bits >= 1e6 ? `${(bits / 1e6).toFixed(1)} Mb/s` : bits >= 1e3 ? `${Math.round(bits / 1e3)} kb/s` : `${Math.round(bits)} b/s`;
    };
    const { rx, tx } = this.northSouth;

    this.gatewaySign.draw([rx.toFixed(0), tx.toFixed(0), exposed, theme.key].join("|"), (ctx, w, h) => {
      const gradient = ctx.createLinearGradient(0, 0, 0, h);
      gradient.addColorStop(0, "#c9ced5");
      gradient.addColorStop(1, "#a7adb5");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.lineWidth = 4;
      ctx.strokeRect(2, 2, w - 4, h - 4);
      ctx.textBaseline = "middle";

      const engrave = (text: string, font: string, x: number, y: number, colour = "#23272c") => {
        ctx.font = font;
        ctx.fillStyle = "rgba(255,255,255,0.55)";
        ctx.fillText(text, x, y + 2);
        ctx.fillStyle = colour;
        ctx.fillText(text, x, y);
      };

      engrave("INTERNET", `800 54px ${UI_FONT}`, 34, 58);
      engrave(`↓ ${rate(rx)}`, `700 34px ${UI_FONT}`, 34, 122, theme.css.primary);
      engrave(`↑ ${rate(tx)}`, `700 34px ${UI_FONT}`, 300, 122, "#a8650a");
      engrave(`via ${exposed} exposed service${exposed === 1 ? "" : "s"}`, `600 24px ${UI_FONT}`, 34, 168);
    });
  }

  gatewayPickables() {
    return this.root.visible ? this.gatewayParts : [];
  }

  gatewayMatrix(out: Matrix4) {
    const plate = this.gatewayParts[2];
    if (!plate) return false;
    plate.updateWorldMatrix(true, false);
    out.compose(plate.getWorldPosition(new Vector3()).add(new Vector3(0, -0.095, -0.01)), new Quaternion(), new Vector3(0.58, 0.19, 0.03));

    return true;
  }

  gatewayPosition() {
    const plate = this.gatewayParts[2];

    return plate ? plate.getWorldPosition(new Vector3()) : undefined;
  }

  // ---------------------------------------------------------------------------

  tick(time: number) {
    this.pulseMaterial.uniforms["time"]!.value = time;
    this.portLeds.tick(time);
  }

  pickables() {
    return this.pickMesh && this.root.visible ? [this.pickMesh] : [];
  }

  serviceAt(instanceId: number) {
    return this.portOrder[instanceId];
  }

  portMatrix(key: string, out: Matrix4) {
    const port = this.ports.get(key);
    if (!port) return false;
    out.compose(port.position.clone().add(new Vector3(0, -0.017, -0.01)), new Quaternion(), new Vector3(0.024, 0.034, 0.03));

    return true;
  }

  portPosition(key: string) {
    return this.ports.get(key)?.position;
  }

  coreObjects() {
    return this.coreGroup.children as Mesh[];
  }

  dispose() {
    this.host.parent.remove(this.root);
    this.fibreMesh?.geometry.dispose();
    this.pulseMesh?.geometry.dispose();
    this.pulseMesh?.dispose();
    this.pickMesh?.geometry.dispose();
    this.pickMesh?.dispose();
    this.pathTexture?.dispose();
    this.portLeds.dispose();
    this.fibreMaterial.dispose();
    this.pulseMaterial.dispose();
    this.glowLines.forEach((line) => line.geometry.dispose());
    this.uplinkGlowMaterial.dispose();
    this.gatewaySign.dispose();
    this.gatewayParts.forEach((part) => part.geometry.dispose());
    this.glowMaterial.dispose();
    this.pickMaterial.dispose();
    this.routerMaterial?.dispose();
    this.panelMaterial?.dispose();
    this.sleeveMaterial?.dispose();
    this.routerGeometry?.dispose();
    this.panelGeometry?.dispose();
  }
}
