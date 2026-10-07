import { CanvasTexture, ClampToEdgeWrapping, LinearMipmapLinearFilter, RepeatWrapping, SRGBColorSpace, type Texture } from "three";

// Every texture in the scene is drawn here on a canvas: no image files, no network.

export const UI_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif";
export const MONO_FONT = "'SF Mono', Menlo, Monaco, Consolas, monospace";

const canvas = (width: number, height: number) => {
  const element = document.createElement("canvas");
  element.width = width;
  element.height = height;
  const ctx = element.getContext("2d")!;

  return { element, ctx };
};

// Deterministic noise so textures look the same on every load.
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;

  return seed / 4294967296;
};

const finish = (element: HTMLCanvasElement, { srgb = true, repeat = false, anisotropy = 8 } = {}) => {
  const texture = new CanvasTexture(element);
  if (srgb) texture.colorSpace = SRGBColorSpace;
  texture.wrapS = texture.wrapT = repeat ? RepeatWrapping : ClampToEdgeWrapping;
  texture.anisotropy = anisotropy;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;

  return texture;
};

const grain = (ctx: CanvasRenderingContext2D, width: number, height: number, amount: number, seed: number) => {
  const random = rng(seed);
  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;

  for (let i = 0; i < data.length; i += 4) {
    const n = (random() - 0.5) * amount;
    data[i] = Math.max(0, Math.min(255, data[i]! + n));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1]! + n));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2]! + n));
  }

  ctx.putImageData(image, 0, 0);
};

// Brushed metal streaks, along x.
const brush = (ctx: CanvasRenderingContext2D, width: number, height: number, seed: number, alpha = 0.06) => {
  const random = rng(seed);

  for (let i = 0; i < height * 1.5; i++) {
    const y = random() * height;
    ctx.strokeStyle = random() > 0.5 ? `rgba(255,255,255,${alpha * random()})` : `rgba(0,0,0,${alpha * random()})`;
    ctx.lineWidth = random() * 1.2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y + (random() - 0.5) * 2);
    ctx.stroke();
  }
};

export interface SceneTextures {
  readonly bladeFace: Texture;
  readonly bladeFaceBump: Texture;
  readonly perforated: Texture; // alpha map
  readonly sidePanel: Texture;
  readonly rail: Texture;
  readonly floor: Texture;
  readonly floorRoughness: Texture;
  readonly switchFace: Texture;
  readonly upsFace: Texture;
  readonly mgmtFace: Texture;
  readonly enclosureLabel: Texture;
  readonly bladeBlank: Texture;
  readonly blankPanel: Texture;
  readonly patchPanel: Texture;
  readonly bladeSide: Texture;
  readonly bladeTop: Texture;
  readonly edgeRouter: Texture;
  dispose(): void;
}

// The front of a blade: brushed steel, a field of hex vent holes, two captive screws
// and a recess for the load meter. Tall and thin, like the sled itself.
const drawBladeFace = (bump: boolean) => {
  const W = 64;
  const H = 512;
  const { element, ctx } = canvas(W, H);

  ctx.fillStyle = bump ? "#808080" : "#6b717a";
  ctx.fillRect(0, 0, W, H);

  if (!bump) {
    brush(ctx, W, H, 7, 0.08);
    const gradient = ctx.createLinearGradient(0, 0, W, 0);
    gradient.addColorStop(0, "rgba(0,0,0,0.35)");
    gradient.addColorStop(0.12, "rgba(255,255,255,0.08)");
    gradient.addColorStop(0.88, "rgba(0,0,0,0.05)");
    gradient.addColorStop(1, "rgba(0,0,0,0.4)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, W, H);
  }

  // Hex vent field between the LEDs and the handle.
  ctx.fillStyle = bump ? "#000" : "#0b0c0e";
  const r = 3.2;
  const top = 150;
  const bottom = 440;

  for (let row = 0, y = top; y < bottom; row++, y += r * 1.85) {
    for (let x = 10 + (row % 2) * r * 1.1; x < W - 26; x += r * 2.2) {
      ctx.beginPath();

      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 3) * k + Math.PI / 6;
        ctx.lineTo(x + Math.cos(a) * r * 0.85, y + Math.sin(a) * r * 0.85);
      }

      ctx.fill();
    }
  }

  // Recess for the load meter, on the right.
  ctx.fillStyle = bump ? "#202020" : "#16181b";
  ctx.fillRect(W - 20, 150, 10, 290);

  // Captive screws.
  for (const y of [22, H - 18]) {
    ctx.fillStyle = bump ? "#fff" : "#a9afb8";
    ctx.beginPath();
    ctx.arc(W / 2, y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = bump ? "#000" : "#2a2d31";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(W / 2 - 5, y);
    ctx.lineTo(W / 2 + 5, y);
    ctx.stroke();
  }

  // Panel edge bevel.
  ctx.strokeStyle = bump ? "#fff" : "rgba(255,255,255,0.18)";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, W - 2, H - 2);

  if (!bump) grain(ctx, W, H, 10, 3);

  return finish(element, { srgb: !bump, anisotropy: 4 });
};

