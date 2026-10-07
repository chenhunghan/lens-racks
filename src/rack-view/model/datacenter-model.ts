import type { NodeV1, PodV1 } from "@k8slens/kubernetes-contracts";

// The cluster as a datacenter: every node is a rack, every pod a blade in one
// of the rack's blade enclosures. Pure data, derived from what the cluster
// serves; the scene only renders it.

export type PodHealth = "running" | "pending" | "failed" | "succeeded" | "terminating" | "unknown";

export interface BladeModel {
  readonly uid: string;
  readonly name: string;
  readonly namespace: string;
  readonly nodeName: string;
  readonly health: PodHealth;
  readonly phase: string;
  readonly reason?: string;
  readonly ready: number;
  readonly containers: number;
  readonly restarts: number;
  readonly cpuRequestMilli: number;
  readonly memRequestBytes: number;
  readonly cpuUsageMilli?: number;
  readonly memUsageBytes?: number;
  readonly ownerKind?: string;
  readonly ownerName?: string;
  readonly startedAt?: string;
  readonly podIp?: string;
  // Shares the node's network namespace: its traffic counters are the node's.
  readonly hostNetwork: boolean;
}

export interface RackModel {
  readonly uid: string;
  readonly name: string;
  // The host part of a fully qualified node name: "ip-10-0-1-5" of "ip-10-0-1-5.eu-west-1.compute.internal".
  readonly shortName: string;
  readonly domain?: string;
  readonly roles: readonly string[];
  readonly isControlPlane: boolean;
  readonly ready: boolean;
  readonly unschedulable: boolean;
  readonly pressure: readonly string[];
  readonly kubeletVersion: string;
  readonly osImage: string;
  readonly arch: string;
  readonly internalIp?: string;
  readonly zone?: string;
  readonly instanceType?: string;
  readonly cpuAllocatableMilli: number;
  readonly memAllocatableBytes: number;
  readonly podCapacity: number;
  readonly cpuRequestedMilli: number;
  readonly memRequestedBytes: number;
  readonly cpuUsageMilli?: number;
  readonly memUsageBytes?: number;
  readonly blades: readonly BladeModel[];
}

export interface DatacenterModel {
  readonly racks: readonly RackModel[];
  // Pods not scheduled on any node yet: they wait on a staging cart.
  readonly unscheduled: readonly BladeModel[];
  readonly namespaces: readonly string[];
  readonly hasUsageMetrics: boolean;
}

export interface UsageMetrics {
  readonly nodes: ReadonlyMap<string, { cpuMilli: number; memBytes: number }>;
  // Keyed by `${namespace}/${name}`.
  readonly pods: ReadonlyMap<string, { cpuMilli: number; memBytes: number }>;
}

type Pod = PodV1 & { metadata: { uid: string; name: string } };
type Node = NodeV1 & { metadata: { uid: string; name: string } };

export const parseCpuMilli = (quantity: string | number | undefined): number => {
  if (quantity === undefined) return 0;
  const text = String(quantity).trim();
  if (text.endsWith("n")) return parseFloat(text) / 1e6;
  if (text.endsWith("u")) return parseFloat(text) / 1e3;
  if (text.endsWith("m")) return parseFloat(text);

  return parseFloat(text) * 1000 || 0;
};

const memSuffixes: Record<string, number> = {
  Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60,
  k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
};

export const parseBytes = (quantity: string | number | undefined): number => {
  if (quantity === undefined) return 0;
  const match = /^([0-9.eE+-]+)\s*([A-Za-z]*)$/.exec(String(quantity).trim());
  if (!match) return 0;
  const value = parseFloat(match[1]!);

  return value * (memSuffixes[match[2]!] ?? 1);
};

