import { BoxGeometry, type BufferGeometry, CylinderGeometry, PlaneGeometry, SphereGeometry } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

// Real dimensions, in metres. A rack's local origin is the centre of its footprint
// on the floor, its front facing +z.

export const U = 0.04445;
export const RACK_UNITS = 42;
export const RACK_W = 0.6;
export const RACK_D = 1.07;
export const PLINTH = 0.08;
export const ROOF = 0.05;
export const RACK_H = PLINTH + RACK_UNITS * U + ROOF;
export const RAIL_HALF = 0.2413; // 19" rails
export const FRONT_Z = RACK_D / 2 - 0.05; // faceplates sit here, behind the frame
export const EQUIPMENT_W = 0.4826;
export const BAY_W = 0.44; // usable width between the rails

// Rack unit k (1 at the bottom) starts at this height.
export const uY = (k: number) => PLINTH + (k - 1) * U;

// The stack, top to bottom.
export const SWITCH_U = 42;
export const CABLE_MGR_U = 41;
export const MGMT_U = 39; // 2U: 39–40
export const ENCLOSURE_U = 5;
export const ENCLOSURES = 7; // U4–U38
export const ENCLOSURE_BOTTOM_U = (index: number) => 38 - (index + 1) * ENCLOSURE_U + 1; // index 0 is the top one
export const UPS_U = 1; // 2U: 1–2

export const ENC_H = ENCLOSURE_U * U;
export const ENC_DEPTH = 0.72;
export const ENC_TOP_BEZEL = 0.012;
export const ENC_BOTTOM_BEZEL = 0.018;
export const BLADE_H = ENC_H - ENC_TOP_BEZEL - ENC_BOTTOM_BEZEL - 0.006;
export const BLADE_DEPTH = 0.55;

const box = (w: number, h: number, d: number, x: number, y: number, z: number) => {
  const geometry = new BoxGeometry(w, h, d);
  geometry.translate(x, y, z);

  return geometry;
};

const rounded = (w: number, h: number, d: number, r: number, x: number, y: number, z: number) => {
  const geometry = new RoundedBoxGeometry(w, h, d, 2, r);
  geometry.translate(x, y, z);

  return geometry;
};

const merge = (parts: BufferGeometry[]) => {
  const merged = mergeGeometries(parts.map((part) => part.index ? part.toNonIndexed() : part), false)!;
  parts.forEach((part) => part.dispose());

  return merged;
};

export interface RackGeometries {
  frame: BufferGeometry; // posts, plinth, roof rim, feet: powder-coated steel
  sidePanels: BufferGeometry;
  roof: BufferGeometry; // perforated
  rearDoor: BufferGeometry; // perforated
  rails: BufferGeometry;
  enclosure: BufferGeometry; // one 5U blade enclosure, origin at its front-centre-bottom
  enclosureTop: BufferGeometry; // its perforated top cover, seen when the drawer is out
  enclosureSlides: BufferGeometry; // slide rails and pull handles, which travel with the drawer
  railChannels: BufferGeometry; // the fixed channels in the rack the slides run in
  enclosureCavity: BufferGeometry; // the dark back wall of the enclosure
  enclosureLabel: BufferGeometry;
  switchBody: BufferGeometry;
  switchFace: BufferGeometry;
  mgmtBody: BufferGeometry;
  mgmtFace: BufferGeometry;
  upsBody: BufferGeometry;
  upsFace: BufferGeometry;
  cableManager: BufferGeometry;
  bladeBody: BufferGeometry;
  bladeBlank: BufferGeometry;
  blankPanel: BufferGeometry;
  bladeTag: BufferGeometry;
  bladeHandle: BufferGeometry;
  led: BufferGeometry;
  loadBar: BufferGeometry;
  beacon: BufferGeometry;
  lcd: BufferGeometry;
  nameplate: BufferGeometry;
  dispose(): void;
}

