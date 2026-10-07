import {
  type BufferGeometry,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  type Material,
  Matrix4,
  type Object3D,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
} from "three";

export const ZERO = new Matrix4().makeScale(0, 0, 0);

// An InstancedMesh with slots that can be handed out and returned, and that grows
// by doubling. Everything repeated in the datacenter (racks, enclosures, blades,
// LEDs) is one of these, so the whole room is a few dozen draw calls.
export class InstancePool<Owner = unknown> {
  mesh: InstancedMesh;
  private capacity: number;
  private free: number[] = [];
  private used = 0;
  private dirtyMatrix = false;
  private dirtyColor = false;
  private dirtyAttributes = new Set<string>();
  private readonly owners: Array<Owner | undefined> = [];
  boundsDirty = true;

  constructor(
    readonly name: string,
    private readonly geometry: BufferGeometry,
    private material: Material | Material[],
    private readonly parent: Object3D,
    private readonly options: {
      initialCapacity?: number;
      castShadow?: boolean;
      receiveShadow?: boolean;
      colors?: boolean;
      attributes?: Record<string, number>; // name → itemSize, instanced per slot
      thermal?: string; // its role in the thermal view (see thermal.ts)
    } = {},
  ) {
    this.capacity = options.initialCapacity ?? 64;
    this.mesh = this.createMesh(this.capacity);
    this.parent.add(this.mesh);
  }

  private createMesh(capacity: number) {
    const mesh = new InstancedMesh(this.geometry, this.material, capacity);
    mesh.name = this.name;
    mesh.userData["pool"] = this;
    if (this.options.thermal) mesh.userData["thermal"] = this.options.thermal;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.castShadow = this.options.castShadow ?? false;
    mesh.receiveShadow = this.options.receiveShadow ?? false;
    // Bounds change as instances come and go; culling against a stale sphere would
    // drop visible racks, and the room is always on screen anyway.
    mesh.frustumCulled = false;
    mesh.count = this.used;

    if (this.options.colors) {
      mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
      mesh.instanceColor.setUsage(DynamicDrawUsage);
    }

    for (const [attributeName, itemSize] of Object.entries(this.options.attributes ?? {})) {
      const previous = this.geometry.getAttribute(attributeName) as InstancedBufferAttribute | undefined;
      const attribute = new InstancedBufferAttribute(new Float32Array(capacity * itemSize), itemSize);
      attribute.setUsage(DynamicDrawUsage);

      if (previous) (attribute.array as Float32Array).set(previous.array as Float32Array);
      this.geometry.setAttribute(attributeName, attribute);
    }

    for (let i = 0; i < capacity; i++) {
      mesh.setMatrixAt(i, ZERO);
    }

    return mesh;
  }

  private grow() {
    const old = this.mesh;
    const capacity = this.capacity * 2;
    const mesh = this.createMesh(capacity);

    (mesh.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);

    if (old.instanceColor && mesh.instanceColor) {
      (mesh.instanceColor.array as Float32Array).set(old.instanceColor.array as Float32Array);
    }

    this.parent.remove(old);
    old.dispose();
    this.parent.add(mesh);
    this.mesh = mesh;
    this.capacity = capacity;
  }

  alloc(owner?: Owner): number {
    let index = this.free.pop();

    if (index === undefined) {
      if (this.used >= this.capacity) this.grow();
      index = this.used++;
      this.mesh.count = this.used;
    }

    this.owners[index] = owner;

    return index;
  }

  release(index: number) {
    this.mesh.setMatrixAt(index, ZERO);
    this.owners[index] = undefined;
    this.free.push(index);
    this.dirtyMatrix = true;
    this.boundsDirty = true;
  }

  setOwner(index: number, owner: Owner) {
    this.owners[index] = owner;
  }

  setMaterial(material: Material | Material[]) {
    this.material = material;
    this.mesh.material = material;
  }

  ownerOf(index: number) {
    return this.owners[index];
  }

  setMatrix(index: number, matrix: Matrix4) {
    this.mesh.setMatrixAt(index, matrix);
    this.dirtyMatrix = true;
    this.boundsDirty = true;
  }

  setColor(index: number, color: Color) {
    this.mesh.setColorAt(index, color);
    this.dirtyColor = true;
  }

  setAttribute(name: string, index: number, ...values: number[]) {
    const attribute = this.geometry.getAttribute(name) as InstancedBufferAttribute;
    const array = attribute.array as Float32Array;
    array.set(values, index * attribute.itemSize);
    this.dirtyAttributes.add(name);
  }

