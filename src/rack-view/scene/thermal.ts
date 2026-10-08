import {
  Color,
  DataTexture,
  LinearFilter,
  type Material,
  Mesh,
  type Object3D,
  RGBAFormat,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  UnsignedByteType,
} from "three";
import { RACK_D, RACK_H } from "./geometry";
import type { InstancePool } from "./instance-pool";

// The thermal view: the whole room as a thermal camera would see it. Every surface is
// coloured by a temperature, on the inferno ramp such cameras use. Temperatures come from
// a heat field the scene bakes from its data (each shelf as warm as its pods' load, each
// rack's equipment as warm as its node), spread the way heat spreads: cool in front of a
// rack where the cold aisle is, a hot exhaust behind it, warm air rising above and
// gathering under the ceiling. Blades carry their own pod's heat; the hall's other racks
// sit at steady, varied temperatures. Lights, LEDs and reflections are not heat and vanish.

export type ThermalRole =
  | "field" // takes its temperature from the heat field, by where it is
  | "instance" // each instance carries its own temperature, in its instance colour
  | "background" // the hall's other racks: steady temperatures of their own
  | "hide" // light, not heat
  | "keep"; // left as it is (the HUD-like tag on a drawn-out blade, the hover outline)

export interface HeatRack {
  readonly x: number; // centre
  readonly row: number; // index into the field's rows
  readonly node: number; // 0–1: the node's own warmth, for its frame and equipment
  readonly shelves: readonly number[]; // 0–1 per shelf, bottom of the list the top shelf
  readonly shelfYs: ReadonlyArray<readonly [number, number]>; // y range of each shelf
  readonly forward?: number; // metres the rack stands forward of its row
  readonly openShelf?: { readonly index: number; readonly pull: number }; // a drawer out, how far
}

const MAX_ROWS = 16;
const CELL = 0.05; // metres per texel
const FIELD_HEIGHT = 2.6;
const Y_CELLS = Math.round(FIELD_HEIGHT / CELL);

const common = /* glsl */ `
  uniform float time;
  uniform float rangeLo; // the scene's coolest and hottest: the palette spans them, as a
  uniform float rangeHi; // thermal camera's automatic range does
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vView;
  #include <fog_pars_fragment>

  // Inferno: the ramp of thermal imaging, violet black to yellow white.
  vec3 inferno(float t) {
    t = clamp(t, 0.0, 1.0);
    const vec3 c0 = vec3(0.0002, 0.0016, -0.0194);
    const vec3 c1 = vec3(0.1065, 0.5640, 3.9327);
    const vec3 c2 = vec3(11.6024, -3.9728, -15.9423);
    const vec3 c3 = vec3(-41.7039, 17.4363, 44.3541);
    const vec3 c4 = vec3(77.1629, -33.4023, -81.8073);
    const vec3 c5 = vec3(-71.3194, 32.6260, 73.2095);
    const vec3 c6 = vec3(25.1311, -12.2427, -23.0703);
    return c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6)))));
  }

  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

  // Smooth value noise: the slow, organic variation of real surface temperatures.
  float smoothNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  vec3 camera(float heat) {
    // The shape still reads: surfaces facing away a little darker, a faint sensor noise.
    // A mesh without normals would normalize a zero vector: NaN, which the bloom spreads
    // into black blocks. It is seen flat on instead.
    float facing = dot(vNormal, vNormal) > 1e-8 ? abs(dot(normalize(vNormal), normalize(vView))) : 1.0;
    float organic = (smoothNoise(vWorld.xy * 3.0 + vWorld.zz * 2.0) - 0.5) * 0.035;
    float t = (heat + organic - rangeLo) / max(rangeHi - rangeLo, 0.05);
    float noise = (hash(gl_FragCoord.xy + floor(time * 30.0)) - 0.5) * 0.025;
    vec3 colour = inferno(t + noise) * (0.72 + 0.28 * facing);
    // The hottest spots glow past white, so the bloom picks them out.
    return colour * (1.0 + smoothstep(0.88, 1.0, t) * 0.5);
  }

  vec4 finish(vec3 colour) {
    vec4 result = vec4(colour, 1.0);
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      #else
        float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
      #endif
      result.rgb = mix(result.rgb, fogColor, fogFactor);
    #endif
    return result;
  }
`;