// Round perforation, white where solid, black where open: used as an alpha map.
const drawPerforated = () => {
  const S = 256;
  const { element, ctx } = canvas(S, S);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = "#000";
  const pitch = 16;

  for (let row = 0; row < S / pitch + 1; row++) {
    for (let col = 0; col < S / pitch + 1; col++) {
      const x = col * pitch + (row % 2 ? pitch / 2 : 0);
      const y = row * pitch * 0.866;
      ctx.beginPath();
      ctx.arc(x, y, 5.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return finish(element, { srgb: false, repeat: true });
};

const drawSidePanel = () => {
  const W = 256;
  const H = 512;
  const { element, ctx } = canvas(W, H);
  ctx.fillStyle = "#23262b";
  ctx.fillRect(0, 0, W, H);
  // Powder-coat orange peel.
  grain(ctx, W, H, 14, 11);
  // Stamped stiffening ribs and a recessed handle area.
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 3;
  ctx.strokeRect(14, 14, W - 28, H - 28);
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.strokeRect(17, 17, W - 28, H - 28);
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(W / 2 - 28, H / 2 - 6, 56, 12);

  return finish(element);
};

// Square-hole mounting rail, with the U markings printed beside the holes.
const drawRail = () => {
  const W = 32;
  const H = 1024;
  const { element, ctx } = canvas(W, H);
  ctx.fillStyle = "#9aa1aa";
  ctx.fillRect(0, 0, W, H);
  brush(ctx, W, H, 5, 0.1);
  const perU = H / 42;

  for (let u = 0; u < 42; u++) {
    for (let k = 0; k < 3; k++) {
      const y = u * perU + perU * (0.2 + k * 0.3);
      ctx.fillStyle = "#0d0e10";
      ctx.fillRect(W * 0.5 - 4, y - 3.5, 8, 7);
    }

    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(0, u * perU, W, 0.8);
  }

  return finish(element, { anisotropy: 8 });
};

// Raised-floor tiles: 600 mm squares with dark seams and speckled vinyl.
const drawFloor = (roughness: boolean) => {
  const S = 512;
  const { element, ctx } = canvas(S, S);
  ctx.fillStyle = roughness ? "#5a5a5a" : "#3a3f46";
  ctx.fillRect(0, 0, S, S);

  const random = rng(roughness ? 99 : 42);

  for (let i = 0; i < 2600; i++) {
    const shade = roughness ? 70 + random() * 80 : 50 + random() * 40;
    ctx.fillStyle = `rgba(${shade},${shade},${shade + (roughness ? 0 : 6)},0.35)`;
    ctx.fillRect(random() * S, random() * S, 1 + random() * 2, 1 + random() * 2);
  }

  // Scuffs, which also break up the reflections.
  for (let i = 0; i < 18; i++) {
    ctx.strokeStyle = roughness ? "rgba(200,200,200,0.25)" : "rgba(255,255,255,0.03)";
    ctx.lineWidth = 6 + random() * 20;
    ctx.beginPath();
    const x = random() * S;
    const y = random() * S;
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + random() * 80, y + random() * 40, x + random() * 140, y + random() * 30);
    ctx.stroke();
  }

  // Seams and bevels.
  ctx.fillStyle = roughness ? "#e0e0e0" : "#111316";
  ctx.fillRect(0, 0, S, 4);
  ctx.fillRect(0, 0, 4, S);
  if (!roughness) {
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(4, 4, S - 4, 2);
    ctx.fillRect(4, 4, 2, S - 4);
  }

  return finish(element, { srgb: !roughness, repeat: true, anisotropy: 16 });
};

// 1U top-of-rack switch: 24 ports, two uplinks, a console port.
const drawSwitchFace = () => {
  const W = 1024;
  const H = 48;
  const { element, ctx } = canvas(W, H);
  ctx.fillStyle = "#16181c";
  ctx.fillRect(0, 0, W, H);
  grain(ctx, W, H, 8, 13);

  for (let i = 0; i < 24; i++) {
    const x = 150 + i * 30 + Math.floor(i / 6) * 12;
    const y = i % 2 ? 26 : 6;
    ctx.fillStyle = "#3a3f46";
    ctx.fillRect(x - 1, y - 1, 24, 18);
    ctx.fillStyle = "#050506";
    ctx.fillRect(x + 1, y + 1, 20, 14);
    ctx.fillStyle = "#4b4f55";
    ctx.fillRect(x + 7, y + 13, 8, 3);
  }

  for (let i = 0; i < 2; i++) {
    const x = 930 + i * 40;
    ctx.fillStyle = "#6d737c";
    ctx.fillRect(x, 12, 32, 22);
    ctx.fillStyle = "#050506";
    ctx.fillRect(x + 3, 15, 26, 16);
  }

  ctx.fillStyle = "#c7ccd3";
  ctx.font = `600 13px ${UI_FONT}`;
  ctx.fillText("TOR-SW", 24, 22);
  ctx.fillStyle = "#7d838c";
  ctx.font = `10px ${UI_FONT}`;
  ctx.fillText("25G · 24P", 24, 36);

  return finish(element);
};

const drawUpsFace = () => {
  const W = 512;
  const H = 48;
  const { element, ctx } = canvas(W, H);
  const gradient = ctx.createLinearGradient(0, 0, 0, H);
  gradient.addColorStop(0, "#2a2e34");
  gradient.addColorStop(1, "#1b1e22");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, W, H);

  // Vent slots.
  ctx.fillStyle = "#0b0c0e";

  for (let x = 170; x < 470; x += 9) {
    ctx.fillRect(x, 10, 4, H - 20);
  }

  ctx.fillStyle = "#0a1a14";
  ctx.fillRect(24, 12, 70, 24);
  ctx.fillStyle = "#59f0a6";
  ctx.font = `600 12px ${MONO_FONT}`;
  ctx.fillText("ONLINE", 32, 29);
  ctx.fillStyle = "#9aa1aa";
  ctx.font = `600 11px ${UI_FONT}`;
  ctx.fillText("UPS 3kVA", 104, 28);

  return finish(element);
};

const drawMgmtFace = () => {
  const W = 512;
  const H = 96;
  const { element, ctx } = canvas(W, H);
  const gradient = ctx.createLinearGradient(0, 0, 0, H);
  gradient.addColorStop(0, "#30353c");
  gradient.addColorStop(1, "#1d2025");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, W, H);
  brush(ctx, W, H, 31, 0.05);
  // LCD bezel; the LCD itself is its own mesh with a live texture.
  ctx.fillStyle = "#08090a";
  ctx.fillRect(96, 8, 320, 80);
  // Drive bays to the right.
  for (let i = 0; i < 2; i++) {
    ctx.fillStyle = "#111316";
    ctx.fillRect(428, 10 + i * 40, 72, 34);
    ctx.fillStyle = "#3a3f46";
    ctx.fillRect(432, 14 + i * 40, 64, 4);
  }
  ctx.fillStyle = "#8b929b";
  ctx.font = `600 11px ${UI_FONT}`;
  ctx.fillText("NODE", 22, 40);
  ctx.fillText("CTRL", 22, 56);

  return finish(element);
};

