import { getInjectable2 } from "@k8slens/injectable";
import { action, computed, observable } from "mobx";
import type { CameraPose, NetworkMode, PickTarget, Quality, QualitySetting, SceneEvent, ShelfMode } from "./scene/scene-types";

const MAX_EVENTS = 40;

// What the user did with one cluster's rack view: kept in DI, so switching tabs away
// and back finds the camera, the selection and the filters where they were.
export const rackViewStateInjectable = getInjectable2({
  id: "lens-racks-rack-view-state",

  instantiate: () => (_clusterId: string) => {
    const hover = observable.box<{ target: PickTarget; x: number; y: number; flipX: boolean; flipY: boolean } | undefined>(undefined, { deep: false });
    const selected = observable.box<PickTarget | undefined>(undefined, { deep: false });
    const thermal = observable.box(false);
    const network = observable.box<NetworkMode>("all");
    const shelves = observable.box<ShelfMode>("namespace");
    const focusNamespace = observable.box<string | undefined>(undefined);
    const search = observable.box("");
    const quality = observable.box<QualitySetting>("auto");
    const activeQuality = observable.box<Quality>("ultra");
    const fps = observable.box(0);
    const events = observable.array<SceneEvent>([], { deep: false });
    const showEvents = observable.box(false);
    const seenEventId = observable.box(0);
    const legendExpanded = observable.box(false);
    let cameraPose: CameraPose | undefined;

    return {
      hover: computed(() => hover.get()),
      selected: computed(() => selected.get()),
      thermal: computed(() => thermal.get()),
      network: computed(() => network.get()),
      shelves: computed(() => shelves.get()),
      focusNamespace: computed(() => focusNamespace.get()),
      search: computed(() => search.get()),
      quality: computed(() => quality.get()),
      activeQuality: computed(() => activeQuality.get()),
      fps: computed(() => fps.get()),
      events: computed(() => events.slice()),
      showEvents: computed(() => showEvents.get()),
      unread: computed(() => (events[0]?.id ?? 0) > seenEventId.get()),
      legendExpanded: computed(() => legendExpanded.get()),

      setHover: action((target: PickTarget | undefined, x: number, y: number, width = Infinity, height = Infinity) =>
        hover.set(target ? { target, x, y, flipX: x > width - 400, flipY: y > height - 160 } : undefined)),
      setSelected: action((target: PickTarget | undefined) => selected.set(target)),
      toggleThermal: action(() => thermal.set(!thermal.get())),
      setShelves: action((mode: ShelfMode) => shelves.set(mode)),
      cycleNetwork: action(() => network.set(({ all: "busy", busy: "off", off: "all" } as const)[network.get()])),
      setFocusNamespace: action((namespace: string | undefined) => focusNamespace.set(namespace)),
      setSearch: action((text: string) => search.set(text)),
      setQuality: action((setting: QualitySetting) => quality.set(setting)),
      setFrameStats: action((frames: number, active: Quality) => {
        fps.set(frames);
        activeQuality.set(active);
      }),
      addEvents: action((added: SceneEvent[]) => {
        events.unshift(...[...added].reverse());
        if (events.length > MAX_EVENTS) events.splice(MAX_EVENTS);
      }),
      clearEvents: action(() => events.clear()),
      toggleEvents: action(() => {
        showEvents.set(!showEvents.get());
        seenEventId.set(events[0]?.id ?? 0);
      }),
      toggleLegend: action(() => legendExpanded.set(!legendExpanded.get())),
      getCameraPose: () => cameraPose,
      setCameraPose: (pose: CameraPose) => {
        cameraPose = pose;
      },
    };
  },
});

export type RackViewState = ReturnType<ReturnType<(typeof rackViewStateInjectable)["instantiate"]>>;