export const createRackGeometries = (): RackGeometries => {
  const postW = 0.045;
  const hx = RACK_W / 2 - postW / 2;
  const hz = RACK_D / 2 - postW / 2;
  const postH = RACK_H - PLINTH;

  const frame = merge([
    // Corner posts.
    ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => rounded(postW, postH, postW, 0.006, sx * hx, PLINTH + postH / 2, sz * hz))),
    // Plinth, recessed like a real kick plate.
    rounded(RACK_W - 0.02, PLINTH, RACK_D - 0.04, 0.008, 0, PLINTH / 2, 0),
    // Roof rim.
    rounded(RACK_W, 0.02, RACK_D, 0.006, 0, RACK_H - 0.01, 0),
    // Front and rear top cross members.
    box(RACK_W - postW * 2, 0.06, 0.03, 0, RACK_H - 0.05, hz),
    box(RACK_W - postW * 2, 0.06, 0.03, 0, RACK_H - 0.05, -hz),
    // Front bottom cross member.
    box(RACK_W - postW * 2, 0.03, 0.03, 0, PLINTH + 0.015, hz),
    // Rail mounting brackets.
    ...[-1, 1].flatMap((sx) => [0.3, 1.2, 1.9].map((y) => box(0.07, 0.02, RACK_D - 0.1, sx * (RAIL_HALF + 0.03), y, 0))),
    // Levelling feet.
    ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => {
      const foot = new CylinderGeometry(0.018, 0.022, 0.02, 14);
      foot.translate(sx * (hx - 0.01), 0.01, sz * (hz - 0.01));

      return foot;
    })),
  ]);

  const sidePanels = merge([-1, 1].map((sx) => rounded(0.014, postH - 0.04, RACK_D - postW * 2 + 0.01, 0.004, sx * (RACK_W / 2 - 0.007), PLINTH + postH / 2, 0)));

  const roof = box(RACK_W - 0.04, 0.006, RACK_D - 0.04, 0, RACK_H - 0.004, 0);
  const rearDoor = box(RACK_W - postW * 2, postH - 0.06, 0.008, 0, PLINTH + postH / 2, -RACK_D / 2 + 0.01);

  // Front rails and rear rails; the front ones carry the U-marking texture.
  const railH = RACK_UNITS * U;
  const rails = merge([-1, 1].flatMap((sx) => [
    box(0.018, railH, 0.004, sx * (RAIL_HALF - 0.004), PLINTH + railH / 2, FRONT_Z - 0.003),
    box(0.003, railH, 0.04, sx * (RAIL_HALF + 0.006), PLINTH + railH / 2, FRONT_Z - 0.024),
    box(0.018, railH, 0.004, sx * (RAIL_HALF - 0.004), PLINTH + railH / 2, -RACK_D / 2 + 0.12),
  ]));

  // Blade enclosure, open at the front.
  const wall = 0.004;
  const enclosure = merge([
    box(BAY_W, wall, ENC_DEPTH, 0, wall / 2, -ENC_DEPTH / 2),
    box(wall, ENC_H, ENC_DEPTH, -BAY_W / 2 + wall / 2, ENC_H / 2, -ENC_DEPTH / 2),
    box(wall, ENC_H, ENC_DEPTH, BAY_W / 2 - wall / 2, ENC_H / 2, -ENC_DEPTH / 2),
    // Rack ears with their thumbscrews.
    ...[-1, 1].map((sx) => rounded(0.022, ENC_H - 0.002, 0.004, 0.0015, sx * (BAY_W / 2 + 0.011), ENC_H / 2, 0.002)),
    ...[-1, 1].flatMap((sx) => [0.25, 0.75].map((f) => {
      const screw = new CylinderGeometry(0.0045, 0.0045, 0.006, 12);
      screw.rotateX(Math.PI / 2);
      screw.translate(sx * (BAY_W / 2 + 0.011), ENC_H * f, 0.006);

      return screw;
    })),
    // Top bezel.
    box(BAY_W, ENC_TOP_BEZEL, 0.012, 0, ENC_H - ENC_TOP_BEZEL / 2, 0.002),
    // Slot guides along the floor and ceiling of the bay.
    ...Array.from({ length: 17 }, (_, i) => {
      const x = -BAY_W / 2 + (i * BAY_W) / 16;

      return [
        box(0.0015, 0.004, ENC_DEPTH * 0.9, x, ENC_BOTTOM_BEZEL + 0.002, -ENC_DEPTH * 0.45),
        box(0.0015, 0.004, ENC_DEPTH * 0.9, x, ENC_H - ENC_TOP_BEZEL - 0.002, -ENC_DEPTH * 0.45),
      ];
    }).flat(),
  ]);
  const enclosureTop = box(BAY_W - 0.004, 0.003, ENC_DEPTH - 0.02, 0, ENC_H - 0.0015, -ENC_DEPTH / 2 - 0.01);

  // Telescopic slides: an inner member on each side of the drawer, and two pull handles on
  // its bezel. The outer members stay in the rack.
  const enclosureSlides = merge([
    ...[-1, 1].map((sx) => box(0.005, 0.014, ENC_DEPTH * 0.92, sx * (BAY_W / 2 + 0.003), ENC_H * 0.45, -ENC_DEPTH * 0.48)),
    ...[-1, 1].flatMap((sx) => [
      rounded(0.05, 0.007, 0.007, 0.003, sx * (BAY_W / 2 - 0.045), ENC_BOTTOM_BEZEL * 0.5, 0.022),
      box(0.006, 0.006, 0.018, sx * (BAY_W / 2 - 0.045 - 0.022), ENC_BOTTOM_BEZEL * 0.5, 0.012),
      box(0.006, 0.006, 0.018, sx * (BAY_W / 2 - 0.045 + 0.022), ENC_BOTTOM_BEZEL * 0.5, 0.012),
    ]),
  ]);
  const railChannels = merge([-1, 1].map((sx) => box(0.004, 0.022, ENC_DEPTH * 0.95, sx * (BAY_W / 2 + 0.0075), ENC_H * 0.45, -ENC_DEPTH * 0.5)));

  const enclosureCavity = box(BAY_W - 0.01, ENC_H - 0.01, 0.004, 0, ENC_H / 2, -ENC_DEPTH + 0.01);
  const enclosureLabel = box(BAY_W, ENC_BOTTOM_BEZEL, 0.012, 0, ENC_BOTTOM_BEZEL / 2, 0.002);

  const bodyDepth = 0.5;
  const switchBody = box(BAY_W, U - 0.002, bodyDepth, 0, U / 2, -bodyDepth / 2);
  const switchFace = merge([
    box(EQUIPMENT_W, U - 0.002, 0.004, 0, U / 2, 0.002),
  ]);
  const mgmtBody = box(BAY_W, 2 * U - 0.002, 0.6, 0, U, -0.3);
  const mgmtFace = box(EQUIPMENT_W, 2 * U - 0.002, 0.004, 0, U, 0.002);
  const upsBody = box(BAY_W, 2 * U - 0.002, 0.65, 0, U, -0.325);
  const upsFace = box(EQUIPMENT_W, 2 * U - 0.002, 0.006, 0, U, 0.003);

  // Brush-strip cable manager: a slotted panel with a black brush.
  const cableManager = merge([
    box(EQUIPMENT_W, U - 0.002, 0.004, 0, U / 2, 0.002),
    ...Array.from({ length: 5 }, (_, i) => rounded(0.03, U * 0.7, 0.05, 0.004, -0.18 + i * 0.09, U / 2, 0.025)),
  ]);

  // Blade parts; a blade's origin is its front-centre-bottom, the slot width is
  // applied as an x scale per instance.
  const bladeBody = new BoxGeometry(1, BLADE_H, BLADE_DEPTH);
  bladeBody.translate(0, BLADE_H / 2, -BLADE_DEPTH / 2 + 0.004);
  const bladeBlank = new BoxGeometry(1, BLADE_H, 0.004);
  bladeBlank.translate(0, BLADE_H / 2, 0.002);
  const blankPanel = box(EQUIPMENT_W, U - 0.0015, 0.003, 0, U / 2, 0.0015);
  const bladeTag = rounded(0.86, 0.022, 0.004, 0.0015, 0, BLADE_H - 0.024, 0.0055);
  const bladeHandle = merge([
    rounded(0.72, 0.011, 0.012, 0.003, 0, 0.012, 0.012),
    box(0.12, 0.011, 0.012, -0.3, 0.012, 0.006),
    box(0.12, 0.011, 0.012, 0.3, 0.012, 0.006),
  ]);

  const led = rounded(0.0055, 0.0055, 0.003, 0.0012, 0, 0, 0);
  const loadBar = box(1, 1, 1, 0, 0.5, 0);

  const beacon = merge([
    new CylinderGeometry(0.016, 0.016, 0.03, 20).translate(0, 0.015, 0),
    new SphereGeometry(0.016, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0.03, 0),
  ]);

  const lcd = new PlaneGeometry(1, 1);
  const nameplate = new PlaneGeometry(1, 1);

  const all = {
    frame, sidePanels, roof, rearDoor, rails, enclosure, enclosureTop, enclosureSlides, railChannels, enclosureCavity, enclosureLabel,
    switchBody, switchFace, mgmtBody, mgmtFace, upsBody, upsFace, cableManager,
    bladeBody, bladeBlank, blankPanel, bladeTag, bladeHandle, led, loadBar, beacon, lcd, nameplate,
  };

  return {
    ...all,
    dispose: () => Object.values(all).forEach((geometry) => geometry.dispose()),
  };
};
