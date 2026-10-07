import { connectClusterInjectionToken } from "@k8slens/cluster-contracts";
import { getInjectable2 } from "@k8slens/injectable";
import { runKubectlInjectionToken } from "@k8slens/kubectl-contracts";
import {
  coreV1,
  discoveryV1,
  endpointSliceKind,
  ingressKind,
  type KubeResource,
  kubeResourcesInjectionToken,
  networkingV1,
  nodeKind,
  podKind,
  serviceKind,
} from "@k8slens/kubernetes-contracts";
import { queryPrometheusRangeInjectionToken } from "@k8slens/prometheus-contracts";
import type { Subscription } from "@k8slens/subscribable";
import { action, computed, type IComputedValue, observable, reaction } from "mobx";
import { buildDatacenterModel, type DatacenterModel, parseBytes, parseCpuMilli, type UsageMetrics } from "./datacenter-model";
import { buildNetworkModel, type NetworkModel, type TrafficSnapshot } from "./network-model";
import { startTrafficPolling } from "./traffic-poller";

export type FeedStatus = "idle" | "connecting" | "loading" | "live" | "error";

export interface ClusterFeed {
  readonly status: IComputedValue<FeedStatus>;
  readonly error: IComputedValue<string | undefined>;
  readonly model: IComputedValue<DatacenterModel | undefined>;
  readonly network: IComputedValue<NetworkModel | undefined>;
  // Counts every change the watch delivered, for the "live" pulse in the HUD.
  readonly revision: IComputedValue<number>;
  // Starts the feed for one viewer; the returned function stops it again.
  readonly start: () => () => void;
}

const METRICS_POLL_MS = 10_000;
const METRICS_RETRY_MS = 60_000;

interface MetricsList {
  items: Array<{
    metadata: { name: string; namespace?: string };
    usage?: { cpu?: string; memory?: string };
    containers?: Array<{ usage?: { cpu?: string; memory?: string } }>;
  }>;
}