const podHealth = (pod: Pod): { health: PodHealth; reason?: string } => {
  if (pod.metadata.deletionTimestamp) return { health: "terminating", reason: "Terminating" };

  const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
  const waiting = statuses.find((s) => s.state?.waiting?.reason && s.state.waiting.reason !== "PodInitializing" && s.state.waiting.reason !== "ContainerCreating");
  const badWaiting = waiting?.state?.waiting?.reason;
  const terminatedBad = statuses.find((s) => s.state?.terminated && s.state.terminated.exitCode !== 0 && pod.status?.phase !== "Succeeded");

  switch (pod.status?.phase) {
    case "Succeeded":
      return { health: "succeeded", reason: "Completed" };
    case "Failed":
      return { health: "failed", reason: pod.status.reason ?? "Failed" };
    case "Pending":
      if (badWaiting && /BackOff|Err|Invalid/.test(badWaiting)) return { health: "failed", reason: badWaiting };

      return { health: "pending", reason: badWaiting ?? pod.status.reason ?? "Pending" };
    case "Running": {
      if (badWaiting) return { health: "failed", reason: badWaiting };
      if (terminatedBad) return { health: "failed", reason: terminatedBad.state?.terminated?.reason ?? "Error" };
      const allReady = (pod.status.containerStatuses ?? []).every((s) => s.ready);

      return allReady ? { health: "running" } : { health: "pending", reason: "NotReady" };
    }
    default:
      return { health: "unknown", reason: pod.status?.phase ?? "Unknown" };
  }
};

const sumRequests = (pod: Pod) => {
  let cpu = 0;
  let mem = 0;

  for (const container of pod.spec.containers ?? []) {
    cpu += parseCpuMilli(container.resources?.requests?.["cpu"] as string | undefined);
    mem += parseBytes(container.resources?.requests?.["memory"] as string | undefined);
  }

  // An init container runs alone, so the pod reserves the larger of the two.
  for (const container of pod.spec.initContainers ?? []) {
    cpu = Math.max(cpu, parseCpuMilli(container.resources?.requests?.["cpu"] as string | undefined));
    mem = Math.max(mem, parseBytes(container.resources?.requests?.["memory"] as string | undefined));
  }

  return { cpu, mem };
};

const toBlade = (pod: Pod, usage: UsageMetrics | undefined): BladeModel => {
  const { health, reason } = podHealth(pod);
  const statuses = pod.status?.containerStatuses ?? [];
  const requests = sumRequests(pod);
  const owner = pod.metadata.ownerReferences?.find((ref) => ref.controller) ?? pod.metadata.ownerReferences?.[0];
  const podUsage = usage?.pods.get(`${pod.metadata.namespace}/${pod.metadata.name}`);

  return {
    uid: pod.metadata.uid,
    name: pod.metadata.name,
    namespace: pod.metadata.namespace ?? "default",
    nodeName: pod.spec.nodeName ?? "",
    health,
    phase: pod.status?.phase ?? "Unknown",
    reason,
    ready: statuses.filter((s) => s.ready).length,
    containers: pod.spec.containers?.length ?? statuses.length,
    restarts: statuses.reduce((total, s) => total + (s.restartCount ?? 0), 0),
    cpuRequestMilli: requests.cpu,
    memRequestBytes: requests.mem,
    cpuUsageMilli: podUsage?.cpuMilli,
    memUsageBytes: podUsage?.memBytes,
    ownerKind: owner?.kind,
    ownerName: owner?.name,
    startedAt: pod.status?.startTime,
    podIp: pod.status?.podIP,
    hostNetwork: Boolean(pod.spec.hostNetwork),
  };
};

const bladeOrder = (a: BladeModel, b: BladeModel) =>
  a.namespace.localeCompare(b.namespace) || (a.ownerName ?? "").localeCompare(b.ownerName ?? "") || a.name.localeCompare(b.name);

