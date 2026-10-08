import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  BoxGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  BufferGeometry,
  EdgesGeometry,
  Float32BufferAttribute,
  FogExp2,
  Group,
  HalfFloatType,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Quaternion,
  Raycaster,
  RectAreaLight,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
  type Texture,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { type BladeModel, bladeMatches, type DatacenterModel, isFiltering, type PodHealth, type RackModel } from "../model/datacenter-model";
import {
  BLADE_H,
  BAY_W,
  CABLE_MGR_U,
  createRackGeometries,
  ENCLOSURE_BOTTOM_U,
  ENCLOSURES,
  ENC_BOTTOM_BEZEL,
  ENC_H,
  EQUIPMENT_W,
  FRONT_Z,
  MGMT_U,
  RACK_D,
  RACK_H,
  RACK_W,
  type RackGeometries,
  SWITCH_U,
  U,
  UPS_U,
  uY,
} from "./geometry";
import { InstancePool, LedField, LedMode, type LedModeValue, ZERO } from "./instance-pool";
import { type CorePlacement, NetworkLayer } from "./network-layer";
import { CEILING as HALL_CEILING, DataHall, type SolidBox } from "./data-hall";
import { type HeatRack, ThermalView } from "./thermal";
import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { pickSlot, planShelves, type ShelfLayout, shelfLayout, shelfNamespaces } from "./shelf-planner";
import type { NetworkModel } from "../model/network-model";
import { ledOf, type LensTheme, watchLensTheme } from "./lens-theme";
import { healthLabel, loadBarColor, namespaceColor, namespaceCss } from "./palette";
import { type CameraPose, type PickTarget, type Quality, type RackPart, sameTarget, type SceneCallbacks, type SceneEvent, type SceneOptions } from "./scene-types";
import { createSceneTextures, fitText, LabelCanvas, MONO_FONT, roundRect, type SceneTextures, UI_FONT } from "./textures";

// ---------------------------------------------------------------------------
// Layout: racks in rows, rows paired to face each other across a cold aisle.

const COLD_AISLE = 2.6; // wide enough for the camera to stand in front of a rack in a back row
const TRAY_Y = 2.75;
const SIGN_Y = RACK_H + 0.1;

interface RackPlacement {
  readonly x: number;
  readonly z: number;
  readonly rotation: number; // 0 faces +z, π faces −z
  readonly row: number;
}

interface RowPlacement {
  readonly row: number;
  readonly z: number;
  readonly rotation: number;
  readonly x0: number;
  readonly x1: number;
}

const layoutRacks = (count: number) => {
  const perRow = count <= 8 ? Math.max(count, 1) : Math.min(14, Math.ceil(Math.sqrt(count * 2.2)));
  const rows = Math.max(1, Math.ceil(count / perRow));
  // Every row faces the viewer, a cold aisle in front of each, so the whole room reads
  // from the front: a visualisation first, a floor plan second.
  const rowPitch = RACK_D + COLD_AISLE;
  const placements: RackPlacement[] = [];
  const rowPlacements: RowPlacement[] = [];

  for (let row = 0; row < rows; row++) {
    const inRow = Math.min(perRow, count - row * perRow);
    const z = -row * rowPitch;
    const width = perRow * RACK_W;

    rowPlacements.push({ row, z, rotation: 0, x0: -width / 2, x1: width / 2 });

    for (let i = 0; i < inRow; i++) {
      placements.push({ x: -width / 2 + RACK_W * (i + 0.5), z, rotation: 0, row });
    }
  }

  // The network core stands at the head of the first row, an aisle-width apart.
  const core: CorePlacement = { x: (rowPlacements[0]?.x0 ?? 0) - RACK_W / 2 - 0.9, z: 0 };

  return { placements, rows: rowPlacements, core };
};

// ---------------------------------------------------------------------------

// The parts of a rack that stand for one of its shelves when picked.
const SHELF_POOLS = new Set(["enclosure", "enclosureTop", "enclosureSlides", "enclosureCavity", "enclosureLabel", "bladeBlank"]);

// The equipment pools that stand for a part of a rack, and where each part sits.
const PART_POOLS: Record<string, RackPart> = {
  switchBody: "switch",
  switchFace: "switch",
  mgmtBody: "controller",
  mgmtFace: "controller",
  upsBody: "ups",
  upsFace: "ups",
};
const PART_UNITS: Record<RackPart, { u: number; units: number }> = {
  switch: { u: SWITCH_U, units: 1 },
  controller: { u: MGMT_U, units: 2 },
  ups: { u: UPS_U, units: 2 },
};

// How far an opened shelf's drawer comes out of the rack, and how high a blade lifts out of it.
const SHELF_PULL = 0.42;
const RACK_NUDGE = 0.25; // how far a selected rack slides out of its row
const ENC_DEPTH_SEEN = SHELF_PULL; // the part of an open drawer outside the rack
const BLADE_LIFT = BLADE_H + 0.03;

// How far a selected blade is drawn out of its rack on its rails.
const PULL_DISTANCE = 0.36;
// The tag on a drawn-out blade's side: the canvas's own proportions, as tall as the blade
// allows, and short enough to stay clear of the rack's face.
const CARD_HEIGHT = BLADE_H * 0.92;
const CARD_WIDTH = (CARD_HEIGHT * 1024) / 620;
const CARD_FRONT_GAP = 0.018;

// One quad per shelf over the label strip of its bezel, mapped to a row of the rack's
// shelf-label canvas (rows top to bottom, shelf 0 at the top).
const shelfLabelGeometry = (only: number) => {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let shelf = only; shelf <= only; shelf++) {
    const y0 = uY(ENCLOSURE_BOTTOM_U(shelf)) + 0.001;
    const y1 = y0 + ENC_BOTTOM_BEZEL - 0.002;
    const z = FRONT_Z + 0.0085;
    const v1 = 1 - shelf / ENCLOSURES;
    const v0 = 1 - (shelf + 1) / ENCLOSURES;
    const base = positions.length / 3;
    positions.push(-BAY_W / 2, y0, z, BAY_W / 2, y0, z, BAY_W / 2, y1, z, -BAY_W / 2, y1, z);
    uvs.push(0, v0, 1, v0, 1, v1, 0, v1);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);

  return geometry;
};

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOutBack = (t: number) => {
  const c = 1.4;

  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
};

const tmpMatrix = new Matrix4();
const tmpMatrix2 = new Matrix4();
const tmpScale = new Matrix4();
const tmpBase = new Matrix4();
const tmpPart = new Matrix4();
const tmpColor = new Color();
const tmpVec = new Vector3();
const tmpQuat = new Quaternion();
const UP = new Vector3(0, 1, 0);

interface Part {
  readonly pool: InstancePool<RackInstance>;
  readonly index: number;
  readonly local: Matrix4;
  readonly shelf?: number; // travels with this shelf's drawer
}

interface LedPart {
  readonly field: LedField<RackInstance>;
  readonly index: number;
  readonly local: Matrix4;
}

interface BladeInstance {
  readonly uid: string;
  model: BladeModel;
  readonly rack: RackInstance;
  slot: number;
  readonly body: number;
  readonly tag: number;
  readonly handle: number;
  readonly status: number;
  readonly activity: number;
  readonly load: number;
  state: "entering" | "present" | "leaving";
  t: number;
  flash: number; // white flash on status change, decays
  matched: boolean;
  fromSlot: number; // where a re-packed blade glides from
  move: number; // 0 → 1 while gliding to its new slot
  pull: number; // 0 → 1 as the selected blade is drawn out on its rails
  pullMode: "slide" | "lift"; // out of a closed shelf it slides forward; out of an open drawer it lifts
}

interface RackInstance {
  readonly key: string;
  model: RackModel;
  readonly virtual: boolean;
  readonly group: Group;
  readonly matrix: Matrix4;
  current: { x: number; z: number; rotation: number };
  target: { x: number; z: number; rotation: number };
  appear: number; // 0 → 1 as it is lowered into place
  nudge: number; // 0 → 1 as a selected rack slides forward out of its row
  leaving: number; // 0 → 1 as it sinks away, −1 while staying
  readonly parts: Part[];
  readonly leds: LedPart[];
  readonly portLeds: number[];
  beacon: LedPart;
  mgmtHealth: LedPart;
  readonly slots: Array<string | undefined>;
  readonly slotsPerEnclosure: number;
  readonly enclosures: number;
  readonly blanks: number[]; // blanking plate per slot beyond the node's capacity
  readonly layout: ShelfLayout;
  readonly shelfLabel: LabelCanvas;
  readonly shelfLabelMeshes: Mesh[]; // one per shelf, so each rides its own drawer
  readonly shelfPull: number[]; // 0 → 1 per shelf as its drawer opens
  overflow: boolean;
  readonly blades: Map<string, BladeInstance>;
  readonly lcd: LabelCanvas;
  readonly nameplate: LabelCanvas;
  readonly lcdMesh: Mesh;
  readonly nameplateMesh: Mesh;
  dirty: boolean;
}

interface Flight {
  fromPosition: Vector3;
  toPosition: Vector3;
  fromTarget: Vector3;
  toTarget: Vector3;
  t: number;
  duration: number;
}

const qualitySettings: Record<Quality, { pixelRatio: number; ao: boolean; shadows: boolean; shadowSize: number; samples: number; reflections: boolean; depthOfField: boolean }> = {
  // Native Retina resolution for as long as possible: a lower tier sheds effects first,
  // and only the last one gives up pixels.
  ultra: { pixelRatio: 2, ao: true, shadows: true, shadowSize: 4096, samples: 4, reflections: true, depthOfField: true },
  high: { pixelRatio: 2, ao: false, shadows: true, shadowSize: 2048, samples: 4, reflections: true, depthOfField: true },
  balanced: { pixelRatio: 1.5, ao: false, shadows: false, shadowSize: 1024, samples: 2, reflections: false, depthOfField: false },
};

const qualityOrder: Quality[] = ["ultra", "high", "balanced"];

export type ShelfInfo = NonNullable<ReturnType<DatacenterScene["shelfInfo"]>>;

export class DatacenterScene {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly controls: OrbitControls;
  private composer!: EffectComposer;
  private bloomPass!: UnrealBloomPass;
  private aoPass?: GTAOPass;
  private readonly textures: SceneTextures;
  private readonly geometries: RackGeometries;
  private readonly materials: Material[] = [];
  private readonly room = new Group();
  private readonly equipment = new Group();
  private readonly pools: Record<string, InstancePool<RackInstance>> = {};
  private readonly bladePools: Record<"body" | "tag" | "handle", InstancePool<BladeInstance>>;
  private readonly ledField: LedField<RackInstance>;
  private readonly bladeLeds: LedField<BladeInstance>;
  private readonly beacons: LedField<RackInstance>;
  private readonly racks = new Map<string, RackInstance>();
  private readonly blades = new Map<string, BladeInstance>();
  private rows: RowPlacement[] = [];
  private roomKey = "";
  private readonly keyLight: DirectionalLight;
  private readonly hemiLight: HemisphereLight;
  private readonly fillLight: DirectionalLight;
  private aisleLights: RectAreaLight[] = [];
  private readonly highlight: { hover: Group; selected: Group };
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private pointerInside = false;
  private pointerDirty = false;
  private pointerDown?: { x: number; y: number; time: number };
  private hovered?: PickTarget;
  private selected?: PickTarget;
  private flight?: Flight;
  private hasFramed = false;
  private model?: DatacenterModel;
  private options: SceneOptions = { network: "all", shelves: "namespace", thermal: false, search: "", quality: "auto" };
  private readonly network: NetworkLayer;
  private readonly hall: DataHall;
  private bokehPass?: BokehPass;
  private clusterFarPoint?: Vector3;
  private readonly bladeCard: LabelCanvas;
  private readonly bladeCardMesh: Mesh;
  private networkModel?: NetworkModel;
  private core?: CorePlacement;
  private quality: Quality = "ultra";
  private readonly themeWatch: ReturnType<typeof watchLensTheme>;
  private theme: LensTheme;
  private readonly bladeBodyMaterials: { lit: Material[] };
  private readonly resizeObserver: ResizeObserver;
  private readonly visibilityObserver: IntersectionObserver;
  private visible = true;
  private readonly clockStart = performance.now();
  private lastFrame = performance.now();
  private frameTimes: number[] = [];
  private slowSince?: number;
  private lastStatsAt = 0;
  private lastPoseAt = 0;
  private eventId = 0;
  private pendingEvents: SceneEvent[] = [];
  private disposed = false;
  private readonly floor: Mesh;
  private readonly floorMaterial: MeshStandardMaterial;
  private roomObjects: Array<Mesh | LineSegments> = [];

  constructor(
    private readonly container: HTMLElement,
    private readonly callbacks: SceneCallbacks,
    initialPose?: CameraPose,
  ) {
    this.themeWatch = watchLensTheme((theme) => this.applyTheme(theme));
    this.theme = this.themeWatch.current();

    this.renderer = new WebGLRenderer({ antialias: false, powerPreference: "high-performance", alpha: false });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.renderer.domElement.style.outline = "none";
    this.renderer.domElement.tabIndex = 0;
    container.appendChild(this.renderer.domElement);

    RectAreaLightUniformsLib.init();

    this.camera = new PerspectiveCamera(55, 1, 0.05, 400);
    this.camera.position.set(4.5, 2.6, 6.5);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 0.35;
    this.controls.maxDistance = 60;
    this.controls.screenSpacePanning = true;
    this.controls.target.set(0, 1.1, 0);
    this.controls.addEventListener("start", () => (this.flight = undefined));

    if (initialPose) {
      this.camera.position.fromArray([...initialPose.position]);
      this.controls.target.fromArray([...initialPose.target]);
      this.hasFramed = true;
    }

    // Image-based lighting from a procedural room: reflections on steel without an HDRI file.
    const pmrem = new PMREMGenerator(this.renderer);
    const environment = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(environment, 0.04).texture;
    environment.dispose();
    pmrem.dispose();
    this.scene.environmentIntensity = 0.55;

    this.textures = createSceneTextures();
    this.geometries = createRackGeometries();

    this.hemiLight = new HemisphereLight(0xbfd4ff, 0x101114, 0.35);
    this.scene.add(this.hemiLight);

    // A soft cool fill from the aisle side, so rack fronts read without flattening them.
    this.fillLight = new DirectionalLight(0xcfe0ff, 0.45);
    this.fillLight.position.set(-4, 3, 10);
    this.scene.add(this.fillLight);

    this.keyLight = new DirectionalLight(0xfff4e8, 1.4);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.bias = -0.0004;
    this.keyLight.shadow.normalBias = 0.02;
    this.scene.add(this.keyLight, this.keyLight.target);

    // Floor.
    this.floorMaterial = this.track(new MeshStandardMaterial({
      map: this.textures.floor,
      roughnessMap: this.textures.floorRoughness,
      roughness: 0.55,
      metalness: 0.15,
      envMapIntensity: 0.6,
    }));
    this.floor = new Mesh(new PlaneGeometry(1, 1), this.floorMaterial);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);