const drawEnclosureLabel = () => {
  const W = 512;
  const H = 32;
  const { element, ctx } = canvas(W, H);
  ctx.fillStyle = "#1a1d21";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#7d838c";
  ctx.font = `600 13px ${UI_FONT}`;
  ctx.fillText("BLADE ENCLOSURE", 14, 21);
  ctx.fillStyle = "#3a3f46";

  for (let i = 0; i < 16; i++) {
    ctx.fillRect(170 + i * 20, 12, 12, 8);
  }

  return finish(element);
};

// A blanking plate for an empty blade slot: plain steel, a finger notch, two screws.
const drawBladeBlank = () => {
  const W = 64;
  const H = 512;
  const { element, ctx } = canvas(W, H);
  ctx.fillStyle = "#2b2f35";
  ctx.fillRect(0, 0, W, H);
  brush(ctx, W, H, 17, 0.06);
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(W / 2 - 9, H / 2 - 22, 18, 44);
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, W - 2, H - 2);

  for (const y of [22, H - 18]) {
    ctx.fillStyle = "#6b717a";
    ctx.beginPath();
    ctx.arc(W / 2, y, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  return finish(element, { anisotropy: 4 });
};

// A 1U blanking panel with a row of vent slots.
const drawBlankPanel = () => {
  const W = 512;
  const H = 48;
  const { element, ctx } = canvas(W, H);
  ctx.fillStyle = "#202328";
  ctx.fillRect(0, 0, W, H);
  brush(ctx, W, H, 23, 0.06);
  ctx.fillStyle = "#0a0b0d";

  for (let x = 40; x < W - 40; x += 12) {
    ctx.fillRect(x, 14, 6, H - 28);
  }

  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fillRect(0, 0, W, 2);
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(0, H - 2, W, 2);

  return finish(element);
};

// The side of a blade sled, front at the right: brushed steel, a stamped rib, a row of
// vent slots by the faceplate, screws, and an asset-tag sticker with a barcode.
const drawBladeSide = () => {
  const W = 512;
  const H = 128;
  const { element, ctx } = canvas(W, H);
  ctx.fillStyle = "#4a5058";
  ctx.fillRect(0, 0, W, H);
  brush(ctx, W, H, 61, 0.09);
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.fillRect(0, H * 0.48, W, 3);
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fillRect(0, H * 0.48 + 3, W, 1);

  for (let x = W - 120; x < W - 16; x += 9) {
    ctx.fillStyle = "#1b1e22";
    ctx.fillRect(x, 16, 4, 30);
    ctx.fillRect(x, H - 46, 4, 30);
  }

  for (const [x, y] of [[20, 14], [20, H - 14], [W / 2, 14], [W / 2, H - 14]]) {
    ctx.fillStyle = "#8b929b";
    ctx.beginPath();
    ctx.arc(x!, y!, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Asset tag.
  ctx.fillStyle = "#e8eaed";
  ctx.fillRect(170, 26, 120, 34);
  ctx.fillStyle = "#1b1e22";

  for (let x = 176; x < 284; x += 3) {
    if ((x * 7) % 5 > 1) ctx.fillRect(x, 31, x % 2 ? 1 : 2, 18);
  }

  ctx.font = `600 8px ${UI_FONT}`;
  ctx.fillText("SLED 2U-E · 48V", 176, 57);
  grain(ctx, W, H, 8, 71);

  return finish(element, { anisotropy: 8 });
};

// The top cover of a blade, front at the bottom: a perforated field over the processors,
// the ridges of the memory, and a power connector at the back.
const drawBladeTop = () => {
  const W = 128;
  const H = 512;
  const { element, ctx } = canvas(W, H);
  ctx.fillStyle = "#3c4249";
  ctx.fillRect(0, 0, W, H);
  brush(ctx, W, H, 83, 0.07);
  ctx.fillStyle = "#14171a";

  for (let y = H * 0.55; y < H * 0.85; y += 10) {
    for (let x = 14 + ((y / 10) % 2) * 5; x < W - 12; x += 10) {
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  for (let y = H * 0.2; y < H * 0.48; y += 14) {
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(10, y, W - 20, 5);
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(10, y + 5, W - 20, 1);
  }

  ctx.fillStyle = "#2a2e33";
  ctx.fillRect(W / 2 - 22, 6, 44, 26);
  ctx.fillStyle = "#c9a646";
  for (let x = W / 2 - 18; x < W / 2 + 18; x += 6) ctx.fillRect(x, 12, 3, 14);

  return finish(element, { anisotropy: 8 });
};

// 1U fibre patch panel: 24 duplex LC ports in four groups, port numbers above.
export const PATCH_PORTS = 24;
export const patchPortX = (i: number) => 0.11 + (i + Math.floor(i / 6) * 0.35) * (0.78 / (PATCH_PORTS - 1 + 3 * 0.35)); // fraction of the panel width

const drawPatchPanel = () => {
  const W = 1024;
  const H = 48;
  const { element, ctx } = canvas(W, H);
  ctx.fillStyle = "#1b1e23";
  ctx.fillRect(0, 0, W, H);
  brush(ctx, W, H, 41, 0.05);

  for (let i = 0; i < PATCH_PORTS; i++) {
    const x = patchPortX(i) * W;
    ctx.fillStyle = "#c9ced6";
    ctx.font = `600 9px ${UI_FONT}`;
    ctx.textAlign = "center";
    ctx.fillText(String(i + 1), x, 11);
    // Duplex LC adapter: a beige housing with two square bores.
    ctx.fillStyle = "#3b4048";
    ctx.fillRect(x - 11, 15, 22, 26);
    ctx.fillStyle = "#0b0c0e";
    ctx.fillRect(x - 8, 19, 7, 18);
    ctx.fillRect(x + 1, 19, 7, 18);
  }

  ctx.textAlign = "left";
  ctx.fillStyle = "#8b929b";
  ctx.font = `700 12px ${UI_FONT}`;
  ctx.fillText("PATCH", 18, 22);
  ctx.font = `600 10px ${UI_FONT}`;
  ctx.fillText("LC · OS2", 18, 36);

  return finish(element);
};

// 2U edge router: uplink cages on the left, service ports on the right.
const drawEdgeRouter = () => {
  const W = 1024;
  const H = 96;
  const { element, ctx } = canvas(W, H);
  const gradient = ctx.createLinearGradient(0, 0, 0, H);
  gradient.addColorStop(0, "#2a2f36");
  gradient.addColorStop(1, "#171a1e");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, W, H);
  brush(ctx, W, H, 53, 0.05);

  ctx.fillStyle = "#e6e9ee";
  ctx.font = `700 16px ${UI_FONT}`;
  ctx.fillText("EDGE", 22, 40);
  ctx.fillStyle = "#8b929b";
  ctx.font = `600 11px ${UI_FONT}`;
  ctx.fillText("INGRESS · LB", 22, 58);

  // Two QSFP uplink cages.
  for (let i = 0; i < 2; i++) {
    ctx.fillStyle = "#7d848d";
    ctx.fillRect(150 + i * 70, 26, 56, 40);
    ctx.fillStyle = "#050506";
    ctx.fillRect(155 + i * 70, 31, 46, 30);
  }

  for (let i = 0; i < PATCH_PORTS; i++) {
    const x = patchPortX(i) * W;
    if (x < 330) continue;
    ctx.fillStyle = "#3b4048";
    ctx.fillRect(x - 11, 34, 22, 26);
    ctx.fillStyle = "#0b0c0e";
    ctx.fillRect(x - 8, 38, 7, 18);
    ctx.fillRect(x + 1, 38, 7, 18);
  }

  return finish(element);
};

export const createSceneTextures = (): SceneTextures => {
  const textures = {
    bladeFace: drawBladeFace(false),
    bladeFaceBump: drawBladeFace(true),
    perforated: drawPerforated(),
    sidePanel: drawSidePanel(),
    rail: drawRail(),
    floor: drawFloor(false),
    floorRoughness: drawFloor(true),
    switchFace: drawSwitchFace(),
    upsFace: drawUpsFace(),
    mgmtFace: drawMgmtFace(),
    enclosureLabel: drawEnclosureLabel(),
    bladeBlank: drawBladeBlank(),
    blankPanel: drawBlankPanel(),
    patchPanel: drawPatchPanel(),
    bladeSide: drawBladeSide(),
    bladeTop: drawBladeTop(),
    edgeRouter: drawEdgeRouter(),
  };

  return {
    ...textures,
    dispose: () => Object.values(textures).forEach((texture) => texture.dispose()),
  };
};

// ---------------------------------------------------------------------------
// Live label textures, redrawn when what they show changes.

export class LabelCanvas {
  readonly element: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly texture: CanvasTexture;
  private lastKey = "";

  // `scale` backs the canvas with more pixels than the layout it is drawn in, the way a
  // Retina screen does, so text stays crisp up close; painters keep drawing in layout units.
  constructor(readonly width: number, readonly height: number, readonly scale = 2) {
    const { element, ctx } = canvas(Math.round(width * scale), Math.round(height * scale));
    this.element = element;
    this.ctx = ctx;
    this.texture = finish(element, { anisotropy: 16 });
  }

  // Draws only when the key changed, so a steady rack costs nothing per update.
  draw(key: string, paint: (ctx: CanvasRenderingContext2D, width: number, height: number) => void) {
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.ctx.textAlign = "left";
    paint(this.ctx, this.width, this.height);
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture.dispose();
  }
}

export const fitText = (ctx: CanvasRenderingContext2D, text: string, maxWidth: number) => {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let low = 0;
  let high = text.length;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);

    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) low = mid;
    else high = mid - 1;
  }

  return `${text.slice(0, low)}…`;
};

export const roundRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
};