  // Uploads whatever changed this frame.
  commit() {
    if (this.dirtyMatrix) this.mesh.instanceMatrix.needsUpdate = true;
    if (this.dirtyColor && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    for (const name of this.dirtyAttributes) {
      this.geometry.getAttribute(name).needsUpdate = true;
    }

    this.dirtyMatrix = this.dirtyColor = false;
    this.dirtyAttributes.clear();
  }

  prepareForRaycast() {
    if (this.boundsDirty) {
      this.mesh.computeBoundingSphere();
      this.mesh.computeBoundingBox();
      this.boundsDirty = false;
    }
  }

  dispose() {
    this.parent.remove(this.mesh);
    this.mesh.dispose();
  }
}

// ---------------------------------------------------------------------------
// LEDs. Their blinking is computed on the GPU from a mode, a rate and a phase per
// instance, so thousands of them cost nothing on the CPU per frame.

export const LedMode = {
  steady: 0,
  blink: 1, // square wave: pending, alarms
  flicker: 2, // pseudo-random activity, density = level
  breathe: 3, // slow sine: terminating, standby
  strobe: 4, // short flash, long dark: beacons
} as const;

export type LedModeValue = (typeof LedMode)[keyof typeof LedMode];

const ledVertex = /* glsl */ `
  attribute vec3 ledColor;
  attribute vec4 ledParams;
  varying vec3 vColor;
  varying vec4 vParams;
  varying vec3 vNormal;
  varying vec3 vView;
  #include <fog_pars_vertex>

  void main() {
    vColor = ledColor;
    vParams = ledParams;
    vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vNormal = normalize(mat3(modelMatrix * instanceMatrix) * normal);
    vView = normalize(cameraPosition - world.xyz);
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const ledFragment = /* glsl */ `
  uniform float time;
  uniform float dimFloor;
  varying vec3 vColor;
  varying vec4 vParams;
  varying vec3 vNormal;
  varying vec3 vView;

  #include <fog_pars_fragment>

  float hash(float n) { return fract(sin(n) * 43758.5453123); }

  void main() {
    float mode = vParams.x;
    float rate = vParams.y;
    float phase = vParams.z;
    float level = vParams.w;
    float t = time * rate + phase;
    float on = 1.0;

    if (mode > 0.5 && mode < 1.5) {
      on = step(0.5, fract(t));
    } else if (mode > 1.5 && mode < 2.5) {
      float a = hash(floor(t) + phase * 17.0);
      on = step(1.0 - level, a) * (0.6 + 0.4 * hash(floor(t * 3.0)));
      on = max(on, 0.18);
    } else if (mode > 2.5 && mode < 3.5) {
      on = 0.25 + 0.75 * (0.5 + 0.5 * sin(t * 6.2831853));
    } else if (mode > 3.5) {
      float f = fract(t);
      on = smoothstep(0.0, 0.04, f) * (1.0 - smoothstep(0.08, 0.3, f)) + 0.12;
    }

    // A lens: brighter head-on, a little rim when seen from the side.
    float facing = clamp(dot(normalize(vNormal), normalize(vView)), 0.0, 1.0);
    float lens = 0.55 + 0.45 * facing;
    vec3 body = vColor * dimFloor;
    gl_FragColor = vec4(mix(body, vColor * lens, on), 1.0);
    #include <fog_fragment>
  }
`;

export const createLedMaterial = () =>
  new ShaderMaterial({
    // Fogged like everything else, so far LEDs do not bloom through the haze.
    fog: true,
    uniforms: UniformsUtils.merge([UniformsLib.fog, { time: { value: 0 }, dimFloor: { value: 0.05 } }]),
    vertexShader: ledVertex,
    fragmentShader: ledFragment,
  });

export class LedField<Owner = unknown> {
  readonly pool: InstancePool<Owner>;
  readonly material: ShaderMaterial;

  private readonly geometry: BufferGeometry;

  constructor(name: string, geometry: BufferGeometry, parent: Object3D, initialCapacity = 256) {
    this.material = createLedMaterial();
    // Its own copy: the per-instance attributes live on the geometry, so two fields
    // sharing one would overwrite each other's buffers as they grow.
    this.geometry = geometry.clone();
    this.pool = new InstancePool<Owner>(name, this.geometry, this.material, parent, {
      initialCapacity,
      attributes: { ledColor: 3, ledParams: 4 },
      // Light, not heat: a thermal camera does not see it.
      thermal: "hide",
    });
  }

  set(index: number, color: Color, mode: LedModeValue, rate = 1, phase = 0, level = 1) {
    this.pool.setAttribute("ledColor", index, color.r, color.g, color.b);
    this.pool.setAttribute("ledParams", index, mode, rate, phase, level);
  }

  tick(time: number) {
    this.material.uniforms["time"]!.value = time;
    this.pool.commit();
  }

  dispose() {
    this.pool.dispose();
    this.material.dispose();
    this.geometry.dispose();
  }
}
