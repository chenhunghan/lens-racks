import type { QueryPrometheusRange } from "@k8slens/prometheus-contracts";
import type { MeshEdge, PodTraffic, TrafficSnapshot } from "./network-model";

// Measures how much each pod sends and receives, with what the cluster already has:
// its Prometheus (cAdvisor), when Lens knows one, or else the kubelet's own stats
// through the API server. Mesh telemetry (Istio, Linkerd) adds who calls whom.

const POLL_MS = 15_000;
const KUBELET_MAX_NODES = 80;
const KUBELET_CONCURRENCY = 4;

interface Options {
  readonly clusterId: string;
  readonly runKubectl: (args: string[]) => Promise<string>;
  readonly queryPrometheus: QueryPrometheusRange;
  readonly nodeNames: () => readonly string[];
  readonly onSnapshot: (snapshot: TrafficSnapshot) => void;
}

const lastValue = (values: ReadonlyArray<readonly [number, string]>) => {
  const value = Number(values.at(-1)?.[1]);

  return Number.isFinite(value) ? value : 0;
};

const queryPrometheus = async ({ clusterId, queryPrometheus: query }: Options): Promise<TrafficSnapshot | undefined> => {
  const end = Math.floor(Date.now() / 1000);
  const range = { start: end - 60, end, step: 30 };
  const [rx, tx] = await Promise.all([
    query(clusterId, "sum by (namespace, pod) (rate(container_network_receive_bytes_total[2m]))", range),
    query(clusterId, "sum by (namespace, pod) (rate(container_network_transmit_bytes_total[2m]))", range),
  ]);

  if (rx.length === 0 && tx.length === 0) return undefined;

  const pods = new Map<string, PodTraffic>();
  const add = (namespace: string | undefined, pod: string | undefined, rxRate: number, txRate: number) => {
    if (!namespace || !pod) return;
    const key = `${namespace}/${pod}`;
    const previous = pods.get(key) ?? { rxBytesPerSec: 0, txBytesPerSec: 0 };
    pods.set(key, { rxBytesPerSec: previous.rxBytesPerSec + rxRate, txBytesPerSec: previous.txBytesPerSec + txRate });
  };

  for (const series of rx) add(series.metric["namespace"], series.metric["pod"], lastValue(series.values), 0);
  for (const series of tx) add(series.metric["namespace"], series.metric["pod"], 0, lastValue(series.values));

  // Mesh telemetry, when the cluster's Prometheus scrapes it. Absent is normal.
  let mesh: MeshEdge[] = [];
  let meshSource: TrafficSnapshot["meshSource"];

  try {
    const istio = await query(
      clusterId,
      'sum by (source_workload, source_workload_namespace, destination_service_name, destination_service_namespace) (rate(istio_requests_total{reporter="source"}[2m]))',
      range,
    );

    mesh = istio
      .filter((s) => s.metric["destination_service_name"] && s.metric["source_workload"] && s.metric["source_workload"] !== "unknown")
      .map((s) => ({
        fromWorkload: `${s.metric["source_workload_namespace"]}/${s.metric["source_workload"]}`,
        toService: `${s.metric["destination_service_namespace"]}/${s.metric["destination_service_name"]}`,
        requestsPerSec: lastValue(s.values),
      }));
    if (mesh.length) meshSource = "istio";

    if (!mesh.length) {
      const linkerd = await query(
        clusterId,
        'sum by (deployment, namespace, dst_service, dst_namespace) (rate(response_total{direction="outbound"}[2m]))',
        range,
      );

      mesh = linkerd
        .filter((s) => s.metric["dst_service"] && s.metric["deployment"])
        .map((s) => ({
          fromWorkload: `${s.metric["namespace"]}/${s.metric["deployment"]}`,
          toService: `${s.metric["dst_namespace"]}/${s.metric["dst_service"]}`,
          requestsPerSec: lastValue(s.values),
        }));
      if (mesh.length) meshSource = "linkerd";
    }
  } catch {
    // No mesh metrics: topology and throughput still stand.
  }

  return { source: "prometheus", pods, mesh: mesh.filter((edge) => edge.requestsPerSec > 0.001), meshSource };
};

interface KubeletSummary {
  pods?: Array<{
    podRef: { name: string; namespace: string };
    network?: { time?: string; rxBytes?: number; txBytes?: number };
  }>;
}

// Rates from the kubelet's cumulative counters: two samples make a rate.
const createKubeletSampler = () => {
  const previous = new Map<string, { at: number; rx: number; tx: number }>();

  return async ({ runKubectl, nodeNames }: Options): Promise<TrafficSnapshot | undefined> => {
    const nodes = nodeNames().slice(0, KUBELET_MAX_NODES);
    const pods = new Map<string, PodTraffic>();
    let index = 0;
    let answered = 0;

    const worker = async () => {
      while (index < nodes.length) {
        const node = nodes[index++]!;

        try {
          const summary = JSON.parse(await runKubectl(["get", "--raw", `/api/v1/nodes/${encodeURIComponent(node)}/proxy/stats/summary`])) as KubeletSummary;
          answered++;

          for (const pod of summary.pods ?? []) {
            const network = pod.network;
            if (network?.rxBytes === undefined || network.txBytes === undefined) continue;

            const key = `${pod.podRef.namespace}/${pod.podRef.name}`;
            const at = network.time ? Date.parse(network.time) : Date.now();
            const before = previous.get(key);
            previous.set(key, { at, rx: network.rxBytes, tx: network.txBytes });

            if (before && at > before.at) {
              const seconds = (at - before.at) / 1000;
              pods.set(key, {
                rxBytesPerSec: Math.max(0, network.rxBytes - before.rx) / seconds,
                txBytesPerSec: Math.max(0, network.txBytes - before.tx) / seconds,
              });
            }
          }
        } catch {
          // A node we may not ask (RBAC on nodes/proxy) or that is down: skip it.
        }
      }
    };

    await Promise.all(Array.from({ length: KUBELET_CONCURRENCY }, worker));

    if (answered === 0) return undefined;

    return { source: "kubelet", pods, mesh: [] };
  };
};

export const startTrafficPolling = (options: Options) => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let usePrometheus = true;
  const sampleKubelet = createKubeletSampler();

  const poll = async () => {
    if (stopped) return;

    let snapshot: TrafficSnapshot | undefined;

    if (usePrometheus) {
      try {
        snapshot = await queryPrometheus(options);
      } catch {
        snapshot = undefined;
      }

      // No Prometheus, or one without cAdvisor: the kubelets it is, from now on.
      if (!snapshot) usePrometheus = false;
    }

    if (!snapshot && !usePrometheus) snapshot = await sampleKubelet(options);
    if (stopped) return;
    if (snapshot) options.onSnapshot(snapshot);

    // The kubelet needs two samples for a rate: take the second one soon.
    const next = snapshot?.source === "kubelet" && snapshot.pods.size === 0 ? 3000 : POLL_MS;
    timer = setTimeout(() => void poll(), next);
  };

  void poll();

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
};