    this.scene.add(this.room, this.equipment);

    // Materials of the equipment.
    const steel = this.track(new MeshStandardMaterial({ color: 0x24282e, roughness: 0.48, metalness: 0.55 }));
    const panel = this.track(new MeshPhysicalMaterial({
      color: 0xffffff,
      map: this.textures.sidePanel,
      roughness: 0.62,
      metalness: 0.35,
      clearcoat: 0.25,
      clearcoatRoughness: 0.5,
    }));
    const perforated = this.track(new MeshStandardMaterial({
      color: 0x2a2e34,
      roughness: 0.45,
      metalness: 0.6,
      alphaMap: this.textures.perforated,
      alphaTest: 0.5,
      side: DoubleSide,
    }));
    this.textures.perforated.repeat.set(6, 10);
    const rail = this.track(new MeshStandardMaterial({ map: this.textures.rail, roughness: 0.32, metalness: 0.9 }));
    const chassis = this.track(new MeshStandardMaterial({ color: 0x2c3036, roughness: 0.42, metalness: 0.65 }));
    const cavity = this.track(new MeshStandardMaterial({ color: 0x050607, roughness: 0.9, metalness: 0.1 }));
    const labelMat = this.track(new MeshStandardMaterial({ map: this.textures.enclosureLabel, roughness: 0.5, metalness: 0.4 }));
    const switchFace = this.track(new MeshStandardMaterial({ map: this.textures.switchFace, roughness: 0.5, metalness: 0.5 }));
    const mgmtFace = this.track(new MeshStandardMaterial({ map: this.textures.mgmtFace, roughness: 0.45, metalness: 0.6 }));
    const upsFace = this.track(new MeshStandardMaterial({ map: this.textures.upsFace, roughness: 0.55, metalness: 0.3 }));
    const cableMgr = this.track(new MeshStandardMaterial({ color: 0x15171a, roughness: 0.8, metalness: 0.2 }));

    const g = this.geometries;
    const pool = (name: string, geometry: BufferGeometry, material: Material, options: { cast?: boolean; receive?: boolean; colors?: boolean } = {}) => {
      this.pools[name] = new InstancePool<RackInstance>(name, geometry, material, this.equipment, {
        castShadow: options.cast ?? true,
        receiveShadow: options.receive ?? true,
        colors: options.colors,
        initialCapacity: 16,
      });
    };

    pool("frame", g.frame, steel, { colors: true });
    pool("sidePanels", g.sidePanels, panel, { colors: true });
    pool("roof", g.roof, perforated);
    pool("rearDoor", g.rearDoor, perforated);
    pool("rails", g.rails, rail, { cast: false });
    pool("enclosure", g.enclosure, chassis, { cast: false });
    pool("enclosureCavity", g.enclosureCavity, cavity, { cast: false });
    const grille = this.track(new MeshStandardMaterial({
      color: 0x30353c,
      roughness: 0.45,
      metalness: 0.65,
      alphaMap: this.textures.perforated,
      alphaTest: 0.5,
      side: DoubleSide,
    }));
    const chrome = this.track(new MeshStandardMaterial({ color: 0xc4cad2, roughness: 0.22, metalness: 0.95 }));
    pool("enclosureTop", g.enclosureTop, grille, { cast: false });
    pool("enclosureSlides", g.enclosureSlides, chrome, { cast: false });
    pool("railChannels", g.railChannels, chassis, { cast: false });
    pool("enclosureLabel", g.enclosureLabel, labelMat, { cast: false });
    pool("switchBody", g.switchBody, chassis, { cast: false });
    pool("switchFace", g.switchFace, switchFace, { cast: false });
    pool("mgmtBody", g.mgmtBody, chassis, { cast: false });
    pool("mgmtFace", g.mgmtFace, mgmtFace, { cast: false });
    pool("upsBody", g.upsBody, chassis, { cast: false });
    pool("upsFace", g.upsFace, upsFace, { cast: false });
    pool("cableManager", g.cableManager, cableMgr, { cast: false });
    pool("blankPanel", g.blankPanel, this.track(new MeshStandardMaterial({ map: this.textures.blankPanel, roughness: 0.5, metalness: 0.5 })), { cast: false });
    pool("bladeBlank", g.bladeBlank, this.track(new MeshStandardMaterial({ map: this.textures.bladeBlank, roughness: 0.45, metalness: 0.6 })), { cast: false });

    // Blades: a lit, textured faceplate, or in the thermal view an unlit heat colour.
    const bladeSide = this.track(new MeshStandardMaterial({ map: this.textures.bladeSide, roughness: 0.42, metalness: 0.7 }));
    const bladeTop = this.track(new MeshStandardMaterial({ map: this.textures.bladeTop, roughness: 0.45, metalness: 0.65 }));
    const bladeBack = this.track(new MeshStandardMaterial({ color: 0x24282e, roughness: 0.6, metalness: 0.5 }));
    const bladeFront = this.track(new MeshStandardMaterial({
      map: this.textures.bladeFace,
      bumpMap: this.textures.bladeFaceBump,
      bumpScale: 1.2,
      roughness: 0.38,
      metalness: 0.75,
    }));
    this.bladeBodyMaterials = {
      lit: [bladeSide, bladeSide, bladeTop, bladeBack, bladeFront, bladeBack],
    };
    const tagMaterial = this.track(new MeshStandardMaterial({ roughness: 0.62, metalness: 0.05 }));
    const handleMaterial = this.track(new MeshStandardMaterial({ color: 0xc9ced6, roughness: 0.25, metalness: 0.95 }));

    this.bladePools = {
      // Each blade carries its own pod's heat in the thermal view, in its instance colour.
      body: new InstancePool<BladeInstance>("bladeBody", g.bladeBody, this.bladeBodyMaterials.lit, this.equipment, { colors: true, initialCapacity: 256, receiveShadow: true, thermal: "instance" }),
      tag: new InstancePool<BladeInstance>("bladeTag", g.bladeTag, tagMaterial, this.equipment, { colors: true, initialCapacity: 256 }),
      handle: new InstancePool<BladeInstance>("bladeHandle", g.bladeHandle, handleMaterial, this.equipment, { initialCapacity: 256 }),
    };

    this.ledField = new LedField<RackInstance>("rackLeds", g.led, this.equipment, 512);
    this.bladeLeds = new LedField<BladeInstance>("bladeLeds", g.led, this.equipment, 512);
    // The load meter shares the LED shader, with its own box geometry.
    this.beacons = new LedField<RackInstance>("beacons", g.beacon, this.equipment, 32);
    this.loadBars = new LedField<BladeInstance>("loadBars", g.loadBar, this.equipment, 256);

    this.highlight = { hover: this.createHighlight(), selected: this.createHighlight() };

    // The tag on the side of a blade drawn out of its rack.
    this.bladeCard = new LabelCanvas(1024, 620, 2.5);
    this.bladeCardMesh = new Mesh(this.geometries.lcd, new MeshBasicMaterial({ map: this.bladeCard.texture, transparent: true, depthWrite: false, side: DoubleSide }));
    this.bladeCardMesh.matrixAutoUpdate = false;
    this.bladeCardMesh.visible = false;
    this.bladeCardMesh.renderOrder = 3;
    this.bladeCardMesh.userData["thermal"] = "keep";
    this.scene.add(this.bladeCardMesh);

    this.network = new NetworkLayer(
      {
        parent: this.equipment,
        geometries: this.geometries,
        textures: this.textures,
        rackMaterials: { frame: steel, sidePanels: panel, rails: rail, roof: perforated, rearDoor: perforated, chassis, cableManager: cableMgr },
        rackPose: (key) => this.racks.get(key)?.target,
        bladeAnchor: (uid) => this.bladeAnchor(uid),
      },
      this.theme,
    );

    this.hall = new DataHall(
      {
        parent: this.room,
        geometries: this.geometries,
      },
      this.theme,
    );

    this.applyQuality("ultra");
    this.applyTheme(this.theme);

    // Events.
    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("dblclick", this.onDoubleClick);
    canvas.addEventListener("keydown", this.onKeyDown);

