import { navigateToKubeResourceDetailsInjectionToken } from "@k8slens/details-panel-contracts";
import { getInjectable2 } from "@k8slens/injectable";
import { coreV1, nodeKind, podKind, serviceKind } from "@k8slens/kubernetes-contracts";
import { isNavigationSupersededError } from "@k8slens/navigation-contracts";
import { reaction } from "mobx";
import { clusterTitleInjectable } from "./cluster-title.injectable";
import { clusterFeedInjectable } from "./model/cluster-feed.injectable";
import { type BladeModel, bladeMatches, isFiltering } from "./model/datacenter-model";
import type { ServiceModel } from "./model/network-model";
import { rackViewStateInjectable } from "./rack-view-state.injectable";
import { DatacenterScene } from "./scene/datacenter-scene";
import { type PickTarget, sameTarget } from "./scene/scene-types";

// Everything the rack view does: mounting the scene on a container, wiring the live
// feed and the user's choices into it, and the actions its HUD offers.
// A scene that fails on one update keeps showing the last good state rather than
// taking the tab down; the next update gets another chance.
const safely = (run: () => void) => {
  try {
    run();
  } catch (error) {
    console.error("[lens-racks] rack view update failed", error);
  }
};

export const rackViewActionsInjectable = getInjectable2({
  id: "lens-racks-rack-view-actions",
  consumptions: [navigateToKubeResourceDetailsInjectionToken],

  instantiate: (di) => {
    const navigateToDetails = di.inject(navigateToKubeResourceDetailsInjectionToken)();
    const feedFor = di.inject(clusterFeedInjectable);
    const titleFor = di.inject(clusterTitleInjectable);
    const stateFor = di.inject(rackViewStateInjectable);

    return (clusterId: string) => {
      const feed = feedFor(clusterId);
      const state = stateFor(clusterId);
      let scene: DatacenterScene | undefined;

      const findBlade = (uid: string) => {
        const model = feed.model.get();

        if (!model) return undefined;

        for (const rack of model.racks) {
          const blade = rack.blades.find((b) => b.uid === uid);
          if (blade) return blade;
        }

        return model.unscheduled.find((b) => b.uid === uid);
      };

      const findRack = (name: string) => feed.model.get()?.racks.find((rack) => rack.name === name);
      const findService = (key: string) => feed.network.get()?.services.find((service) => service.key === key);
      const trafficOf = (blade: BladeModel) => (blade.hostNetwork ? undefined : feed.network.get()?.traffic?.pods.get(`${blade.namespace}/${blade.name}`));
      const servicesOf = (uid: string) => feed.network.get()?.services.filter((service) => service.podUids.includes(uid)) ?? [];
      // What a node's pods send and receive, counting only pods with a network of their own.
      const nodeTraffic = (node: string) => {
        let rx = 0;
        let tx = 0;

        for (const blade of findRack(node)?.blades ?? []) {
          const traffic = trafficOf(blade);
          rx += traffic?.rxBytesPerSec ?? 0;
          tx += traffic?.txBytesPerSec ?? 0;
        }

        return { rx, tx };
      };
      const serviceTraffic = (service: ServiceModel) => {
        let rx = 0;
        let tx = 0;

        for (const uid of service.podUids) {
          const blade = findBlade(uid);
          const traffic = blade && trafficOf(blade);
          rx += traffic?.rxBytesPerSec ?? 0;
          tx += traffic?.txBytesPerSec ?? 0;
        }

        return { rx, tx };
      };

      return {
        findBlade,
        findRack,
        findService,
        // A shelf's contents live in the scene; read under the feed's model so the HUD follows changes.
        shelfInfo: (rack: string, shelf: number) => {
          feed.model.get();

          return scene?.shelfInfo(rack, shelf);
        },
        trafficOf,
        servicesOf,
        serviceTraffic,
        nodeTraffic,
        // What crosses the cluster's edge: the traffic of the pods behind Services the outside
        // world reaches, and those Services.
        internet: () => {
          const exposed = feed.network.get()?.services.filter((service) => service.exposure !== "internal") ?? [];
          const pods = new Set(exposed.flatMap((service) => service.podUids));
          let rx = 0;
          let tx = 0;

          for (const uid of pods) {
            const blade = findBlade(uid);
            const traffic = blade && trafficOf(blade);
            rx += traffic?.rxBytesPerSec ?? 0;
            tx += traffic?.txBytesPerSec ?? 0;
          }

          return { rx, tx, exposed };
        },

        mount: (container: HTMLElement) => {
          const stopFeed = feed.start();

          scene = new DatacenterScene(
            container,
            {
              onHover: (target, x, y) => state.setHover(target, x, y, container.clientWidth, container.clientHeight),
              onSelect: (target) => state.setSelected(target),
              onEvents: (events) => state.addEvents(events),
              onFrameStats: (fps, quality) => state.setFrameStats(fps, quality),
              onCameraPose: (pose) => state.setCameraPose(pose),
            },
            state.getCameraPose(),
          );

          const current = scene;

          current.setOptions({
            network: state.network.get(),
            shelves: state.shelves.get(),
            thermal: state.thermal.get(),
            focusNamespace: state.focusNamespace.get(),
            search: state.search.get(),
            quality: state.quality.get(),
          });

          const disposers = [
            reaction(() => titleFor(clusterId).get(), (name) => name && current.setClusterName(name), { fireImmediately: true }),
            // The scene follows the selection however it was made: a click, the HUD, a
            // restore after switching tabs, or another part of the extension.
            reaction(
              () => state.selected.get(),
              (selected) => !sameTarget(selected, current.selectedTarget()) && (selected || current.selectedTarget()) && current.select(selected),
              { fireImmediately: true },
            ),
            reaction(() => feed.network.get(), (network) => safely(() => current.updateNetwork(network)), { fireImmediately: true, delay: 400 }),
            // A burst of watch events (a rollout, a node draining) lands as one update.
            reaction(() => feed.model.get(), (model) => model && safely(() => current.update(model)), { fireImmediately: true, delay: 250 }),
            reaction(
              () => ({ network: state.network.get(), shelves: state.shelves.get(), thermal: state.thermal.get(), focusNamespace: state.focusNamespace.get(), search: state.search.get(), quality: state.quality.get() }),
              (options) => current.setOptions(options),
            ),
          ];


          return () => {
            disposers.forEach((dispose) => dispose());
            current.dispose();

            if (scene === current) scene = undefined;
            state.setHover(undefined, 0, 0);
            stopFeed();
          };
        },

        select: (target: PickTarget | undefined) => state.setSelected(target),

        focus: (target: PickTarget) => {
          state.setSelected(target);
          scene?.focus(target);
        },

        overview: () => scene?.frameAll(true),

        matches: () => {
          const model = feed.model.get();
          const filter = { focusNamespace: state.focusNamespace.get(), search: state.search.get() };

          if (!model || !isFiltering(filter)) return undefined;

          return [...model.racks.flatMap((rack) => rack.blades), ...model.unscheduled].filter((blade) => bladeMatches(blade, filter));
        },

        openInLens: async (target: PickTarget) => {
          try {
            if (target.type === "rack" || target.type === "shelf" || target.type === "part") {
              await navigateToDetails({ clusterId, kind: nodeKind, apiVersion: coreV1, ref: { name: target.type === "rack" ? target.name : target.rack } });
            } else if (target.type === "internet") {
              return;
            } else if (target.type === "service") {
              const [namespace, name] = target.key.split("/");
              await navigateToDetails({ clusterId, kind: serviceKind, apiVersion: coreV1, ref: { namespace: namespace!, name: name! } });
            } else {
              const blade = findBlade(target.uid);
              if (!blade) return;
              await navigateToDetails({ clusterId, kind: podKind, apiVersion: coreV1, ref: { namespace: blade.namespace, name: blade.name } });
            }
          } catch (error) {
            if (!isNavigationSupersededError(error)) console.warn("[lens-racks] could not open details", error);
          }
        },
      };
    };
  },
});
