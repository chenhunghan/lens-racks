import { Color } from "three";
import type { PodHealth } from "../model/datacenter-model";

// Linear-space HDR colours for LEDs: values above 1 are what the bloom pass picks up.
export const healthLedColor: Record<PodHealth, Color> = {
  running: new Color(0.1, 1.6, 0.35),
  pending: new Color(2.2, 1.1, 0.05),
  failed: new Color(2.6, 0.08, 0.06),
  succeeded: new Color(0.25, 0.55, 2.2),
  terminating: new Color(0.8, 0.8, 0.85),
  unknown: new Color(0.9, 0.2, 1.8),
};

// CSS versions of the same, for the HUD.
export const healthCss: Record<PodHealth, string> = {
  running: "#3ddc84",
  pending: "#ffb020",
  failed: "#ff4d4f",
  succeeded: "#4d8dff",
  terminating: "#b8bcc6",
  unknown: "#c561ff",
};

export const healthLabel: Record<PodHealth, string> = {
  running: "Running",
  pending: "Pending",
  failed: "Failing",
  succeeded: "Completed",
  terminating: "Terminating",
  unknown: "Unknown",
};

const hash = (text: string) => {
  let h = 2166136261;

  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return h >>> 0;
};

// A stable, well-spread hue per namespace (golden-angle stepping of the hash).
export const namespaceHue = (namespace: string) => ((hash(namespace) % 360) * 137.508) % 360;

export const namespaceColor = (namespace: string) => new Color().setHSL(namespaceHue(namespace) / 360, 0.7, 0.42);

export const namespaceCss = (namespace: string) => `hsl(${namespaceHue(namespace).toFixed(0)}, 72%, 58%)`;

// Thermal ramp for the heat view: cold blue → green → yellow → red → white hot.
const heatStops: Array<[number, Color]> = [
  [0, new Color(0.02, 0.05, 0.35)],
  [0.25, new Color(0.0, 0.45, 0.6)],
  [0.5, new Color(0.15, 0.8, 0.15)],
  [0.7, new Color(1.0, 0.85, 0.0)],
  [0.88, new Color(1.0, 0.25, 0.0)],
  [1, new Color(1.4, 1.2, 1.1)],
];

export const heatColor = (value: number, target = new Color()) => {
  const v = Math.min(1, Math.max(0, value));

  for (let i = 1; i < heatStops.length; i++) {
    const [t1, c1] = heatStops[i]!;
    const [t0, c0] = heatStops[i - 1]!;

    if (v <= t1) return target.copy(c0).lerp(c1, (v - t0) / (t1 - t0));
  }

  return target.copy(heatStops[heatStops.length - 1]![1]);
};

export const loadBarColor = (value: number, target = new Color()) => {
  const v = Math.min(1, Math.max(0, value));

  if (v < 0.6) return target.setRGB(0.15, 1.3, 0.4).lerp(new Color(1.6, 1.3, 0.1), v / 0.6);

  return target.setRGB(1.6, 1.3, 0.1).lerp(new Color(2.2, 0.15, 0.05), (v - 0.6) / 0.4);
};