const toRack = (node: Node, blades: BladeModel[], usage: UsageMetrics | undefined): RackModel => {
  const labels = node.metadata.labels ?? {};
  const roles = Object.keys(labels)
    .filter((key) => key.startsWith("node-role.kubernetes.io/"))
    .map((key) => key.slice("node-role.kubernetes.io/".length))
    .filter(Boolean);
  const conditions = node.status?.conditions ?? [];
  const nodeUsage = usage?.nodes.get(node.metadata.name);
  // Finished pods hold no resources.
  const holding = blades.filter((blade) => blade.health !== "succeeded" && blade.phase !== "Failed");

  return {
    uid: node.metadata.uid,
    name: node.metadata.name,
    shortName: node.metadata.name.split(".")[0] ?? node.metadata.name,
    domain: node.metadata.name.includes(".") ? node.metadata.name.slice(node.metadata.name.indexOf(".") + 1) : undefined,
    roles,
    isControlPlane: roles.includes("control-plane") || roles.includes("master"),
    ready: conditions.some((c) => c.type === "Ready" && c.status === "True"),
    unschedulable: Boolean(node.spec.unschedulable),
    pressure: conditions.filter((c) => c.type !== "Ready" && c.status === "True").map((c) => c.type),
    kubeletVersion: node.status?.nodeInfo?.kubeletVersion ?? "",
    osImage: node.status?.nodeInfo?.osImage ?? "",
    arch: node.status?.nodeInfo?.architecture ?? "",
    internalIp: node.status?.addresses?.find((a) => a.type === "InternalIP")?.address,
    zone: labels["topology.kubernetes.io/zone"],
    instanceType: labels["node.kubernetes.io/instance-type"],
    cpuAllocatableMilli: parseCpuMilli(node.status?.allocatable?.["cpu"] as string | undefined),
    memAllocatableBytes: parseBytes(node.status?.allocatable?.["memory"] as string | undefined),
    podCapacity: parseInt(String(node.status?.allocatable?.["pods"] ?? "110"), 10) || 110,
    cpuRequestedMilli: holding.reduce((total, blade) => total + blade.cpuRequestMilli, 0),
    memRequestedBytes: holding.reduce((total, blade) => total + blade.memRequestBytes, 0),
    cpuUsageMilli: nodeUsage?.cpuMilli,
    memUsageBytes: nodeUsage?.memBytes,
    blades: [...blades].sort(bladeOrder),
  };
};

const rackOrder = (a: RackModel, b: RackModel) =>
  Number(b.isControlPlane) - Number(a.isControlPlane) || (a.zone ?? "").localeCompare(b.zone ?? "") || a.name.localeCompare(b.name, undefined, { numeric: true });

export const buildDatacenterModel = (
  nodes: readonly Node[],
  pods: readonly Pod[],
  usage: UsageMetrics | undefined,
): DatacenterModel => {
  const bladesByNode = new Map<string, BladeModel[]>();
  const unscheduled: BladeModel[] = [];
  const namespaces = new Set<string>();

  for (const pod of pods) {
    const blade = toBlade(pod, usage);
    namespaces.add(blade.namespace);

    if (!blade.nodeName) {
      unscheduled.push(blade);
      continue;
    }

    const list = bladesByNode.get(blade.nodeName) ?? [];
    list.push(blade);
    bladesByNode.set(blade.nodeName, list);
  }

  return {
    racks: nodes.map((node) => toRack(node, bladesByNode.get(node.metadata.name) ?? [], usage)).sort(rackOrder),
    unscheduled: unscheduled.sort(bladeOrder),
    namespaces: [...namespaces].sort(),
    hasUsageMetrics: Boolean(usage && usage.nodes.size > 0),
  };
};

export interface BladeFilter {
  readonly focusNamespace?: string;
  readonly search: string;
}

export const isFiltering = (filter: BladeFilter) => Boolean(filter.focusNamespace || filter.search.trim());

export const bladeMatches = (blade: BladeModel, filter: BladeFilter) => {
  if (filter.focusNamespace && blade.namespace !== filter.focusNamespace) return false;

  const needle = filter.search.trim().toLowerCase();

  if (!needle) return true;

  return [blade.name, blade.namespace, blade.ownerName ?? "", blade.nodeName].some((text) => text.toLowerCase().includes(needle));
};