const vertex = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vInstanceHeat;
  varying vec3 vLocal;
  #include <fog_pars_vertex>

  void main() {
    vLocal = position;
    mat4 model = modelMatrix;
    #ifdef USE_INSTANCING
      model = modelMatrix * instanceMatrix;
    #endif
    vec4 world = model * vec4(position, 1.0);
    vWorld = world.xyz;
    vNormal = mat3(model) * normal; // normalized per fragment, where a zero one is caught
    vView = cameraPosition - world.xyz;
    vInstanceHeat = 0.0;
    #ifdef USE_INSTANCING_COLOR
      vInstanceHeat = instanceColor.r;
    #endif
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const fieldFragment = /* glsl */ `
  ${common}
  uniform sampler2D field;
  uniform vec2 fieldOrigin; // x of the first column; (unused) y
  uniform float fieldWidth; // metres
  uniform float rowZ[${MAX_ROWS}];
  uniform int rowCount;
  uniform float base; // what a surface adds of its own
  varying float vInstanceHeat;

  // Heat in r; in g how far that part of the rack stands forward (slid out, drawer open), in metres.
  vec2 sampleRow(int row, float x, float y) {
    float u = (x - fieldOrigin.x) / fieldWidth;
    float v = (float(row) + clamp(y / ${FIELD_HEIGHT.toFixed(2)}, 0.0, 0.999)) / float(${MAX_ROWS});
    if (u < 0.0 || u > 1.0) return vec2(0.0);
    return texture2D(field, vec2(u, v)).rg;
  }

  float heatAt(vec3 p) {
    float best = 0.0;

    for (int r = 0; r < ${MAX_ROWS}; r++) {
      if (r >= rowCount) break;
      float dz = p.z - rowZ[r];
      float halfDepth = ${(RACK_D / 2).toFixed(3)};
      float y = min(p.y, ${(RACK_H - 0.05).toFixed(3)});
      vec2 sampled = sampleRow(r, p.x, y);
      float f = sampled.r;
      // Its heat goes with a rack that is slid out, and with a drawer that is open.
      float front = halfDepth + sampled.g;
      // In front, the cold aisle washes heat away; behind, the exhaust carries it out.
      float along = dz > front ? exp(-(dz - front) * 3.2) * 0.55 : dz < -halfDepth ? exp((dz + halfDepth) * 0.9) * 0.95 : 1.0;
      // Above the rack, warm air rises and spreads, fading as it goes.
      float above = p.y > ${RACK_H.toFixed(3)} ? exp(-(p.y - ${RACK_H.toFixed(3)}) * 0.9) * (0.75 + 0.25 * step(dz, 0.0)) : 1.0;
      best = max(best, f * along * above);
    }

    return best;
  }

  void main() {
    float ambient = 0.13 + 0.025 * smoothstep(2.6, 3.9, vWorld.y); // a faint warm layer under the ceiling
    float heat = max(ambient, heatAt(vWorld)) + base;
    gl_FragColor = finish(camera(heat));
  }
`;

const instanceFragment = /* glsl */ `
  ${common}
  varying float vInstanceHeat;
  varying vec3 vLocal;

  void main() {
    // A blade, front at z = 0 and its back half a metre in: air enters cool at the faceplate,
    // the processors a third of the way in run hottest, the back stays warm, heat rises.
    float depth = clamp(-vLocal.z / 0.55, 0.0, 1.0);
    float height = clamp(vLocal.y / 0.19, 0.0, 1.0);
    // Squared by hand: pow() of a negative base is undefined in GLSL, NaN on many GPUs.
    float off = (depth - 0.38) / 0.16;
    float processors = exp(-off * off);
    float profile = 0.42 + 0.33 * smoothstep(0.0, 0.6, depth) + 0.35 * processors + 0.08 * height;
    float load = vInstanceHeat;
    float heat = 0.14 + load * 0.62 * profile + 0.05 * profile;
    gl_FragColor = finish(camera(heat));
  }
`;

const backgroundFragment = /* glsl */ `
  ${common}
  varying float vInstanceHeat;

  void main() {
    // Every rack of the hall at its own steady temperature, warmer towards its top.
    vec2 cell = floor(vWorld.xz / vec2(0.6, 1.2));
    float own = 0.22 + 0.25 * hash(cell);
    float heat = own * (0.7 + 0.45 * smoothstep(0.0, 2.2, vWorld.y));
    gl_FragColor = finish(camera(heat));
  }
`;

interface Swapped {
  readonly original: Material | Material[];
  readonly pool?: InstancePool<unknown>;
}

export class ThermalView {
  private field = new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat, UnsignedByteType);
  private readonly fieldUniforms = {
    field: { value: this.field },
    fieldOrigin: { value: [0, 0] },
    fieldWidth: { value: 1 },
    rowZ: { value: new Array(MAX_ROWS).fill(0) },
    rowCount: { value: 0 },
    time: { value: 0 },
    rangeLo: { value: 0.12 },
    rangeHi: { value: 0.6 },
  };
  private readonly materials: Record<"field" | "instance" | "background", ShaderMaterial>;
  private readonly swapped = new Map<Mesh, Swapped>();
  private readonly swappedPools = new Set<InstancePool<unknown>>();
  private readonly hidden = new Set<Object3D>();
  enabled = false;

  constructor() {
    const make = (fragmentShader: string, extra: Record<string, { value: unknown }> = {}) => {
      const material = new ShaderMaterial({
        uniforms: UniformsUtils.merge([UniformsLib.fog, { time: { value: 0 }, rangeLo: { value: 0.12 }, rangeHi: { value: 0.6 } }, extra]),
        vertexShader: vertex,
        fragmentShader,
        fog: true,
      });

      return material;
    };

    this.materials = {
      field: make(fieldFragment, { base: { value: 0 } }),
      instance: make(instanceFragment),
      background: make(backgroundFragment),
    };

    // The field's uniforms are shared, so one bake reaches every material that reads it; the
    // range reaches all three.
    Object.assign(this.materials.field.uniforms, this.fieldUniforms);
    for (const material of [this.materials.instance, this.materials.background]) {
      material.uniforms["rangeLo"] = this.fieldUniforms.rangeLo;
      material.uniforms["rangeHi"] = this.fieldUniforms.rangeHi;
    }
  }

  // Bakes the heat field: per row of the cluster a strip of texels over its racks, each
  // shelf at its pods' load, frame and equipment at the node's, then blurred so heat spreads.
  bake(rows: readonly number[], minX: number, maxX: number, racks: readonly HeatRack[], hottestBlade = 0) {
    const x0 = minX - 1.5;
    const width = Math.max(1, maxX - minX + 3);
    const columns = Math.min(2048, Math.ceil(width / CELL));
    const height = MAX_ROWS * Y_CELLS;
    let values = new Float32Array(columns * height);
    const forward = new Float32Array(columns * height);

    for (const rack of racks) {
      if (rack.row >= MAX_ROWS) continue;
      const c0 = Math.max(0, Math.floor((rack.x - 0.3 - x0) / CELL));
      const c1 = Math.min(columns - 1, Math.ceil((rack.x + 0.3 - x0) / CELL));

      for (let yc = 0; yc < Y_CELLS; yc++) {
        const y = (yc + 0.5) * CELL;
        let heat = rack.node * 0.55 + 0.15; // frame, top equipment
        if (y < 0.18) heat = 0.32 + rack.node * 0.2; // the UPS at the foot, always warm

        rack.shelfYs.forEach(([lo, hi], shelf) => {
          if (y >= lo && y < hi) heat = Math.max(0.2, (rack.shelves[shelf] ?? 0) * 0.9 + rack.node * 0.15);
        });

        const shelf = rack.openShelf && rack.shelfYs[rack.openShelf.index];
        const ahead = (rack.forward ?? 0) + (shelf && y >= shelf[0] && y < shelf[1] ? rack.openShelf!.pull : 0);

        for (let c = c0; c <= c1; c++) {
          const i = (rack.row * Y_CELLS + yc) * columns + c;
          values[i] = Math.max(values[i]!, heat);
          forward[i] = Math.max(forward[i]!, ahead);
        }
      }
    }

    // Heat spreads: a few box blurs within each row's strip.
    for (let pass = 0; pass < 3; pass++) {
      const next = new Float32Array(values.length);

      for (let row = 0; row < MAX_ROWS; row++) {
        for (let yc = 0; yc < Y_CELLS; yc++) {
          for (let c = 0; c < columns; c++) {
            let sum = 0;
            let n = 0;

            for (let dy = -1; dy <= 1; dy++) {
              const y = yc + dy;
              if (y < 0 || y >= Y_CELLS) continue;

              for (let dx = -2; dx <= 2; dx++) {
                const x = c + dx;
                if (x < 0 || x >= columns) continue;
                sum += values[(row * Y_CELLS + y) * columns + x]!;
                n++;
              }
            }

            next[(row * Y_CELLS + yc) * columns + c] = sum / n;
          }
        }
      }

      values = next;
    }

    // Automatic range: from the room's ambient to the hottest thing in view, with headroom,
    // and never so narrow that sensor noise becomes a colour.
    let hottest = 0;
    for (const value of values) hottest = Math.max(hottest, value);
    const hottestBladeSurface = 0.14 + hottestBlade * 0.62 * 1.1 + 0.05;
    this.fieldUniforms.rangeLo.value = 0.11;
    this.fieldUniforms.rangeHi.value = Math.max(0.42, Math.max(hottest, hottestBladeSurface) * 1.08);

    const bytes = new Uint8Array(columns * height * 4);
    for (let i = 0; i < values.length; i++) {
      bytes[i * 4] = Math.round(Math.min(1, values[i]!) * 255);
      bytes[i * 4 + 1] = Math.round(Math.min(1, forward[i]!) * 255);
    }

    this.field.dispose();
    this.field = new DataTexture(bytes, columns, height, RGBAFormat, UnsignedByteType);
    this.field.minFilter = this.field.magFilter = LinearFilter;
    this.field.needsUpdate = true;
    this.fieldUniforms.field.value = this.field;
    (this.materials.field.uniforms["field"] as { value: DataTexture }).value = this.field;
    this.fieldUniforms.fieldOrigin.value = [x0, 0];
    this.fieldUniforms.fieldWidth.value = columns * CELL;
    this.fieldUniforms.rowCount.value = Math.min(MAX_ROWS, rows.length);
    rows.forEach((z, i) => {
      if (i < MAX_ROWS) this.fieldUniforms.rowZ.value[i] = z;
    });
  }

  // Puts every mesh under `root` into the thermal view by its role (userData.thermal, "field"
  // when unset). Safe to call every frame: what is already swapped is left alone, so meshes
  // created since (a re-laid hall, new fibres) join in.
  apply(root: Object3D) {
    root.traverse((object) => {
      const role = (object.userData["thermal"] as ThermalRole | undefined) ?? "field";

      if (role === "keep") return;

      if (role === "hide") {
        if (object.visible && !this.hidden.has(object)) {
          this.hidden.add(object);
          object.visible = false;
        }

        return;
      }

      if (!(object instanceof Mesh) || this.swapped.has(object)) return;

      const material = this.materials[role === "instance" ? "instance" : role === "background" ? "background" : "field"];
      const pool = object.userData["pool"] as InstancePool<unknown> | undefined;

      // A pool swaps once: a mesh it grows into later already has the thermal material.
      if (pool && this.swappedPools.has(pool)) return;
      if (pool) this.swappedPools.add(pool);

      this.swapped.set(object, { original: object.material, pool });

      if (pool) pool.setMaterial(material);
      else object.material = material;
    });
  }

  restore() {
    for (const [mesh, { original, pool }] of this.swapped) {
      if (pool) pool.setMaterial(original);
      else mesh.material = original;
    }

    for (const object of this.hidden) object.visible = true;
    this.swapped.clear();
    this.swappedPools.clear();
    this.hidden.clear();
  }

  tick(time: number) {
    for (const material of Object.values(this.materials)) (material.uniforms["time"] as { value: number }).value = time;
  }

  // Thermal cameras see the room against a dark violet, not the theme's background.
  static readonly background = new Color(0x07040d);

  dispose() {
    this.restore();
    this.field.dispose();
    Object.values(this.materials).forEach((material) => material.dispose());
  }
}
