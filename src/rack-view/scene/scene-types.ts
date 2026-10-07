export type PickTarget =
  | { readonly type: "blade"; readonly uid: string }
  | { readonly type: "rack"; readonly name: string }
  | { readonly type: "service"; readonly key: string }
  | { readonly type: "shelf"; readonly rack: string; readonly shelf: number }
  | { readonly type: "part"; readonly rack: string; readonly part: RackPart }
  | { readonly type: "internet" };

// The equipment of a rack that can be picked on its own.
export type RackPart = "switch" | "controller" | "ups";

export const targetKey = (target: PickTarget) =>
  target.type === "blade" ? `blade:${target.uid}`
  : target.type === "rack" ? `rack:${target.name}`
  : target.type === "service" ? `service:${target.key}`
  : target.type === "shelf" ? `shelf:${target.rack}:${target.shelf}`
  : target.type === "part" ? `part:${target.rack}:${target.part}`
  : "internet";

export const sameTarget = (a?: PickTarget, b?: PickTarget) => Boolean(a && b && targetKey(a) === targetKey(b));

export type Quality = "ultra" | "high" | "balanced";
export type QualitySetting = Quality | "auto";

export type SceneEventKind = "added" | "removed" | "failed" | "recovered" | "restarted" | "rack-added" | "rack-removed" | "rack-down" | "rack-up";

export interface SceneEvent {
  readonly id: number;
  readonly at: number;
  readonly kind: SceneEventKind;
  readonly text: string;
  readonly target?: PickTarget;
}

export interface CameraPose {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
}

export type NetworkMode = "all" | "busy" | "off";

export type ShelfMode = "namespace" | "even";

export interface SceneOptions {
  readonly network: NetworkMode;
  readonly shelves: ShelfMode;
  readonly thermal: boolean;
  readonly focusNamespace?: string;
  readonly search: string;
  readonly quality: QualitySetting;
}

export interface SceneCallbacks {
  readonly onHover: (target: PickTarget | undefined, x: number, y: number) => void;
  readonly onSelect: (target: PickTarget | undefined) => void;
  readonly onEvents: (events: SceneEvent[]) => void;
  readonly onFrameStats: (fps: number, quality: Quality) => void;
  readonly onCameraPose: (pose: CameraPose) => void;
}