export const clusterFeedInjectable = getInjectable2({
  id: "lens-racks-cluster-feed",
  consumptions: [connectClusterInjectionToken, kubeResourcesInjectionToken, runKubectlInjectionToken, queryPrometheusRangeInjectionToken],

  instantiate: (di) => {
    const connectCluster = di.inject(connectClusterInjectionToken);
    const kubeResources = di.inject(kubeResourcesInjectionToken)();
    const runKubectlFor = di.inject(runKubectlInjectionToken);
    const queryPrometheus = di.inject(queryPrometheusRangeInjectionToken)();

    return (clusterId: string): ClusterFeed => {
      const status = observable.box<FeedStatus>("idle");
      const error = observable.box<string | undefined>(undefined);
      const revision = observable.box(0);
      const nodes = observable.box<IComputedValue<readonly KubeResource<typeof nodeKind, typeof coreV1>[]> | undefined>(undefined, { deep: false });
      const pods = observable.box<IComputedValue<readonly KubeResource<typeof podKind, typeof coreV1>[]> | undefined>(undefined, { deep: false });
      const usage = observable.box<UsageMetrics | undefined>(undefined, { deep: false });
      const services = observable.box<IComputedValue<readonly KubeResource<typeof serviceKind, typeof coreV1>[]> | undefined>(undefined, { deep: false });
      const slices = observable.box<IComputedValue<readonly KubeResource<typeof endpointSliceKind, typeof discoveryV1>[]> | undefined>(undefined, { deep: false });
      const ingresses = observable.box<IComputedValue<readonly KubeResource<typeof ingressKind, typeof networkingV1>[]> | undefined>(undefined, { deep: false });
      const traffic = observable.box<TrafficSnapshot | undefined>(undefined, { deep: false });

      const model = computed(() => {
        const nodeList = nodes.get()?.get();
        const podList = pods.get()?.get();

        if (!nodeList || !podList) return undefined;

        return buildDatacenterModel(nodeList, podList, usage.get());
      });

      const network = computed(() => {
        const serviceList = services.get()?.get();

        if (!serviceList) return undefined;

        return buildNetworkModel(serviceList, slices.get()?.get() ?? [], ingresses.get()?.get() ?? [], traffic.get());
      });

      let viewers = 0;
      let stopCurrent: (() => void) | undefined;

      const pollMetrics = (isStopped: () => boolean) => {
        const runKubectl = runKubectlFor(clusterId);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let lastFingerprint = "";

        const poll = async () => {
          if (isStopped()) return;

          try {
            const [nodeOut, podOut] = await Promise.all([
              runKubectl(["get", "--raw", "/apis/metrics.k8s.io/v1beta1/nodes"]),
              runKubectl(["get", "--raw", "/apis/metrics.k8s.io/v1beta1/pods"]),
            ]);
            const nodeMetrics = JSON.parse(nodeOut) as MetricsList;
            const podMetrics = JSON.parse(podOut) as MetricsList;

            const nodeMap = new Map(nodeMetrics.items.map((item) => [
              item.metadata.name,
              { cpuMilli: parseCpuMilli(item.usage?.cpu), memBytes: parseBytes(item.usage?.memory) },
            ]));
            const podMap = new Map(podMetrics.items.map((item) => {
              let cpuMilli = 0;
              let memBytes = 0;

              for (const container of item.containers ?? []) {
                cpuMilli += parseCpuMilli(container.usage?.cpu);
                memBytes += parseBytes(container.usage?.memory);
              }

              return [`${item.metadata.namespace}/${item.metadata.name}`, { cpuMilli, memBytes }] as const;
            }));

            // Only a change worth showing rebuilds the model: 10m CPU, 4 MiB memory.
            const fingerprint = [...nodeMap, ...podMap]
              .map(([key, value]) => `${key}:${Math.round(value.cpuMilli / 10)}:${Math.round(value.memBytes / 2 ** 22)}`)
              .join("|");

            if (!isStopped() && fingerprint !== lastFingerprint) {
              lastFingerprint = fingerprint;
              action(() => usage.set({ nodes: nodeMap, pods: podMap }))();
            }
            timer = setTimeout(() => void poll(), METRICS_POLL_MS);
          } catch {
            // No metrics-server: the view runs on resource requests. Look again later,
            // in case one gets installed.
            timer = setTimeout(() => void poll(), METRICS_RETRY_MS);
          }
        };

        void poll();

        return () => clearTimeout(timer);
      };

      const run = () => {
        let stopped = false;
        const subscriptions: Array<Subscription<unknown>> = [];
        const disposers: Array<() => void> = [];
        const isStopped = () => stopped;

        const go = async () => {
          action(() => {
            status.set("connecting");
            error.set(undefined);
          })();

          await connectCluster(clusterId);
          if (stopped) return;
          action(() => status.set("loading"))();

          const nodeSubscription = kubeResources(nodeKind, coreV1, clusterId).subscribe();
          const podSubscription = kubeResources(podKind, coreV1, clusterId).subscribe();

          nodeSubscription.claim();
          podSubscription.claim();
          subscriptions.push(nodeSubscription, podSubscription);

          const [nodeValue, podValue] = await Promise.all([nodeSubscription.value, podSubscription.value]);
          if (stopped) return;

          action(() => {
            nodes.set(nodeValue);
            pods.set(podValue);
            status.set("live");
          })();

          disposers.push(
            reaction(
              () => [nodeValue.get(), podValue.get()],
              action(() => revision.set(revision.get() + 1)),
            ),
            pollMetrics(isStopped),
            startTrafficPolling({
              clusterId,
              runKubectl: runKubectlFor(clusterId),
              queryPrometheus,
              nodeNames: () => nodeValue.get().map((node) => node.metadata.name),
              onSnapshot: action((snapshot: TrafficSnapshot) => traffic.set(snapshot)),
            }),
          );

          // The network is a layer on top: a cluster that will not list Services,
          // EndpointSlices or Ingresses to this user still shows its racks.
          const optional = async <T>(subscription: Subscription<T>, box: { set: (value: T | undefined) => void }) => {
            subscription.claim();
            subscriptions.push(subscription as Subscription<unknown>);

            try {
              const value = await subscription.value;
              if (!stopped) action(() => box.set(value as never))();
            } catch {
              // Not served, or not allowed: the layer goes without it.
            }
          };

          void optional(kubeResources(serviceKind, coreV1, clusterId).subscribe(), services as never);
          void optional(kubeResources(endpointSliceKind, discoveryV1, clusterId).subscribe(), slices as never);
          void optional(kubeResources(ingressKind, networkingV1, clusterId).subscribe(), ingresses as never);
        };

        go().catch(action((cause: unknown) => {
          if (stopped) return;
          status.set("error");
          error.set(cause instanceof Error ? cause.message : String(cause));
        }));

        return () => {
          stopped = true;
          disposers.forEach((dispose) => dispose());
          subscriptions.forEach((subscription) => subscription.dispose());
          // Nothing of a stopped feed may be shown: the next viewer starts from fresh data.
          action(() => {
            status.set("idle");
            nodes.set(undefined);
            pods.set(undefined);
            usage.set(undefined);
            services.set(undefined);
            slices.set(undefined);
            ingresses.set(undefined);
            traffic.set(undefined);
          })();
        };
      };

      return {
        status: computed(() => status.get()),
        error: computed(() => error.get()),
        model,
        network,
        revision: computed(() => revision.get()),
        start: () => {
          viewers += 1;

          if (viewers === 1) stopCurrent = run();

          let released = false;

          return () => {
            if (released) return;
            released = true;
            viewers -= 1;

            if (viewers === 0) {
              stopCurrent?.();
              stopCurrent = undefined;
            }
          };
        },
      };
    };
  },
});