    // Resized on the next frame, not inside the observer's callback, which would otherwise
    // trip the browser's "ResizeObserver loop" warning.
    let resizeFrame = 0;
    this.resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => !this.disposed && this.resize());
    });
    this.resizeObserver.observe(container);
    this.visibilityObserver = new IntersectionObserver(([entry]) => {
      this.visible = Boolean(entry?.isIntersecting);
    });
    this.visibilityObserver.observe(container);
    this.resize();

    this.renderer.setAnimationLoop(this.frame);
  }

  private readonly loadBars: LedField<BladeInstance>;

  private track<T extends Material>(material: T): T {
    this.materials.push(material);

    return material;
  }

  private createHighlight() {
    const group = new Group();
    group.matrixAutoUpdate = false;
    group.userData["thermal"] = "keep";
    const box = new BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    const edges = new LineSegments(new EdgesGeometry(box), new LineBasicMaterial({ color: 0xffffff, transparent: true }));
    const fill = new Mesh(box, new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, depthWrite: false, blending: AdditiveBlending }));
    edges.renderOrder = 10;
    group.add(fill, edges);
    group.visible = false;
    this.scene.add(group);

    return group;
  }

  // ---------------------------------------------------------------------------
  // Theme and quality

  private ledColors!: Record<PodHealth, Color>;

  private applyTheme(theme: LensTheme) {
    this.theme = theme;

    if (this.thermal?.enabled) {
      this.network?.setTheme(theme);
      this.hall?.setTheme(theme);

      return;
    }

    // The room recedes into Lens's own background, so the view sits in the app.
    const background = theme.background.clone();
    this.scene.background = background;
    if (this.scene.fog instanceof FogExp2) this.scene.fog.color.copy(background);
    else this.scene.fog = new FogExp2(background.getHex(), 0.025);
    this.renderer.setClearColor(background);

    // A light theme gets a brighter, airier room; the equipment stays dark steel.
    this.hemiLight.color.set(theme.isDark ? 0xbfd4ff : 0xffffff);
    this.hemiLight.groundColor.copy(theme.isDark ? new Color(0x101114) : background.clone().multiplyScalar(0.6));
    // A dark hall in the dark theme, so the equipment's own light carries the scene.
    this.hemiLight.intensity = theme.isDark ? 0.2 : 0.8;
    this.scene.environmentIntensity = theme.isDark ? 0.38 : 0.8;
    this.floorMaterial.color.copy(theme.isDark ? new Color(0xffffff) : new Color(1.9, 1.9, 1.95));

    this.ledColors = {
      running: ledOf(theme.success, 1.8),
      pending: ledOf(theme.warning, 2.2),
      failed: ledOf(theme.critical, 2.6),
      succeeded: ledOf(theme.primary, 1.6),
      terminating: new Color(0.7, 0.72, 0.78),
      unknown: new Color(0.9, 0.2, 1.8),
    };

    const accent = ledOf(theme.primary, 1.2);

    for (const group of [this.highlight.hover, this.highlight.selected]) {
      ((group.children[1] as LineSegments).material as Material).dispose();
    }

    (this.highlight.hover.children[1] as LineSegments).material = new LineBasicMaterial({ color: accent, transparent: true });
    ((this.highlight.hover.children[0] as Mesh).material as MeshBasicMaterial).color.copy(theme.primary);
    (this.highlight.selected.children[1] as LineSegments).material = new LineBasicMaterial({ color: ledOf(theme.primary, 1.1).lerp(new Color(1, 1, 1), 0.35), transparent: true });
    ((this.highlight.selected.children[0] as Mesh).material as MeshBasicMaterial).color.copy(theme.primary).multiplyScalar(0.9);

    this.network?.setTheme(theme);
    this.hall?.setTheme(theme);

    // Everything coloured from the theme is redrawn.
    for (const rack of this.racks.values()) {
      this.updateRackStatus(rack, true);

      for (const blade of rack.blades.values()) this.updateBladeLook(blade);
    }
  }

  setQuality(setting: SceneOptions["quality"]) {
    this.options = { ...this.options, quality: setting };
    this.slowSince = undefined;
    this.applyQuality(setting === "auto" ? "ultra" : setting);
  }

  private qualityChangedAt = performance.now();

  private applyQuality(quality: Quality) {
    this.quality = quality;
    this.qualityChangedAt = performance.now();
    const settings = qualitySettings[quality];

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, settings.pixelRatio));
    this.renderer.shadowMap.enabled = settings.shadows;
    this.keyLight.castShadow = settings.shadows;
    this.keyLight.shadow.mapSize.set(settings.shadowSize, settings.shadowSize);
    this.keyLight.shadow.map?.dispose();
    this.keyLight.shadow.map = null;

    for (const pass of this.composer?.passes ?? []) pass.dispose();
    this.composer?.dispose();
    this.aoPass?.dispose();
    this.bloomPass?.dispose();

    const size = this.renderer.getSize(new Vector2());
    const target = new WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), { type: HalfFloatType, samples: settings.samples });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    this.aoPass = undefined;

    if (settings.ao) {
      this.aoPass = new GTAOPass(this.scene, this.camera, size.x, size.y);
      this.aoPass.updateGtaoMaterial({ radius: 0.35, distanceExponent: 1.4, thickness: 1, scale: 1.1, samples: 12 });
      this.aoPass.blendIntensity = 0.85;
      this.composer.addPass(this.aoPass);
    }

    // Depth of field, focused on what the camera orbits: the racks around it soften, the
    // far end of the hall melts into its haze.
    this.bokehPass = undefined;

    if (settings.depthOfField) {
      this.bokehPass = new BokehPass(this.scene, this.camera, { focus: 8, aperture: 0.00045, maxblur: 0.0045 });
      // Depth, not defocus: nothing nearer than the focal distance blurs, only what lies
      // beyond it, more the further it recedes.
      this.bokehPass.materialBokeh.fragmentShader = this.bokehPass.materialBokeh.fragmentShader.replace(
        "float factor = ( focus + viewZ );",
        "float factor = min( focus + viewZ, 0.0 );",
      );
      this.bokehPass.materialBokeh.needsUpdate = true;
      this.composer.addPass(this.bokehPass);
    }

    this.hall?.setReflections(settings.reflections && !this.thermal?.enabled);
    this.floorMaterial.transparent = settings.reflections;
    this.floorMaterial.opacity = settings.reflections ? 0.8 : 1;
    this.floorMaterial.needsUpdate = true;

    this.bloomPass = new UnrealBloomPass(new Vector2(size.x, size.y), 0.6, 0.38, 1.05);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
    this.resize();
  }

  private readonly thermal = new ThermalView();

  // The thermal camera: every surface as heat, against a dark violet; reflections, lights
  // and LEDs gone, as a thermal camera would not see them.
  private setThermal(on: boolean) {
    this.thermal.enabled = on;

    if (on) {
      this.bakeHeat();
      this.thermal.apply(this.scene);
      this.scene.background = ThermalView.background;
      (this.scene.fog as FogExp2 | null)?.color.copy(ThermalView.background);
    } else {
      this.thermal.restore();
      this.applyTheme(this.theme);
      this.hall.setReflections(qualitySettings[this.quality].reflections);
    }

    for (const blade of this.blades.values()) this.updateBladeLook(blade);
  }

  // The heat field from the data: each shelf at its pods' load, each rack's frame and
  // equipment at its node's CPU use.
  private bakeHeat() {
    if (!this.rows.length) return;

    const rowIndex = (z: number) => this.rows.findIndex((row) => Math.abs(row.z - z) < 0.01);
    const racks: HeatRack[] = [];

    for (const rack of this.racks.values()) {
      if (rack.leaving >= 0) continue;
      const model = rack.model;
      const node = Math.min(1, ((model.cpuUsageMilli ?? model.cpuRequestedMilli) / Math.max(1, model.cpuAllocatableMilli)) * 1.6);
      const shelves = Array.from({ length: ENCLOSURES }, (_, shelf) => {
        const blades = [...rack.blades.values()].filter((b) => Math.floor(b.slot / rack.slotsPerEnclosure) === shelf && b.state !== "leaving");

        return blades.length ? blades.reduce((t, b) => t + Math.min(1, this.bladeLoad(b.model, model) / 1.2), 0) / blades.length : 0;
      });
      const shelfYs = Array.from({ length: ENCLOSURES }, (_, shelf) => [uY(ENCLOSURE_BOTTOM_U(shelf)), uY(ENCLOSURE_BOTTOM_U(shelf)) + ENC_H] as const);

      // Where the rack and its open drawer will stand, so their heat goes with them.
      const out = this.selectedRackKey() === rack.key;
      const open = this.openShelf?.rack === rack.key ? { index: this.openShelf.shelf, pull: SHELF_PULL } : undefined;
      racks.push({ x: rack.target.x, row: Math.max(0, rowIndex(rack.target.z)), node, shelves, shelfYs, forward: out ? RACK_NUDGE : 0, openShelf: open });
    }

    if (this.core) racks.push({ x: this.core.x, row: Math.max(0, rowIndex(this.core.z)), node: 0.55, shelves: [], shelfYs: [] });

    let hottestBlade = 0;
    for (const blade of this.blades.values()) hottestBlade = Math.max(hottestBlade, Math.min(1, this.bladeLoad(blade.model, blade.rack.model) / 1.2));

    this.thermal.bake(
      this.rows.map((row) => row.z),
      Math.min(...this.rows.map((row) => row.x0), this.core?.x ?? 0),
      Math.max(...this.rows.map((row) => row.x1)),
      racks,
      hottestBlade,
    );
  }

  setOptions(options: Partial<SceneOptions>) {
    const previous = this.options;
    this.options = { ...this.options, ...options };

    if (options.quality && options.quality !== previous.quality) this.setQuality(options.quality);

    if (options.network && options.network !== previous.network) this.network.setMode(options.network);
    if (options.shelves && options.shelves !== previous.shelves) this.repack();

    if (options.thermal !== undefined && options.thermal !== previous.thermal) this.setThermal(this.options.thermal);

    for (const blade of this.blades.values()) this.updateBladeLook(blade);
    for (const rack of this.racks.values()) this.updateRackFilterLook(rack);
  }

  // ---------------------------------------------------------------------------
  // Model sync

  setClusterName(name: string) {
    this.hall.setClusterName(name);
  }

  updateNetwork(network: NetworkModel | undefined) {
    this.networkModel = network;

    if (this.model) this.network.update(this.model, network);
  }

  // Where a blade's fibre plugs in, at its final position: the front of the blade, just
  // under its top edge; and the height of its enclosure's top bezel, where fibres cross.
  private bladeAnchor(uid: string) {
    const blade = this.blades.get(uid);
    if (!blade || blade.state === "leaving" || blade.rack.virtual) return undefined;

    const slot = this.slotTransform(blade.rack, blade.slot);
    // Wherever the blade is right now: drawn out, lifted, on a drawer.
    const position = new Vector3(0, BLADE_H - 0.008, 0.0065).applyMatrix4(this.bladeMatrix(blade, new Matrix4()));

    return {
      position,
      rackKey: blade.rack.key,
      enclosureTop: slot.y - ENC_BOTTOM_BEZEL - 0.003 + 5 * U - 0.006,
    };
  }

  update(model: DatacenterModel) {
    const isFirst = !this.model;
    this.model = model;

    const rackModels: Array<{ key: string; model: RackModel; virtual: boolean }> = model.racks.map((rack) => ({ key: rack.name, model: rack, virtual: false }));

    if (model.unscheduled.length > 0) {
      rackModels.push({ key: " unscheduled", model: unscheduledRack(model.unscheduled), virtual: true });
    }

    const layout = layoutRacks(rackModels.length);
    const keys = new Set(rackModels.map((rack) => rack.key));

    // Racks that are gone sink into the floor.
    for (const rack of this.racks.values()) {
      if (!keys.has(rack.key) && rack.leaving < 0) {
        rack.leaving = 0;

        if (!rack.virtual) this.emit("rack-removed", `Node ${rack.key} left the cluster`);
      }
    }

    rackModels.forEach(({ key, model: rackModel, virtual }, i) => {
      const placement = layout.placements[i]!;
      let rack = this.racks.get(key);

      // A rack that needs more slots than it was built with (capacity raised, a burst of
      // pending pods) is rebuilt in place, without the entrance animation.
      const wanted = Math.max(rackModel.podCapacity, rackModel.blades.length);
      if (rack && rack.leaving < 0 && wanted > rack.slots.length) {
        this.destroyRack(rack);
        rack = this.createRack(key, rackModel, virtual, placement, true);
        this.syncBlades(rack, rackModel.blades, true);
      }

      if (!rack || rack.leaving >= 0) {
        if (rack) this.destroyRack(rack);
        rack = this.createRack(key, rackModel, virtual, placement, isFirst);

        if (!isFirst && !virtual) this.emit("rack-added", `Node ${key} joined the cluster`, { type: "rack", name: key });
      } else {
        if (!virtual && rack.model.ready !== rackModel.ready) {
          this.emit(rackModel.ready ? "rack-up" : "rack-down", rackModel.ready ? `Node ${key} is Ready again` : `Node ${key} is NotReady`, { type: "rack", name: key });
        }

        rack.model = rackModel;
      }

      rack.target = { x: placement.x, z: placement.z, rotation: placement.rotation };
      this.syncBlades(rack, rackModel.blades, isFirst);
      this.updateRackStatus(rack);
      this.drawShelfLabels(rack);
    });

    this.rows = layout.rows;
    this.core = layout.core;
    this.buildRoom();
    this.network.setLayout(layout.core, layout.rows);
    this.network.update(model, this.networkModel);
    if (this.thermal.enabled) this.bakeHeat();

    if (!this.hasFramed && rackModels.length > 0) {
      this.hasFramed = true;
      this.frameAll(false);
    }

    this.flushEvents();
  }

  private createRack(key: string, model: RackModel, virtual: boolean, placement: RackPlacement, instant: boolean): RackInstance {
    const group = new Group();
    group.matrixAutoUpdate = false;
    this.equipment.add(group);

    // Every rack is full height: seven shelves of sixteen bays (more for a node that can
    // run more than 112 pods), the node's pod capacity spread over them as open bays.
    const wanted = Math.max(model.podCapacity, model.blades.length);
    const enclosures = ENCLOSURES;
    const spe = Math.max(16, Math.ceil(wanted / enclosures));
    const layout = shelfLayout(enclosures, spe, virtual ? enclosures * spe : wanted);

    // The bezel strip under each shelf names the namespaces on it: one canvas per rack,
    // one quad per shelf.
    // Retina-crisp labels while the room is small enough for the memory they take.
    const textScale = (this.model?.racks.length ?? 0) > 30 ? 1 : 2;
    const shelfLabel = new LabelCanvas(1024, 40 * ENCLOSURES, textScale);
    const shelfLabelMaterial = new MeshBasicMaterial({ map: shelfLabel.texture });
    const shelfLabelMeshes = Array.from({ length: ENCLOSURES }, (_, shelf) => {
      const mesh = new Mesh(shelfLabelGeometry(shelf), shelfLabelMaterial);
      group.add(mesh);

      return mesh;
    });

    const lcd = new LabelCanvas(768, 184, textScale);
    const nameplate = new LabelCanvas(768, 160, textScale);
    const lcdMaterial = new MeshBasicMaterial({ map: lcd.texture, toneMapped: false });
    const lcdMesh = new Mesh(this.geometries.lcd, lcdMaterial);
    lcdMesh.scale.set(0.3016, 0.0724, 1);
    lcdMesh.position.set(0, uY(MGMT_U) + U, FRONT_Z + 0.0045);
    group.add(lcdMesh);

    const nameplateMaterial = new MeshStandardMaterial({ map: nameplate.texture, emissiveMap: nameplate.texture, emissive: 0xffffff, emissiveIntensity: 0.38, roughness: 0.3, metalness: 0 });
    const nameplateMesh = new Mesh(this.geometries.nameplate, nameplateMaterial);
    nameplateMesh.scale.set(0.56, 0.1167, 1);
    nameplateMesh.position.set(0, SIGN_Y + 0.07, RACK_D / 2 - 0.018);
    group.add(nameplateMesh);


    const rack: RackInstance = {
      key,
      model,
      virtual,
      group,
      matrix: new Matrix4(),
      current: { x: placement.x, z: placement.z, rotation: placement.rotation },
      target: { x: placement.x, z: placement.z, rotation: placement.rotation },
      appear: instant ? 1 : 0,
      nudge: 0,
      leaving: -1,
      parts: [],
      leds: [],
      portLeds: [],
      beacon: undefined as unknown as LedPart,
      mgmtHealth: undefined as unknown as LedPart,
      slots: new Array(spe * enclosures).fill(undefined),
      slotsPerEnclosure: spe,
      enclosures,
      blanks: [],
      layout,
      shelfLabel,
      shelfLabelMeshes,
      shelfPull: new Array(ENCLOSURES).fill(0),
      overflow: false,
      blades: new Map(),
      lcd,
      nameplate,
      lcdMesh,
      nameplateMesh,
      dirty: true,
    };

    const add = (name: string, local = new Matrix4(), shelf?: number) => {
      const pool = this.pools[name]!;
      rack.parts.push({ pool, index: pool.alloc(rack), local, shelf });
    };
    const at = (u: number) => new Matrix4().makeTranslation(0, uY(u), FRONT_Z);

    add("frame");
    add("rails");
    add("roof");
    add("rearDoor");

    if (!virtual) add("sidePanels");

    for (let e = 0; e < ENCLOSURES; e++) {
      add("enclosure", at(ENCLOSURE_BOTTOM_U(e)), e);
      add("enclosureTop", at(ENCLOSURE_BOTTOM_U(e)), e);
      add("enclosureSlides", at(ENCLOSURE_BOTTOM_U(e)), e);
      add("enclosureCavity", at(ENCLOSURE_BOTTOM_U(e)), e);
      add("enclosureLabel", at(ENCLOSURE_BOTTOM_U(e)), e);
      add("railChannels", at(ENCLOSURE_BOTTOM_U(e)));
    }

    add("blankPanel", at(3));

    const blankPool = this.pools["bladeBlank"]!;

    for (let slot = 0; slot < rack.slots.length; slot++) rack.blanks.push(blankPool.alloc(rack));

    add("switchBody", at(SWITCH_U));
    add("switchFace", at(SWITCH_U));
    add("cableManager", at(CABLE_MGR_U));
    add("mgmtBody", at(MGMT_U));
    add("mgmtFace", at(MGMT_U));
    add("upsBody", at(UPS_U));
    add("upsFace", at(UPS_U));

    // The virtual rack of unscheduled pods is an open staging frame in Lens's warning colour.
    if (virtual) {
      const tint = this.theme.warning.clone().multiplyScalar(1.6);

      for (const part of rack.parts) {
        if (part.pool.name === "frame") part.pool.setColor(part.index, tint);
      }
    } else {
      for (const part of rack.parts) {
        if (part.pool.name === "frame" || part.pool.name === "sidePanels") part.pool.setColor(part.index, new Color(1, 1, 1));
      }
    }

    const led = (field: LedField<RackInstance>, local: Matrix4): LedPart => {
      const part = { field, index: field.pool.alloc(rack), local };
      rack.leds.push(part);

      return part;
    };

    // Switch port LEDs, matching the ports drawn on its faceplate.
    for (let i = 0; i < 24; i++) {
      const px = 150 + i * 30 + Math.floor(i / 6) * 12 + 18;
      const py = (i % 2 ? 26 : 6) + 3;
      const part = led(this.ledField, new Matrix4().makeTranslation((px / 1024 - 0.5) * EQUIPMENT_W, uY(SWITCH_U) + U * (1 - py / 48), FRONT_Z + 0.005).multiply(new Matrix4().makeScale(0.6, 0.6, 1)));
      rack.portLeds.push(part.index);
    }

    // Management unit: power and health.
    led(this.ledField, new Matrix4().makeTranslation((60 / 512 - 0.5) * EQUIPMENT_W, uY(MGMT_U) + 2 * U * (1 - 70 / 96), FRONT_Z + 0.005));
    rack.mgmtHealth = led(this.ledField, new Matrix4().makeTranslation((60 / 512 - 0.5) * EQUIPMENT_W + 0.012, uY(MGMT_U) + 2 * U * (1 - 70 / 96), FRONT_Z + 0.005));
    this.ledField.set(rack.leds[rack.leds.length - 2]!.index, ledOf(this.theme.primary, 1.4), LedMode.steady);

    // UPS: three steady LEDs and one breathing on battery charge.
    for (let i = 0; i < 3; i++) {
      const part = led(this.ledField, new Matrix4().makeTranslation((((140 + i * 12) / 512) - 0.5) * EQUIPMENT_W, uY(UPS_U) + 2 * U * 0.32, FRONT_Z + 0.006));
      this.ledField.set(part.index, i === 2 ? ledOf(this.theme.success, 1.2) : ledOf(this.theme.success, 1.6), i === 2 ? LedMode.breathe : LedMode.steady, 0.25, i);
    }

    rack.beacon = led(this.beacons, new Matrix4().makeTranslation(RACK_W / 2 - 0.04, SIGN_Y + 0.14, RACK_D / 2 - 0.04));

    this.racks.set(key, rack);
    this.updateRackStatus(rack, true);

    return rack;
  }

  private needsResync = false;

  private destroyRack(rack: RackInstance) {
    for (const blade of rack.blades.values()) this.destroyBlade(blade);
    for (const part of rack.parts) part.pool.release(part.index);
    for (const blank of rack.blanks) this.pools["bladeBlank"]!.release(blank);
    for (const led of rack.leds) led.field.pool.release(led.index);
    this.equipment.remove(rack.group);
    rack.lcd.dispose();
    rack.nameplate.dispose();
    rack.shelfLabel.dispose();
    rack.shelfLabelMeshes.forEach((mesh) => mesh.geometry.dispose());
    (rack.shelfLabelMeshes[0]!.material as Material).dispose();
    (rack.lcdMesh.material as Material).dispose();
    (rack.nameplateMesh.material as Material).dispose();
    this.racks.delete(rack.key);

    if (this.selected?.type === "rack" && this.selected.name === rack.key) this.select(undefined);
  }

  private syncBlades(rack: RackInstance, models: readonly BladeModel[], instant: boolean) {
    const seen = new Set<string>();
    const sizes = new Map<string, number>();

    for (const model of models) sizes.set(model.namespace, (sizes.get(model.namespace) ?? 0) + 1);

    // New blades of big namespaces first, so a namespace lands on shelves of its own.
    const ordered = [...models].sort((a, b) => (sizes.get(b.namespace)! - sizes.get(a.namespace)!) || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));

    for (const model of ordered) {
      seen.add(model.uid);
      const existing = rack.blades.get(model.uid);

      // Dropped and re-added within the exit animation (a relist): start over cleanly.
      if (existing && existing.state === "leaving") this.destroyBlade(existing);

      if (existing && existing.state !== "leaving") {
        const before = existing.model;
        existing.model = model;

        if (before.health !== model.health) {
          existing.flash = 1;

          if (!rack.virtual && model.health === "failed") this.emit("failed", `${model.namespace}/${model.name} is failing: ${model.reason ?? "Error"}`, { type: "blade", uid: model.uid });
          else if (!rack.virtual && before.health !== "running" && model.health === "running") this.emit("recovered", `${model.namespace}/${model.name} is running on ${rack.key}`, { type: "blade", uid: model.uid });
        }

        if (model.restarts > before.restarts && !rack.virtual) {
          existing.flash = 1;
          this.emit("restarted", `${model.namespace}/${model.name} restarted (${model.restarts}×)`, { type: "blade", uid: model.uid });
        }

        this.updateBladeLook(existing);
        continue;
      }

      const slot = pickSlot(rack.layout, rack.slots, model.namespace, (uid) => this.blades.get(uid)?.model.namespace ?? rack.blades.get(uid)?.model.namespace, this.options.shelves);
      if (slot < 0) {
        // Full, usually for a moment while blades leave; synced again once one has.
        rack.overflow = true;
        continue;
      }

      const blade = this.createBlade(rack, model, slot, instant);

      if (!instant && !rack.virtual) this.emit("added", `${model.namespace}/${model.name} scheduled on ${rack.key}`, { type: "blade", uid: model.uid });

      this.updateBladeLook(blade);
    }

    for (const blade of rack.blades.values()) {
      if (!seen.has(blade.uid) && blade.state !== "leaving") {
        blade.state = "leaving";
        blade.t = 0;

        if (!rack.virtual) this.emit("removed", `${blade.model.namespace}/${blade.model.name} removed from ${rack.key}`);
      }
    }
  }

  private createBlade(rack: RackInstance, model: BladeModel, slot: number, instant: boolean): BladeInstance {
    rack.slots[slot] = model.uid;
    this.placeBlank(rack, slot);
    const blade: BladeInstance = {
      uid: model.uid,
      model,
      rack,
      slot,
      body: this.bladePools.body.alloc(),
      tag: this.bladePools.tag.alloc(),
      handle: this.bladePools.handle.alloc(),
      status: this.bladeLeds.pool.alloc(),
      activity: this.bladeLeds.pool.alloc(),
      load: this.loadBars.pool.alloc(),
      state: instant ? "present" : "entering",
      t: instant ? 1 : 0,
      flash: instant ? 0 : 1,
      matched: true,
      fromSlot: slot,
      move: 1,
      pull: 0,
      pullMode: "slide",
    };

    // Picking resolves instances to blades through the pools' owners.
    this.bladePools.body.setOwner(blade.body, blade);
    rack.blades.set(model.uid, blade);
    this.blades.set(model.uid, blade);
    this.placeBlade(blade);

    return blade;
  }

  private destroyBlade(blade: BladeInstance) {
    this.bladePools.body.release(blade.body);
    this.bladePools.tag.release(blade.tag);
    this.bladePools.handle.release(blade.handle);
    this.bladeLeds.pool.release(blade.status);
    this.bladeLeds.pool.release(blade.activity);
    this.loadBars.pool.release(blade.load);
    blade.rack.slots[blade.slot] = undefined;
    if (blade.rack.overflow) this.needsResync = true;
    blade.rack.blades.delete(blade.uid);

    if (this.racks.get(blade.rack.key) === blade.rack) {
      this.placeBlank(blade.rack, blade.slot);
      this.drawShelfLabels(blade.rack);
    }

    // A pod that moved racks (scheduled from the staging frame) keeps its uid: only the
    // blade currently standing for it may clear the selection.
    if (this.blades.get(blade.uid) !== blade) return;

    this.blades.delete(blade.uid);
    if (this.selected?.type === "blade" && this.selected.uid === blade.uid) this.select(undefined);
    if (this.hovered?.type === "blade" && this.hovered.uid === blade.uid) this.setHover(undefined);
  }

  // A fresh arrangement for every rack; blades glide to their new bays.
  private repack() {
    for (const rack of this.racks.values()) {
      const blades = [...rack.blades.values()].filter((blade) => blade.state !== "leaving");
      const plan = planShelves(rack.layout, blades.map((blade) => ({ uid: blade.uid, namespace: blade.model.namespace, name: blade.model.name })), this.options.shelves);

      for (const blade of blades) {
        const slot = plan.get(blade.uid);
        if (slot === undefined || slot === blade.slot) continue;
        blade.fromSlot = blade.slot;
        blade.slot = slot;
        blade.move = 0;
      }

      rack.slots.fill(undefined);
      for (const blade of rack.blades.values()) rack.slots[blade.slot] = blade.uid;
      for (let slot = 0; slot < rack.slots.length; slot++) this.placeBlank(rack, slot);
      this.drawShelfLabels(rack);
    }

    if (this.model) this.network.update(this.model, this.networkModel);
  }

  private drawShelfLabels(rack: RackInstance) {
    const namespaceOf = (uid: string) => rack.blades.get(uid)?.model.namespace;
    const rows = Array.from({ length: ENCLOSURES }, (_, shelf) => {
      const namespaces = shelfNamespaces(rack.layout, rack.slots, shelf, namespaceOf);
      const open = rack.layout.usable.slice(shelf * rack.slotsPerEnclosure, (shelf + 1) * rack.slotsPerEnclosure).filter(Boolean).length;
      const used = namespaces.reduce((total, [, count]) => total + count, 0);

      return { namespaces, open, used };
    });
    const key = [this.options.shelves, this.theme.key, JSON.stringify(rows)].join("|");

    rack.shelfLabel.draw(key, (ctx, w, h) => {
      const rowH = h / ENCLOSURES;

      rows.forEach(({ namespaces, open, used }, shelf) => {
        const y = shelf * rowH;
        ctx.fillStyle = "#1a1d21";
        ctx.fillRect(0, y, w, rowH);
        ctx.textBaseline = "middle";
        ctx.font = `600 22px ${UI_FONT}`;
        let x = 16;

        if (namespaces.length === 0) {
          ctx.fillStyle = "#5d646d";
          ctx.fillText(open > 0 ? "OPEN" : "SEALED", x, y + rowH / 2);
        }

        for (const [namespace] of namespaces) {
          if (x > w - 220) {
            ctx.fillStyle = "#8b929b";
            ctx.fillText(`+${namespaces.length - namespaces.findIndex(([n]) => n === namespace)}`, x, y + rowH / 2);
            break;
          }

          ctx.fillStyle = namespaceCss(namespace);
          ctx.fillRect(x, y + rowH / 2 - 7, 14, 14);
          x += 22;
          ctx.fillStyle = "#d5d9df";
          const text = fitText(ctx, namespace, Math.min(320, w - 240 - x));
          ctx.fillText(text, x, y + rowH / 2);
          x += ctx.measureText(text).width + 26;
        }

        ctx.fillStyle = "#8b929b";
        ctx.textAlign = "right";
        ctx.fillText(open > 0 ? `${used}/${open}` : "", w - 16, y + rowH / 2);
        ctx.textAlign = "left";
      });
    });
  }

  private bladeLoad(blade: BladeModel, rack: RackModel) {
    if (blade.cpuUsageMilli !== undefined) {
      return blade.cpuRequestMilli > 0 ? blade.cpuUsageMilli / blade.cpuRequestMilli : blade.cpuUsageMilli / 250;
    }

    return rack.cpuAllocatableMilli > 0 ? blade.cpuRequestMilli / (rack.cpuAllocatableMilli * 0.15) : 0;
  }

  private updateBladeLook(blade: BladeInstance) {
    const { model } = blade;
    const filtering = isFiltering(this.options);
    const matched = bladeMatches(model, this.options);
    blade.matched = matched;
    const dim = matched ? 1 : 0.14;
    const load = this.bladeLoad(model, blade.rack.model);

    // Faceplate tint: neutral steel, or the heat colour in the thermal view.
    // In the thermal view the colour carries the blade's heat, read by the thermal material.
    if (this.options.thermal) tmpColor.setScalar(Math.min(1, load / 1.2) * (matched ? 1 : 0.4));
    // A match while filtering takes Lens's accent, so it can be found from across the room.
    else if (filtering && matched) tmpColor.setRGB(1, 1, 1).lerp(this.theme.primary, 0.65).multiplyScalar(1.8);
    else tmpColor.setScalar(matched ? 1 : 0.3);

    this.bladePools.body.setColor(blade.body, tmpColor);
    this.bladePools.tag.setColor(blade.tag, namespaceColor(model.namespace).multiplyScalar(dim));

    const led = this.ledColors[model.health].clone().multiplyScalar(dim);
    const statusMode: LedModeValue =
      model.health === "pending" ? LedMode.blink
      : model.health === "failed" ? LedMode.blink
      : model.health === "terminating" || model.health === "unknown" ? LedMode.breathe
      : LedMode.steady;
    const statusRate = model.health === "failed" ? 2.6 : model.health === "pending" ? 1.1 : 0.6;
    const phase = (hashUid(blade.uid) % 1000) / 1000;
    this.bladeLeds.set(blade.status, led, statusMode, statusRate, phase);

    // Activity LED: flickers with how busy the pod is.
    const active = model.health === "running" ? Math.min(1, 0.15 + load * 0.85) : 0;
    this.bladeLeds.set(blade.activity, ledOf(this.theme.success, 1.4).multiplyScalar(dim), active > 0 ? LedMode.flicker : LedMode.steady, 7 + active * 16, phase * 7, active > 0 ? active : 0);

    if (active === 0) this.bladeLeds.set(blade.activity, new Color(0.02, 0.02, 0.02), LedMode.steady);

    loadBarColor(Math.min(1, load), tmpColor).multiplyScalar(dim * 0.9);
    this.loadBars.set(blade.load, tmpColor, LedMode.steady);
    this.placeBlade(blade);
  }

  // While filtering, racks holding matches stay lit and call out with an accent beacon;
  // the rest dim, so hits can be found from across the room.
  private updateRackFilterLook(rack: RackInstance) {
    const filtering = isFiltering(this.options);
    const hits = filtering ? [...rack.blades.values()].filter((blade) => blade.matched && blade.state !== "leaving").length : 0;
    const material = rack.nameplateMesh.material;

    // In the thermal view the plate wears the heat material; leaving the view updates it again.
    if (material instanceof MeshStandardMaterial) {
      material.emissiveIntensity = !filtering || hits > 0 ? 0.38 : 0.06;
      material.color.setScalar(!filtering || hits > 0 ? 1 : 0.35);
    }

    if (filtering && hits > 0) this.beacons.set(rack.beacon.index, ledOf(this.theme.primary, 2.6), LedMode.breathe, 0.8);
    else this.updateBeacon(rack);
  }

  private updateBeacon(rack: RackInstance) {
    const { model } = rack;
    const theme = this.theme;

    if (rack.virtual) this.beacons.set(rack.beacon.index, ledOf(theme.warning, 2.4), LedMode.strobe, 0.9);
    else if (!model.ready) this.beacons.set(rack.beacon.index, ledOf(theme.critical, 3), LedMode.strobe, 1.6);
    else if (model.unschedulable || model.pressure.length > 0) this.beacons.set(rack.beacon.index, ledOf(theme.warning, 2.2), LedMode.breathe, 0.5);
    else this.beacons.set(rack.beacon.index, ledOf(theme.success, 0.9), LedMode.steady);
  }

  // ---------------------------------------------------------------------------
  // Rack status: beacon, LCD, nameplate, switch ports

  private updateRackStatus(rack: RackInstance, force = false) {
    const { model } = rack;
    const theme = this.theme;

    this.updateRackFilterLook(rack);

    this.ledField.set(rack.mgmtHealth.index, model.ready ? ledOf(theme.success, 1.6) : ledOf(theme.critical, 2.4), model.ready ? LedMode.steady : LedMode.blink, 2);

    // Ports light up as the node fills; their traffic follows the node's CPU.
    const running = model.blades.filter((b) => b.health === "running").length;
    const lit = Math.min(24, Math.ceil((running / Math.max(1, rack.slots.length)) * 24 * 1.6));
    const cpuLoad = (model.cpuUsageMilli ?? model.cpuRequestedMilli) / Math.max(1, model.cpuAllocatableMilli);

    rack.portLeds.forEach((index, i) => {
      if (i < lit && model.ready) this.ledField.set(index, ledOf(theme.success, 1.5), LedMode.flicker, 9 + i * 0.7, i * 1.37, Math.min(1, 0.25 + cpuLoad));
      else if (i >= 22 && model.ready) this.ledField.set(index, ledOf(theme.primary, 1.6), LedMode.flicker, 14, i, 0.8);
      else this.ledField.set(index, new Color(0.03, 0.03, 0.03), LedMode.steady);
    });

    this.drawLcd(rack, force);
    this.drawNameplate(rack, force);
  }

  private drawNameplate(rack: RackInstance, force: boolean) {
    const { model, virtual } = rack;
    const theme = this.theme;
    const role = virtual ? "AWAITING SCHEDULING" : model.isControlPlane ? "CONTROL PLANE" : model.roles.length ? model.roles.join(" · ").toUpperCase() : "WORKER";
    const key = [model.name, role, model.ready, model.unschedulable, theme.key, force ? Math.random() : 0].join("|");

    const title = virtual ? "Unscheduled" : model.shortName;
    const subtitle = virtual ? role : [role, model.domain].filter(Boolean).join("  ·  ");

    rack.nameplate.draw(key, (ctx, w, h) => {
      ctx.fillStyle = "#0c0e11";
      roundRect(ctx, 0, 0, w, h, 14);
      ctx.fill();
      // Lens accent rule along the top, the way Lens marks its active items.
      ctx.fillStyle = virtual ? theme.css.warning : !model.ready ? theme.css.critical : theme.css.primary;
      ctx.fillRect(0, 0, w, 10);

      ctx.fillStyle = "#f2f4f7";
      ctx.font = `600 64px ${UI_FONT}`;
      ctx.textBaseline = "middle";
      ctx.font = `600 ${title.length > 18 ? 52 : 62}px ${UI_FONT}`;
      ctx.fillText(fitText(ctx, title, w - 60), 30, h * 0.47);
      ctx.fillStyle = "#8d96a1";
      ctx.font = `600 24px ${UI_FONT}`;
      ctx.fillText(fitText(ctx, subtitle, w - 60), 30, h * 0.83);
    });
  }

  private drawLcd(rack: RackInstance, force: boolean) {
    const { model, virtual } = rack;
    const theme = this.theme;
    const cpuUse = model.cpuUsageMilli;
    const memUse = model.memUsageBytes;
    const pods = model.blades.filter((b) => b.health !== "succeeded").length;
    const key = [
      model.name, model.ready, model.unschedulable, model.pressure.join(), pods, model.podCapacity,
      Math.round(model.cpuRequestedMilli), Math.round(model.memRequestedBytes / 2 ** 20),
      cpuUse === undefined ? "" : Math.round(cpuUse / 10), memUse === undefined ? "" : Math.round(memUse / 2 ** 24),
      theme.key, force ? Math.random() : 0,
    ].join("|");

    rack.lcd.draw(key, (ctx, w, h) => {
      const bg = ctx.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, "#0a1418");
      bg.addColorStop(1, "#050a0c");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      const fg = "#bfe9ff";
      const dim = "#5d7d8c";
      ctx.textBaseline = "alphabetic";

      if (virtual) {
        ctx.fillStyle = theme.css.warning;
        ctx.font = `700 34px ${MONO_FONT}`;
        ctx.fillText(`${model.blades.length} POD${model.blades.length === 1 ? "" : "S"} PENDING`, 22, 70);
        ctx.fillStyle = dim;
        ctx.font = `500 24px ${MONO_FONT}`;
        ctx.fillText("waiting for a node", 22, 120);

        return;
      }

      const state = !model.ready ? "NOT READY" : model.unschedulable ? "CORDONED" : model.pressure.length ? model.pressure[0]!.toUpperCase() : "READY";
      const stateColor = !model.ready ? theme.css.critical : model.unschedulable || model.pressure.length ? theme.css.warning : theme.css.success;

      ctx.font = `700 26px ${MONO_FONT}`;
      ctx.fillStyle = stateColor;
      ctx.fillText(`● ${state}`, 22, 40);
      ctx.fillStyle = fg;
      ctx.textAlign = "right";
      ctx.fillText(`${pods}/${model.podCapacity} PODS`, w - 22, 40);
      ctx.textAlign = "left";

      const bar = (label: string, y: number, used: number | undefined, requested: number, total: number, format: (n: number) => string) => {
        const x = 110;
        const width = w - x - 160;
        ctx.fillStyle = dim;
        ctx.font = `600 22px ${MONO_FONT}`;
        ctx.fillText(label, 22, y + 18);
        ctx.fillStyle = "#13242b";
        ctx.fillRect(x, y, width, 22);

        // Requests as a hatched band, usage as the solid bar on top.
        const reqFraction = Math.min(1, requested / Math.max(1, total));
        ctx.fillStyle = "rgba(120,170,200,0.35)";
        ctx.fillRect(x, y, width * reqFraction, 22);

        if (used !== undefined) {
          const fraction = Math.min(1, used / Math.max(1, total));
          ctx.fillStyle = fraction > 0.85 ? theme.css.critical : fraction > 0.65 ? theme.css.warning : theme.css.primary;
          ctx.fillRect(x, y + 4, width * fraction, 14);
        }

        ctx.fillStyle = fg;
        ctx.textAlign = "right";
        ctx.fillText(`${format(used ?? requested)}/${format(total)}`, w - 22, y + 18);
        ctx.textAlign = "left";
      };

      const cores = (m: number) => (m >= 10000 ? `${(m / 1000).toFixed(0)}` : `${(m / 1000).toFixed(1)}`);
      const gib = (b: number) => `${(b / 2 ** 30).toFixed(b >= 100 * 2 ** 30 ? 0 : 1)}G`;
      bar("CPU", 64, cpuUse, model.cpuRequestedMilli, model.cpuAllocatableMilli, cores);
      bar("MEM", 100, memUse, model.memRequestedBytes, model.memAllocatableBytes, gib);

      ctx.fillStyle = dim;
      ctx.font = `500 20px ${MONO_FONT}`;
      ctx.fillText(fitText(ctx, [model.kubeletVersion, model.internalIp, model.arch, model.zone].filter(Boolean).join("  "), w - 44), 22, 166);
    });
  }

  // ---------------------------------------------------------------------------
  // Room: floor, cold aisles, lights, cable trays — rebuilt when the layout changes.

  private buildRoom() {
    const key = this.rows.map((row) => `${row.z}:${row.x0}:${row.x1}`).join(";");

    if (key === this.roomKey) return;
    this.roomKey = key;

    for (const object of this.roomObjects) {
      this.room.remove(object);
      object.geometry.dispose();
    }

    for (const light of this.aisleLights) this.room.remove(light);
    this.roomObjects = [];
    this.aisleLights = [];

    // The hall around the cluster: its racks' block, with the network core at its head.
    this.hall.build({
      rowMinX: this.rows[0]?.x0 ?? 0,
      rowMaxX: this.rows[0]?.x1 ?? 0,
      minX: Math.min(...this.rows.map((r) => r.x0), (this.core?.x ?? 0) - RACK_W / 2),
      maxX: Math.max(...this.rows.map((r) => r.x1)),
      rowZs: this.rows.map((r) => r.z),
      aisle: COLD_AISLE,
    });

    const lastRow = this.rows[this.rows.length - 1];
    if (lastRow) this.clusterFarPoint = new Vector3((lastRow.x0 + lastRow.x1) / 2, 1.2, lastRow.z - RACK_D / 2);
    const minX = Math.min(...this.rows.map((r) => r.x0), this.core?.x ?? 0, -2) - 3;
    const maxX = Math.max(...this.rows.map((r) => r.x1), 2) + 3;
    const minZ = Math.min(...this.rows.map((r) => r.z)) - RACK_D - 3;
    const maxZ = Math.max(...this.rows.map((r) => r.z)) + RACK_D + COLD_AISLE + 3;
    // The floor is a large square following the camera in whole tiles (see the frame loop),
    // its pattern fixed to the rack grid.
    const floorSize = this.hall.floorCentre(this.camera.position).size;
    this.floor.scale.set(floorSize, floorSize, 1);
    this.textures.floor.repeat.set(floorSize / RACK_W, floorSize / RACK_W);
    this.textures.floorRoughness.repeat.copy(this.textures.floor.repeat);
    this.textures.floor.offset.set(0, 0);
    this.textures.floorRoughness.offset.set(0, 0);

    const trayMaterial = this.trayMaterial ??= this.track(new MeshStandardMaterial({ color: 0x8d949c, roughness: 0.35, metalness: 0.9 }));

    // A light over the aisle in front of each row; the floor itself is one surface throughout.
    const aisles = this.rows.filter((row) => row.rotation === 0).map((row) => ({ x0: row.x0, x1: row.x1, z: row.z + RACK_D / 2 + COLD_AISLE / 2 }));

    for (const [aisleIndex, aisle] of aisles.entries()) {
      const length = aisle.x1 - aisle.x0;

      // The visible fixtures are the hall's ceiling panels; this light is what they cast.

      // Area lights cost every lit pixel; the front two aisles carry the look, further
      // fixtures glow on their own.
      if (aisleIndex >= 2) continue;

      const light = new RectAreaLight(0xf3f6ff, 5, length * 0.9, 0.3);
      light.position.set((aisle.x0 + aisle.x1) / 2, 3.08, aisle.z);
      light.lookAt((aisle.x0 + aisle.x1) / 2, 0, aisle.z);
      this.room.add(light);
      this.aisleLights.push(light);
    }

    // A ladder cable tray above every row, which the racks' cable drops rise into.
    const trayParts: BufferGeometry[] = [];

    const coreX = this.core?.x ?? this.rows[0]?.x0 ?? 0;

    for (const row of this.rows) {
      // Every tray runs on to the spine above the network core.
      const x0 = Math.min(row.x0, coreX);
      const length = row.x1 - x0 + 0.6;
      const zTray = row.z + (row.rotation === 0 ? -0.25 : 0.25);
      const cx2 = (x0 + row.x1) / 2;

      for (const side of [-0.15, 0.15]) {
        trayParts.push(new BoxGeometry(length, 0.06, 0.006).translate(cx2, TRAY_Y + 0.03, zTray + side).toNonIndexed());
      }

      for (let x = x0 - 0.3; x <= row.x1 + 0.3; x += 0.25) {
        trayParts.push(new BoxGeometry(0.02, 0.008, 0.3).translate(x, TRAY_Y + 0.004, zTray).toNonIndexed());
      }

      // Threaded rods to the ceiling.
      for (let x = x0; x <= row.x1 + 0.01; x += 1.8) {
        for (const side of [-0.17, 0.17]) {
          trayParts.push(new BoxGeometry(0.008, 1.2, 0.008).translate(x, TRAY_Y + 0.6, zTray + side).toNonIndexed());
        }
      }
    }

    // The spine: a tray along the head of the rows, from the first row's tray to the last.
    if (this.rows.length > 1) {
      const z0 = this.rows[0]!.z - 0.25;
      const z1 = this.rows[this.rows.length - 1]!.z - 0.25;
      const length = Math.abs(z1 - z0) + 0.3;
      const cz2 = (z0 + z1) / 2;

      for (const side of [-0.15, 0.15]) trayParts.push(new BoxGeometry(0.006, 0.06, length).translate(coreX + side, TRAY_Y + 0.03, cz2).toNonIndexed());
      for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z += 0.25) trayParts.push(new BoxGeometry(0.3, 0.008, 0.02).translate(coreX, TRAY_Y + 0.004, z).toNonIndexed());
    }

    if (trayParts.length) {
      const tray = new Mesh(mergeGeometries(trayParts)!, trayMaterial);
      tray.castShadow = true;
      this.room.add(tray);
      this.roomObjects.push(tray);
      trayParts.forEach((part) => part.dispose());
    }

    // Shadows cover the cluster and its surroundings, centred on the cluster rather than
    // the hall: a map centred elsewhere ends at the cluster's feet, in a hard edge.
    const shadowCamera = this.keyLight.shadow.camera;
    const clusterX = (minX + maxX) / 2;
    const clusterZ = (minZ + maxZ) / 2;
    const span = Math.max(maxX - minX, maxZ - minZ) / 2 + 3;
    this.keyLight.position.set(clusterX + span * 0.35, 9, clusterZ + span * 0.6 + 4);
    this.keyLight.target.position.set(clusterX, 0, clusterZ);
    shadowCamera.left = -span;
    shadowCamera.right = span;
    shadowCamera.top = span;
    shadowCamera.bottom = -span;
    shadowCamera.near = 1;
    shadowCamera.far = 30 + span * 2;
    shadowCamera.updateProjectionMatrix();

    const fog = this.scene.fog as FogExp2 | null;
    // Haze deep enough that the far rows of the hall fade into the theme's background.
    if (fog) fog.density = 0.065;
  }

  private trayMaterial?: MeshStandardMaterial;

  // ---------------------------------------------------------------------------
  // Placement of everything that moves

  private updateRackMatrix(rack: RackInstance) {
    let y = 0;
    let scaleY = 1;

    if (rack.appear < 1) y = (1 - easeOutBack(rack.appear)) * 2.5;
    if (rack.leaving >= 0) {
      y = -easeInOutCubic(rack.leaving) * (RACK_H + 0.3);
      scaleY = 1;
    }

    tmpQuat.setFromAxisAngle(UP, rack.current.rotation);
    const nudge = RACK_NUDGE * easeInOutCubic(rack.nudge);
    rack.matrix.compose(tmpVec.set(rack.current.x + Math.sin(rack.current.rotation) * nudge, y, rack.current.z + Math.cos(rack.current.rotation) * nudge), tmpQuat, new Vector3(1, scaleY, 1));
    rack.group.matrix.copy(rack.matrix);
    rack.group.matrixWorldNeedsUpdate = true;

    for (const part of rack.parts) {
      const offset = part.shelf === undefined ? 0 : this.shelfOffset(rack, part.shelf);
      part.pool.setMatrix(part.index, tmpMatrix.multiplyMatrices(rack.matrix, tmpMatrix2.makeTranslation(0, 0, offset)).multiply(part.local));
    }

    for (const led of rack.leds) {
      led.field.pool.setMatrix(led.index, tmpMatrix.multiplyMatrices(rack.matrix, led.local));
    }

    for (let slot = 0; slot < rack.slots.length; slot++) this.placeBlank(rack, slot);
    for (const blade of rack.blades.values()) this.placeBlade(blade);
  }

  private placeBlank(rack: RackInstance, slot: number) {
    const pool = this.pools["bladeBlank"]!;
    const index = rack.blanks[slot]!;

    // Occupied, or an open bay the node could still fill: no plate.
    if (rack.slots[slot] || rack.layout.usable[slot]) {
      pool.setMatrix(index, ZERO);

      return;
    }

    const { x, y, z, width } = this.slotTransform(rack, slot);
    pool.setMatrix(index, tmpMatrix.multiplyMatrices(rack.matrix, tmpMatrix2.makeTranslation(x, y, z)).multiply(tmpScale.makeScale(width, 1, 1)));
  }

  private shelfOffset(rack: RackInstance, shelf: number) {
    return SHELF_PULL * easeInOutCubic(rack.shelfPull[shelf] ?? 0);
  }

  // A shelf's drawer moved: its enclosure, label, plates and blades move with it, and the
  // fibres into its blades follow.
  private placeShelf(rack: RackInstance, shelf: number) {
    const offset = tmpMatrix2.makeTranslation(0, 0, this.shelfOffset(rack, shelf));

    for (const part of rack.parts) {
      if (part.shelf !== shelf) continue;
      part.pool.setMatrix(part.index, tmpMatrix.multiplyMatrices(rack.matrix, offset).multiply(part.local));
    }

    rack.shelfLabelMeshes[shelf]!.position.z = this.shelfOffset(rack, shelf);
    const spe = rack.slotsPerEnclosure;

    for (let slot = shelf * spe; slot < (shelf + 1) * spe; slot++) {
      this.placeBlank(rack, slot);
      const uid = rack.slots[slot];
      const blade = uid && rack.blades.get(uid);

      if (blade) {
        this.placeBlade(blade);
        this.network.refreshBlade(blade.uid);
      }
    }
  }

  private slotTransform(rack: RackInstance, slot: number) {
    const spe = rack.slotsPerEnclosure;
    const enclosure = Math.floor(slot / spe);
    const index = slot % spe;
    const pitch = BAY_W / spe;

    return {
      x: -BAY_W / 2 + pitch * (index + 0.5),
      y: uY(ENCLOSURE_BOTTOM_U(enclosure)) + ENC_BOTTOM_BEZEL + 0.003,
      z: FRONT_Z + this.shelfOffset(rack, enclosure),
      width: pitch - 0.0016,
    };
  }

  private bladeMatrix(blade: BladeInstance, target = new Matrix4(), pull = blade.pull) {
    const slot = this.slotTransform(blade.rack, blade.slot);
    let slide = blade.pullMode === "slide" ? PULL_DISTANCE * easeInOutCubic(pull) : 0;
    slot.y += blade.pullMode === "lift" ? BLADE_LIFT * easeInOutCubic(pull) : 0;
    let scale = 1;

    // Re-packed: glide from the old bay to the new one, drawn out a little on the way.
    if (blade.move < 1) {
      const from = this.slotTransform(blade.rack, blade.fromSlot);
      const k = easeInOutCubic(blade.move);
      slot.x = from.x + (slot.x - from.x) * k;
      slot.y = from.y + (slot.y - from.y) * k;
      slide += Math.sin(Math.PI * blade.move) * 0.12;
    }

    if (blade.state === "entering") slide += (1 - easeOutCubic(blade.t)) * 0.5;
    else if (blade.state === "leaving") {
      slide += easeInOutCubic(Math.min(1, blade.t * 1.4)) * 0.45;
      scale = 1 - easeInOutCubic(Math.max(0, (blade.t - 0.6) / 0.4));
    }

    return target.multiplyMatrices(blade.rack.matrix, tmpMatrix2.makeTranslation(slot.x, slot.y, slot.z + slide)).multiply(tmpScale.makeScale(scale, scale, scale));
  }

  private placeBlade(blade: BladeInstance) {
    // Scratch matrices only: this runs for every blade of a rack on every frame it moves.
    const base = this.bladeMatrix(blade, tmpBase);
    const { width } = this.slotTransform(blade.rack, blade.slot);
    tmpPart.copy(base).multiply(tmpMatrix.makeScale(width, 1, 1));

    this.bladePools.body.setMatrix(blade.body, tmpPart);
    this.bladePools.tag.setMatrix(blade.tag, tmpPart);
    this.bladePools.handle.setMatrix(blade.handle, tmpPart);

    const ledX = -width * 0.2;
    this.bladeLeds.pool.setMatrix(blade.status, tmpPart.copy(base).multiply(tmpMatrix.makeTranslation(ledX, BLADE_H - 0.05, 0.0055)));
    this.bladeLeds.pool.setMatrix(blade.activity, tmpPart.copy(base).multiply(tmpMatrix.makeTranslation(ledX, BLADE_H - 0.064, 0.0055)));

    const load = Math.min(1, this.bladeLoad(blade.model, blade.rack.model));
    const barHeight = 0.004 + 0.1 * (blade.model.health === "running" ? load : 0);
    this.loadBars.pool.setMatrix(
      blade.load,
      tmpPart.copy(base).multiply(tmpMatrix.makeTranslation(width * 0.27, BLADE_H * 0.14, 0.0045)).multiply(tmpScale.makeScale(width * 0.14, barHeight, 0.002)),
    );
  }

  // ---------------------------------------------------------------------------
  // Frame loop

  private readonly frame = () => {
    if (this.disposed) return;

    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    if (!this.visible || this.container.clientWidth === 0) return;

    const time = (now - this.clockStart) / 1000;

    this.animate(dt);
    this.updateFlight(dt);
    this.controls.update(dt);
    this.keepInsideHall();

    if (this.pointerDirty) {
      this.pointerDirty = false;
      this.pick();
    }

    this.updateHighlights(time);
    this.updateBladeCard();

    for (const pool of Object.values(this.pools)) pool.commit();
    for (const pool of Object.values(this.bladePools)) pool.commit();
    this.ledField.tick(time);
    this.network.tick(time);
    this.hall.tick(time, this.camera.position);

    if (this.thermal.enabled) {
      this.thermal.apply(this.scene); // meshes created since (a re-laid hall, new fibres) join in
      this.thermal.tick(time);
    }
    const floorAt = this.hall.floorCentre(this.camera.position);
    this.floor.position.set(floorAt.x, 0, floorAt.z);

    // In focus up to the far side of the cluster (or of what the camera looks at, if that is
    // further), so the cluster is always sharp and the hall behind it falls away.
    if (this.bokehPass) {
      const far = this.clusterFarPoint ? this.camera.position.distanceTo(this.clusterFarPoint) : 0;
      (this.bokehPass.uniforms as { focus: { value: number } }).focus.value = Math.max(far, this.camera.position.distanceTo(this.controls.target)) + 1.5;
    }
    this.bladeLeds.tick(time);
    this.beacons.tick(time);
    this.loadBars.tick(time);

    this.composer.render(dt);
    this.measure(now, dt);
  };

  private animate(dt: number) {
    if (this.needsResync && this.model) {
      this.needsResync = false;
      for (const rack of this.racks.values()) rack.overflow = false;
      this.update(this.model);
    }

    for (const rack of [...this.racks.values()]) {
      let moved = rack.dirty;
      rack.dirty = false;

      if (rack.appear < 1) {
        rack.appear = Math.min(1, rack.appear + dt / 1.1);
        moved = true;
      }

      if (rack.leaving >= 0) {
        rack.leaving = Math.min(1, rack.leaving + dt / 1.3);
        moved = true;

        if (rack.leaving >= 1) {
          this.destroyRack(rack);
          continue;
        }
      }

      for (const key of ["x", "z", "rotation"] as const) {
        const delta = rack.target[key] - rack.current[key];

        if (Math.abs(delta) > 1e-4) {
          rack.current[key] += delta * Math.min(1, dt * 4);
          moved = true;
        } else rack.current[key] = rack.target[key];
      }

      // A rack slides forward out of its row while anything in it is selected: the rack, a
      // part of it, a shelf, a pod on it.
      const nudgeTarget = this.selectedRackKey() === rack.key ? 1 : 0;

      if (rack.nudge !== nudgeTarget) {
        rack.nudge = nudgeTarget > rack.nudge ? Math.min(1, rack.nudge + dt / 0.55) : Math.max(0, rack.nudge - dt / 0.45);
        moved = true;
      }

      if (moved) {
        this.updateRackMatrix(rack);
        if (rack.nudge > 0 || nudgeTarget !== rack.nudge) for (const blade of rack.blades.values()) this.network.refreshBlade(blade.uid);
      }

      for (let shelf = 0; shelf < ENCLOSURES; shelf++) {
        const target = this.openShelf?.rack === rack.key && this.openShelf.shelf === shelf ? 1 : 0;
        const current = rack.shelfPull[shelf]!;

        if (current !== target) {
          rack.shelfPull[shelf] = target > current ? Math.min(1, current + dt / 0.7) : Math.max(0, current - dt / 0.6);
          if (!moved) this.placeShelf(rack, shelf);
        }
      }

      for (const blade of [...rack.blades.values()]) {
        const pullTarget = this.selected?.type === "blade" && this.selected.uid === blade.uid ? 1 : 0;
        let animating = false;

        if (blade.pull !== pullTarget) {
          blade.pull = pullTarget > blade.pull ? Math.min(1, blade.pull + dt / 0.6) : Math.max(0, blade.pull - dt / 0.5);
          animating = true;
          this.network.refreshBlade(blade.uid);
        }

        if (blade.move < 1) {
          blade.move = Math.min(1, blade.move + dt / 0.8);
          animating = true;
        }

        if (animating && !moved && blade.state === "present") this.placeBlade(blade);

        if (blade.state === "entering") {
          blade.t = Math.min(1, blade.t + dt / 0.9);
          if (blade.t >= 1) blade.state = "present";
          if (!moved) this.placeBlade(blade);
        } else if (blade.state === "leaving") {
          blade.t = Math.min(1, blade.t + dt / 0.9);

          if (blade.t >= 1) {
            this.destroyBlade(blade);
            continue;
          }

          if (!moved) this.placeBlade(blade);
        }

        if (blade.flash > 0) {
          blade.flash = Math.max(0, blade.flash - dt * 1.6);
          const color = this.ledColors[blade.model.health].clone().lerp(new Color(3, 3, 3), blade.flash * 0.7);
          this.bladeLeds.set(blade.status, color, blade.flash > 0 ? LedMode.steady : LedMode.steady);
          if (blade.flash === 0) this.updateBladeLook(blade);
        }
      }
    }
  }

  private updateFlight(dt: number) {
    const flight = this.flight;
    if (!flight) return;

    flight.t = Math.min(1, flight.t + dt / flight.duration);
    const k = easeInOutCubic(flight.t);
    this.camera.position.lerpVectors(flight.fromPosition, flight.toPosition, k);
    this.controls.target.lerpVectors(flight.fromTarget, flight.toTarget, k);

    if (flight.t >= 1) this.flight = undefined;
  }

  private measure(now: number, dt: number) {
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 60) this.frameTimes.shift();

    const average = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;

    // Auto quality: step down after three seconds under ~35 fps.
    if (this.options.quality === "auto" && this.frameTimes.length >= 60) {
      if (average > 1 / 28 && now - this.qualityChangedAt > 6000) {
        this.slowSince ??= now;

        if (now - this.slowSince > 5000) {
          const next = qualityOrder[qualityOrder.indexOf(this.quality) + 1];

          if (next) {
            this.applyQuality(next);
            this.frameTimes = [];
          }

          this.slowSince = undefined;
        }
      } else this.slowSince = undefined;
    }

    if (now - this.lastStatsAt > 1000) {
      this.lastStatsAt = now;
      this.callbacks.onFrameStats(Math.round(1 / Math.max(average, 1e-3)), this.quality);
    }

    if (now - this.lastPoseAt > 750) {
      this.lastPoseAt = now;
      this.callbacks.onCameraPose({ position: this.camera.position.toArray(), target: this.controls.target.toArray() });
    }
  }

  // ---------------------------------------------------------------------------
  // Picking and highlighting

  private readonly onPointerMove = (event: PointerEvent) => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.pointerScreen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    this.pointerInside = true;
    this.pointerDirty = true;
  };

  private pointerScreen = { x: 0, y: 0 };

  private readonly onPointerLeave = () => {
    this.pointerInside = false;
    this.setHover(undefined);
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    this.pointerDown = { x: event.clientX, y: event.clientY, time: performance.now() };
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    const down = this.pointerDown;
    this.pointerDown = undefined;

    if (!down || event.button !== 0) return;
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return;

    this.pick();

    // Clicking what is already selected lets go of it: a drawn-out pod slides back in, a
    // lifted one drops back into its drawer, which stays open; an open drawer closes.
    if (sameTarget(this.hovered, this.selected)) {
      const shelf = this.selected?.type === "blade" && this.openShelf;
      this.select(shelf ? { type: "shelf", rack: shelf.rack, shelf: shelf.shelf } : undefined);

      return;
    }

    this.select(this.hovered);

    // A pod is drawn out of its rack and a shelf brought close; racks and services just select.
    if (this.hovered && this.hovered.type !== "rack" && this.hovered.type !== "service") this.focus(this.hovered);
  };

  private readonly onDoubleClick = () => {
    this.pick();

    if (this.hovered) this.focus(this.hovered);
    else this.frameAll(true);
  };

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      if (this.selected) this.select(undefined);
      else this.frameAll(true);
    } else if (event.key === "f" && this.selected) this.focus(this.selected);
    else if (event.key === "h" || event.key === "Home") this.frameAll(true);
  };

  private pick() {
    if (!this.pointerInside) return;

    this.raycaster.setFromCamera(this.pointer, this.camera);
    const bladeBody = this.bladePools.body;
    bladeBody.prepareForRaycast();
    const pickables = ["frame", "sidePanels", "enclosure", "enclosureTop", "enclosureSlides", "enclosureCavity", "enclosureLabel", "switchFace", "mgmtFace", "upsFace", "rearDoor", "bladeBlank", "blankPanel", "cableManager"].map((name) => this.pools[name]!);
    pickables.forEach((pool) => pool.prepareForRaycast());

    const ports = this.network.pickables();
    const gateway = this.network.gatewayPickables();
    const shelfLabels = [...this.racks.values()].flatMap((r) => r.shelfLabelMeshes);
    const hits = this.raycaster.intersectObjects([...ports, ...gateway, ...this.network.coreObjects(), bladeBody.mesh, ...pickables.map((pool) => pool.mesh), ...shelfLabels, ...[...this.racks.values()].map((r) => r.nameplateMesh), ...[...this.racks.values()].map((r) => r.lcdMesh)], false);
    const hit = hits[0];
    let target: PickTarget | undefined;

    if (hit) {
      if (gateway.includes(hit.object as never)) {
        target = { type: "internet" };
      } else if (ports.includes(hit.object as never) && hit.instanceId !== undefined) {
        const key = this.network.serviceAt(hit.instanceId);

        if (key) target = { type: "service", key };
      } else if (this.network.coreObjects().includes(hit.object as never)) {
        target = undefined;
      } else if (hit.object === bladeBody.mesh && hit.instanceId !== undefined) {
        const blade = bladeBody.ownerOf(hit.instanceId);

        if (blade && blade.state !== "leaving") target = { type: "blade", uid: blade.uid };
      } else if (hit.instanceId !== undefined) {
        const pool = pickables.find((p) => p.mesh === hit.object);
        const rack = pool?.ownerOf(hit.instanceId);
        // An enclosure, its back wall, its label or a blanking plate in it: that shelf. The
        // switch, the node's controller and the UPS: that part. The rest: the rack.
        const shelf = rack && SHELF_POOLS.has(pool!.name) ? this.shelfAt(rack, hit.point) : undefined;
        const part = pool && PART_POOLS[pool.name];

        if (rack && !rack.virtual) {
          target = shelf !== undefined ? { type: "shelf", rack: rack.key, shelf }
            : part ? { type: "part", rack: rack.key, part }
            : { type: "rack", name: rack.key };
        }
      } else if (shelfLabels.includes(hit.object as never)) {
        const rack = [...this.racks.values()].find((r) => r.shelfLabelMeshes.includes(hit.object as Mesh));
        const shelf = rack && this.shelfAt(rack, hit.point);

        if (rack && !rack.virtual && shelf !== undefined) target = { type: "shelf", rack: rack.key, shelf };
      } else {
        const rack = [...this.racks.values()].find((r) => r.nameplateMesh === hit.object || r.lcdMesh === hit.object);

        // The LCD belongs to the node's controller; the nameplate names the whole rack.
        if (rack && !rack.virtual) target = rack.lcdMesh === hit.object ? { type: "part", rack: rack.key, part: "controller" } : { type: "rack", name: rack.key };
      }
    }

    this.setHover(target);
  }

  // Which shelf of a rack a point on its front is at.
  private shelfAt(rack: RackInstance, point: Vector3) {
    const local = point.clone().applyMatrix4(tmpMatrix.copy(rack.matrix).invert());

    for (let shelf = 0; shelf < ENCLOSURES; shelf++) {
      const bottom = uY(ENCLOSURE_BOTTOM_U(shelf));
      if (local.y >= bottom && local.y < bottom + ENC_H) return shelf;
    }

    return undefined;
  }

  // What is on a shelf: for the HUD's inspector and hover card.
  shelfInfo(rackKey: string, shelf: number) {
    const rack = this.racks.get(rackKey);
    if (!rack) return undefined;

    const spe = rack.slotsPerEnclosure;
    const slots = rack.slots.slice(shelf * spe, (shelf + 1) * spe);
    const blades = slots.flatMap((uid) => (uid && rack.blades.get(uid) ? [rack.blades.get(uid)!.model] : []));

    return {
      rack: rack.model,
      shelf,
      open: rack.layout.usable.slice(shelf * spe, (shelf + 1) * spe).filter(Boolean).length,
      blades,
      namespaces: shelfNamespaces(rack.layout, rack.slots, shelf, (uid) => rack.blades.get(uid)?.model.namespace),
    };
  }

  // The network layer emphasises the fibres of whatever is in focus; a shelf is its pods.
  private networkFocus(target: PickTarget | undefined) {
    if (target?.type === "part") return { type: "rack" as const, name: target.rack };
    if (target?.type !== "shelf") return target;

    return { type: "pods" as const, uids: new Set(this.shelfInfo(target.rack, target.shelf)?.blades.map((b) => b.uid) ?? []) };
  }

  private setHover(target: PickTarget | undefined) {
    if (this.disposed) return;

    const same = sameTarget(target, this.hovered) || (!target && !this.hovered);

    this.hovered = target;
    this.network.setFocus(this.networkFocus(target ?? this.selected));
    this.renderer.domElement.style.cursor = target ? "pointer" : "";
    this.callbacks.onHover(target, this.pointerScreen.x, this.pointerScreen.y);

    if (!same) this.pointerDirty = false;
  }

  private openShelf?: { rack: string; shelf: number };

  private bladeOnShelf(uid: string, shelf: { rack: string; shelf: number }) {
    const blade = this.blades.get(uid);

    return Boolean(blade && blade.rack.key === shelf.rack && Math.floor(blade.slot / blade.rack.slotsPerEnclosure) === shelf.shelf);
  }

  // The rack the selection is in, if any.
  private selectedRackKey() {
    const target = this.selected;
    if (!target) return undefined;
    if (target.type === "rack") return target.name;
    if (target.type === "part" || target.type === "shelf") return target.rack;
    if (target.type === "blade") return this.blades.get(target.uid)?.rack.key;

    return undefined;
  }

  // How much further forward a rack will stand once its slide-out settles: for framing a
  // fly-to that starts while it is still moving.
  private pendingNudge(rack: RackInstance) {
    const target = this.selectedRackKey() === rack.key ? 1 : 0;

    return RACK_NUDGE * (easeInOutCubic(target) - easeInOutCubic(rack.nudge));
  }

  selectedTarget() {
    return this.selected;
  }

  select(target: PickTarget | undefined) {
    // Tearing down must not clear what the user had selected: it is restored on remount.
    if (this.disposed) return;

    // A shelf opens when selected, and stays open while one of its blades is selected.
    if (target?.type === "shelf") this.openShelf = target;
    else if (!(target?.type === "blade" && this.openShelf && this.bladeOnShelf(target.uid, this.openShelf))) this.openShelf = undefined;

    if (target?.type === "blade") {
      const blade = this.blades.get(target.uid);
      // How it comes out is fixed when it is chosen, so it goes back the way it came.
      if (blade && blade.pull === 0) blade.pullMode = this.openShelf ? "lift" : "slide";
    }

    this.selected = target;
    this.network.setFocus(this.networkFocus(this.hovered ?? target));
    if (this.thermal.enabled) this.bakeHeat();
    this.callbacks.onSelect(target);
  }

  private boundsOf(target: PickTarget, out: Matrix4) {
    if (target.type === "service") return this.network.portMatrix(target.key, out);
    if (target.type === "internet") return this.network.gatewayMatrix(out);

    if (target.type === "part") {
      const rack = this.racks.get(target.rack);
      if (!rack) return false;
      const { u, units } = PART_UNITS[target.part];
      out.copy(rack.matrix).multiply(tmpMatrix.compose(tmpVec.set(0, uY(u) - 0.002, FRONT_Z - 0.02), new Quaternion(), new Vector3(EQUIPMENT_W + 0.012, units * U + 0.004, 0.06)));

      return true;
    }

    if (target.type === "shelf") {
      const rack = this.racks.get(target.rack);
      if (!rack) return false;
      // The whole drawer when it is out, its front when it is in.
      const out_ = this.shelfOffset(rack, target.shelf);
      const depth = 0.06 + Math.min(ENC_DEPTH_SEEN, out_);
      out.copy(rack.matrix).multiply(tmpMatrix.compose(tmpVec.set(0, uY(ENCLOSURE_BOTTOM_U(target.shelf)) - 0.002, FRONT_Z + out_ - depth / 2 + 0.03), new Quaternion(), new Vector3(EQUIPMENT_W + 0.012, ENC_H + 0.004, depth)));

      return true;
    }

    if (target.type === "blade") {
      const blade = this.blades.get(target.uid);
      if (!blade) return false;
      const { width } = this.slotTransform(blade.rack, blade.slot);
      this.bladeMatrix(blade, out).multiply(tmpMatrix.compose(tmpVec.set(0, -0.002, -0.006), new Quaternion(), new Vector3(width + 0.003, BLADE_H + 0.004, 0.026)));

      return true;
    }

    const rack = this.racks.get(target.name);
    if (!rack) return false;
    // The rack body itself, floor to roof, a hair larger so the outline sits on its edges.
    out.copy(rack.matrix).multiply(tmpMatrix.compose(tmpVec.set(0, 0.002, 0), new Quaternion(), new Vector3(RACK_W + 0.012, RACK_H + 0.006, RACK_D + 0.012)));

    return true;
  }

  private updateBladeCard() {
    const blade = this.selected?.type === "blade" ? this.blades.get(this.selected.uid) : undefined;
    const mesh = this.bladeCardMesh;

    if (!blade || blade.pull < 0.02 || blade.state === "leaving") {
      mesh.visible = false;

      return;
    }

    const { width } = this.slotTransform(blade.rack, blade.slot);
    mesh.visible = true;
    mesh.matrix
      .copy(this.bladeMatrix(blade, tmpMatrix))
      .multiply(tmpMatrix2.makeTranslation(width / 2 + 0.0015, BLADE_H / 2, -(CARD_FRONT_GAP + CARD_WIDTH / 2)))
      .multiply(tmpScale.makeRotationY(Math.PI / 2))
      .multiply(tmpPart.makeScale(CARD_WIDTH, CARD_HEIGHT, 1));
    mesh.matrixWorldNeedsUpdate = true;
    (mesh.material as MeshBasicMaterial).opacity = Math.min(1, blade.pull * 1.6);
    this.drawBladeCard(blade);
  }

  private drawBladeCard(blade: BladeInstance) {
    const model = blade.model;
    const theme = this.theme;
    const traffic = model.hostNetwork ? undefined : this.networkModel?.traffic?.pods.get(`${model.namespace}/${model.name}`);
    const statusColour = { running: theme.css.success, pending: theme.css.warning, failed: theme.css.critical, succeeded: theme.css.primary, terminating: "#9aa1aa", unknown: "#b388ff" }[model.health];
    const cores = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} cores` : `${Math.round(m)}m`);
    const mib = (b: number) => (b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)} GiB` : `${Math.round(b / 2 ** 20)} MiB`);
    const rate = (b: number) => (b * 8 >= 1e6 ? `${((b * 8) / 1e6).toFixed(1)} Mb/s` : `${Math.round((b * 8) / 1e3)} kb/s`);
    const lines: Array<[string, string]> = [
      ["Node", blade.rack.virtual ? "Not scheduled" : blade.rack.model.shortName],
      ["Pod IP", model.podIp ?? "—"],
      ["CPU", `${model.cpuUsageMilli !== undefined ? `${cores(model.cpuUsageMilli)} used · ` : ""}${model.cpuRequestMilli ? `${cores(model.cpuRequestMilli)} req` : "no request"}`],
      ["Memory", `${model.memUsageBytes !== undefined ? `${mib(model.memUsageBytes)} used · ` : ""}${model.memRequestBytes ? `${mib(model.memRequestBytes)} req` : "no request"}`],
      ["Network", model.hostNetwork ? "host network" : traffic ? `↓ ${rate(traffic.rxBytesPerSec)} · ↑ ${rate(traffic.txBytesPerSec)}` : "—"],
      ["Owner", model.ownerKind ? `${model.ownerKind} ${model.ownerName}` : "—"],
    ];
    const key = [model.uid, model.name, model.health, model.reason, model.ready, model.restarts, theme.key, JSON.stringify(lines)].join("|");

    this.bladeCard.draw(key, (ctx, w, h) => {
      // A Lens panel: dark surface, rounded, the accent rule along the top.
      ctx.fillStyle = "rgba(20, 23, 27, 0.94)";
      roundRect(ctx, 0, 0, w, h, 28);
      ctx.fill();
      ctx.fillStyle = theme.css.primary;
      ctx.fillRect(28, 0, w - 56, 8);

      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = "#8b929b";
      ctx.font = `700 26px ${UI_FONT}`;
      ctx.fillText("POD", 40, 62);

      ctx.fillStyle = "#f2f4f7";
      ctx.font = `600 50px ${UI_FONT}`;
      ctx.fillText(fitText(ctx, model.name, w - 80), 40, 122);

      // Namespace and status.
      ctx.fillStyle = namespaceCss(model.namespace);
      ctx.fillRect(40, 150, 22, 22);
      ctx.fillStyle = "#d5d9df";
      ctx.font = `500 32px ${UI_FONT}`;
      const namespace = fitText(ctx, model.namespace, w / 2 - 60);
      ctx.fillText(namespace, 74, 172);

      const status = model.reason && model.health !== "running" ? model.reason : healthLabel[model.health];
      ctx.font = `700 28px ${UI_FONT}`;
      const chipWidth = ctx.measureText(status).width + 36;
      const chipX = w - 40 - chipWidth;
      ctx.fillStyle = statusColour;
      roundRect(ctx, chipX, 140, chipWidth, 44, 22);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.fillText(status, chipX + 18, 172);

      ctx.fillStyle = "#3a3f46";
      ctx.fillRect(40, 204, w - 80, 2);

      ctx.font = `500 30px ${UI_FONT}`;
      lines.forEach(([label, value], i) => {
        const y = 256 + i * 54;
        ctx.fillStyle = "#8b929b";
        ctx.fillText(label, 40, y);
        ctx.fillStyle = "#e6e9ee";
        ctx.fillText(fitText(ctx, value, w - 260), 220, y);
      });

      ctx.fillStyle = "#8b929b";
      ctx.font = `500 24px ${UI_FONT}`;
      ctx.fillText(`${model.ready}/${model.containers} containers ready · ${model.restarts} restarts`, 40, h - 30);
    });
  }

  private updateHighlights(time: number) {
    const pulse = 0.75 + 0.25 * Math.sin(time * 4);

    for (const [group, target] of [[this.highlight.hover, this.hovered], [this.highlight.selected, this.selected]] as const) {
      // Only what the pointer is over gets an outline; a selection shows itself by being
      // drawn out, opened or lit, not boxed.
      // No outline over a heat image: it would read as a hot edge.
      const visible = group === this.highlight.hover && !this.thermal.enabled && Boolean(target && this.boundsOf(target, group.matrix));
      group.visible = visible;
      group.matrixWorldNeedsUpdate = true;
      ((group.children[0] as Mesh).material as MeshBasicMaterial).opacity = group === this.highlight.selected ? 0.1 * pulse : 0.08;
    }
  }

  // ---------------------------------------------------------------------------
  // Camera

  private fly(position: Vector3, target: Vector3, duration = 1.1) {
    this.flight = {
      fromPosition: this.camera.position.clone(),
      toPosition: position,
      fromTarget: this.controls.target.clone(),
      toTarget: target,
      t: 0,
      duration,
    };
  }

  // The camera stays in the room: under the ceiling, inside the walls, above the floor.
  // The hall has no walls; the camera stays between its floor and its ceiling, and out of
  // the equipment: close enough to read any face of it, never inside it.
  private keepInsideHall() {
    const p = this.camera.position;
    p.y = Math.min(Math.max(p.y, 0.25), HALL_CEILING - 0.3);
    this.controls.target.y = Math.min(this.controls.target.y, HALL_CEILING - 0.5);

    const solids: SolidBox[] = [];
    this.hall.solidsNear(p, solids);

    // The cluster's rows, each one box (its unscheduled frame included), and the network core.
    for (const row of this.rows) solids.push({ x0: row.x0, x1: row.x1, z0: row.z - RACK_D / 2, z1: row.z + RACK_D / 2, top: RACK_H + 0.45 });
    if (this.core && this.options.network !== "off") solids.push({ x0: this.core.x - RACK_W / 2, x1: this.core.x + RACK_W / 2, z0: this.core.z - RACK_D / 2, z1: this.core.z + RACK_D / 2, top: RACK_H + 0.1 });

    const margin = 0.12;

    for (const box of solids) {
      const x0 = box.x0 - margin;
      const x1 = box.x1 + margin;
      const z0 = box.z0 - margin;
      const z1 = box.z1 + margin;
      const top = box.top + margin;

      if (p.x <= x0 || p.x >= x1 || p.z <= z0 || p.z >= z1 || p.y >= top) continue;

      // Out by the shortest way: back into an aisle, round the end of the row, or over it.
      const exits = [
        { d: p.x - x0, apply: () => (p.x = x0) },
        { d: x1 - p.x, apply: () => (p.x = x1) },
        { d: p.z - z0, apply: () => (p.z = z0) },
        { d: z1 - p.z, apply: () => (p.z = z1) },
        { d: top - p.y, apply: () => (p.y = top) },
      ];
      exits.sort((a, b) => a.d - b.d)[0]!.apply();
    }
  }

  frameAll(animate: boolean) {
    const racks = [...this.racks.values()].filter((rack) => rack.leaving < 0);

    if (racks.length === 0) return;

    const xs = [...racks.map((r) => r.target.x), ...(this.core && this.options.network !== "off" ? [this.core.x] : [])];
    const zs = racks.map((r) => r.target.z);
    const minX = Math.min(...xs) - RACK_W;
    const maxX = Math.max(...xs) + RACK_W;
    const minZ = Math.min(...zs) - RACK_D;
    const maxZ = Math.max(...zs) + RACK_D;
    // From the corridor in front of the cage, a little above eye height, looking at the
    // front row: how a hall is seen when you walk into it. Far enough to take in the
    // cluster's width, never through the hall's front wall.
    const front = maxZ;
    const width = maxX - minX;
    const horizontalFov = 2 * Math.atan(Math.tan((this.camera.fov * Math.PI) / 360) * this.camera.aspect);
    const fit = (width / 2) / Math.tan(horizontalFov / 2) * 1.15;
    // At least two metres back from the cage's glass, so the view is through it, not at it.
    const glass = front - RACK_D / 2 + COLD_AISLE;
    const distance = Math.min(Math.max(glass - front + 2.2, fit), this.hall.corridorEnd() - front - 0.6);
    const center = new Vector3((minX + maxX) / 2, 1.05, front - RACK_D / 2 - (maxZ - minZ) * 0.15);
    const position = new Vector3(center.x + width * 0.18, Math.min(2.6, 1.7 + distance * 0.12), front + distance);

    if (animate) this.fly(position, center);
    else {
      this.camera.position.copy(position);
      this.controls.target.copy(center);
    }
  }

  focus(target: PickTarget) {
    if (target.type === "rack") {
      const rack = this.racks.get(target.name);
      if (!rack) return;
      const facing = new Vector3(Math.sin(rack.target.rotation), 0, Math.cos(rack.target.rotation));
      const right = new Vector3(facing.z, 0, -facing.x);
      // Stand in the aisle in front of the rack (never inside the row before it), a
      // little high, aiming slightly right so the rack clears the inspector.
      // Far enough to fit the rack with its sign, never further than the aisle allows.
      const fit = (RACK_H + 0.35) / 2 / Math.tan((this.camera.fov * Math.PI) / 360) * 1.08;
      const distance = Math.min(fit, COLD_AISLE - 0.2);
      const center = new Vector3(rack.target.x, (RACK_H + 0.3) / 2, rack.target.z).addScaledVector(facing, RACK_D / 2).addScaledVector(right, 0.3);
      const position = center.clone().addScaledVector(facing, distance).add(new Vector3(0, 0.25, 0)).addScaledVector(right, 0.2);
      this.fly(position, center);
    } else if (target.type === "internet") {
      // Up at the gateway: the hatch, its plate, and the uplink rising to it.
      const plate = this.network.gatewayPosition();
      if (!plate) return;
      const center = plate.clone().add(new Vector3(-0.3, -0.35, 0));
      this.fly(center.clone().add(new Vector3(0.6, -0.55, 1.9)), center);
    } else if (target.type === "part") {
      const rack = this.racks.get(target.rack);
      if (!rack) return;
      // Close enough to read: the controller's display, the switch's ports, the UPS's panel.
      const { u, units } = PART_UNITS[target.part];
      const distance = { controller: 0.62, switch: 0.6, ups: 0.75 }[target.part];
      const center = new Vector3(rack.target.x + 0.06, uY(u) + (units * U) / 2, rack.target.z + FRONT_Z + RACK_NUDGE);
      this.fly(center.clone().add(new Vector3(distance * 0.18, distance * 0.12, distance)), center);
    } else if (target.type === "shelf") {
      const rack = this.racks.get(target.rack);
      if (!rack) return;
      // Look down into the open drawer from the aisle, a little to its right.
      const center = new Vector3(rack.target.x + 0.06, uY(ENCLOSURE_BOTTOM_U(target.shelf)) + ENC_H * 0.6, rack.target.z + FRONT_Z + RACK_NUDGE + SHELF_PULL - 0.2);
      this.fly(center.clone().add(new Vector3(0.28, 0.62, 0.78)), center);
    } else if (target.type === "service") {
      // The service's port on the network core, seen from the aisle.
      const port = this.network.portPosition(target.key);
      if (!port) return;
      // Frame the router and the panels below it, the port a little up and left.
      const center = port.clone().add(new Vector3(0.18, -0.28, 0));
      this.fly(center.clone().add(new Vector3(0.3, 0.05, 1.35)), center);
    } else {
      const blade = this.blades.get(target.uid);
      if (!blade) return;
      // Where the blade will be once drawn out; looked at from the front right, so the
      // card on its side faces the camera.
      const m = new Matrix4().makeTranslation(0, 0, this.pendingNudge(blade.rack)).multiply(this.bladeMatrix(blade, new Matrix4(), 1));
      const facing = new Vector3(Math.sin(blade.rack.target.rotation), 0, Math.cos(blade.rack.target.rotation));
      const right = new Vector3(facing.z, 0, -facing.x);
      const center = new Vector3(0, BLADE_H / 2, -(CARD_FRONT_GAP + CARD_WIDTH / 2)).applyMatrix4(m).addScaledVector(right, 0.06);
      const position = center.clone().addScaledVector(facing, 0.5).add(new Vector3(0, 0.1, 0)).addScaledVector(right, 0.42);
      this.fly(position, center);
    }
  }

  // ---------------------------------------------------------------------------

  private emit(kind: SceneEvent["kind"], text: string, target?: PickTarget) {
    this.pendingEvents.push({ id: ++this.eventId, at: Date.now(), kind, text, target });
  }

  private flushEvents() {
    if (this.pendingEvents.length === 0) return;
    const events = this.pendingEvents;
    this.pendingEvents = [];
    this.callbacks.onEvents(events);
  }

  private resize() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.network?.setResolution(width, height);
    this.hall?.setSize(width, height, this.renderer.getPixelRatio());
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    this.composer?.setSize(width, height);
  }

  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.themeWatch.dispose();
    this.resizeObserver.disconnect();
    this.visibilityObserver.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerleave", this.onPointerLeave);
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("dblclick", this.onDoubleClick);
    canvas.removeEventListener("keydown", this.onKeyDown);

    for (const rack of [...this.racks.values()]) this.destroyRack(rack);
    for (const pool of Object.values(this.pools)) pool.dispose();
    for (const pool of Object.values(this.bladePools)) pool.dispose();
    this.ledField.dispose();
    this.bladeLeds.dispose();
    this.beacons.dispose();
    this.loadBars.dispose();
    this.network.dispose();
    this.hall.dispose();
    this.thermal.dispose();
    this.bladeCard.dispose();

    this.scene.traverse((object) => {
      if (object instanceof Mesh || object instanceof LineSegments) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material: Material) => material.dispose());
      }
    });

    this.materials.forEach((material) => material.dispose());
    this.textures.dispose();
    this.geometries.dispose();
    (this.scene.environment as Texture | null)?.dispose();
    this.composer.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    canvas.remove();
  }
}

const hashUid = (uid: string) => {
  let h = 0;

  for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) >>> 0;

  return h;
};

const unscheduledRack = (blades: readonly BladeModel[]): RackModel => ({
  uid: "unscheduled",
  name: "unscheduled",
  shortName: "Unscheduled",
  roles: [],
  isControlPlane: false,
  ready: true,
  unschedulable: false,
  pressure: [],
  kubeletVersion: "",
  osImage: "",
  arch: "",
  cpuAllocatableMilli: 0,
  memAllocatableBytes: 0,
  podCapacity: Math.max(16, Math.ceil(blades.length / 16) * 16),
  cpuRequestedMilli: 0,
  memRequestedBytes: 0,
  blades,
});


