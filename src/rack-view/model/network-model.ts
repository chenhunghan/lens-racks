import type { EndpointSliceV1, IngressV1, ServiceV1 } from "@k8slens/kubernetes-contracts";

// The cluster's network as the API states it: which pods stand behind each Service,
// and which Services the outside world reaches (LoadBalancer, NodePort, Ingress).
// Traffic is measured separately and joined in by pod.

export type ServiceExposure = "internal" | "load-balancer" | "node-port" | "ingress";

export interface ServiceModel {
  readonly key: string; // namespace/name
  readonly uid: string;
  readonly name: string;
  readonly namespace: string;
  readonly type: string;
  readonly exposure: ServiceExposure;
  readonly headless: boolean;
  readonly clusterIp?: string;
  readonly externalAddress?: string; // load balancer hostname or IP
  readonly ingressHosts: readonly string[];
  readonly ports: string;
  readonly podUids: readonly string[];
}

export interface PodTraffic {
  readonly rxBytesPerSec: number;
  readonly txBytesPerSec: number;
}

// A measured call between workloads, from service-mesh telemetry.
export interface MeshEdge {
  readonly fromService?: string; // namespace/name, when the caller is itself behind a Service
  readonly fromWorkload: string; // namespace/name of the calling workload
  readonly toService: string; // namespace/name
  readonly requestsPerSec: number;
}

export interface TrafficSnapshot {
  readonly source: "prometheus" | "kubelet";
  readonly pods: ReadonlyMap<string, PodTraffic>; // namespace/name
  readonly mesh: readonly MeshEdge[];
  readonly meshSource?: "istio" | "linkerd";
}

export interface NetworkModel {
  readonly services: readonly ServiceModel[];
  readonly traffic?: TrafficSnapshot;
}

type Service = ServiceV1 & { metadata: { uid: string; name: string; namespace?: string } };
type Slice = EndpointSliceV1 & { metadata: { name: string; namespace?: string; labels?: Record<string, string> } };
type Ingress = IngressV1 & { metadata: { name: string; namespace?: string } };

const ingressTargets = (ingresses: readonly Ingress[]) => {
  const hostsByService = new Map<string, Set<string>>();

  const add = (namespace: string, service: string | undefined, host: string) => {
    if (!service) return;
    const key = `${namespace}/${service}`;
    const hosts = hostsByService.get(key) ?? new Set<string>();
    hosts.add(host);
    hostsByService.set(key, hosts);
  };

  for (const ingress of ingresses) {
    const namespace = ingress.metadata.namespace ?? "default";
    add(namespace, ingress.spec?.defaultBackend?.service?.name, "*");

    for (const rule of ingress.spec?.rules ?? []) {
      for (const path of rule.http?.paths ?? []) {
        add(namespace, path.backend.service?.name, `${rule.host ?? "*"}${path.path && path.path !== "/" ? path.path : ""}`);
      }
    }
  }

  return hostsByService;
};

export const buildNetworkModel = (
  services: readonly Service[],
  slices: readonly Slice[],
  ingresses: readonly Ingress[],
  traffic: TrafficSnapshot | undefined,
): NetworkModel => {
  const podsByService = new Map<string, Set<string>>();

  for (const slice of slices) {
    const serviceName = slice.metadata.labels?.["kubernetes.io/service-name"];
    if (!serviceName) continue;
    const key = `${slice.metadata.namespace ?? "default"}/${serviceName}`;
    const pods = podsByService.get(key) ?? new Set<string>();

    for (const endpoint of slice.endpoints ?? []) {
      if (endpoint.targetRef?.kind === "Pod" && endpoint.targetRef.uid) pods.add(endpoint.targetRef.uid);
    }

    podsByService.set(key, pods);
  }

  const ingressHosts = ingressTargets(ingresses);

  const models = services.map((service): ServiceModel => {
    const namespace = service.metadata.namespace ?? "default";
    const key = `${namespace}/${service.metadata.name}`;
    const type = service.spec?.type ?? "ClusterIP";
    const hosts = [...(ingressHosts.get(key) ?? [])];
    const lb = service.status?.loadBalancer?.ingress?.[0];

    return {
      key,
      uid: service.metadata.uid,
      name: service.metadata.name,
      namespace,
      type,
      exposure: type === "LoadBalancer" ? "load-balancer" : type === "NodePort" ? "node-port" : hosts.length > 0 ? "ingress" : "internal",
      headless: service.spec?.clusterIP === "None",
      clusterIp: service.spec?.clusterIP && service.spec.clusterIP !== "None" ? service.spec.clusterIP : undefined,
      externalAddress: lb?.hostname ?? lb?.ip,
      ingressHosts: hosts,
      ports: (service.spec?.ports ?? []).map((port) => `${port.port}/${port.protocol ?? "TCP"}`).join(", "),
      podUids: [...(podsByService.get(key) ?? [])],
    };
  });

  // External first, then by namespace and name: the order ports are patched in.
  const rank = (service: ServiceModel) => (service.exposure === "internal" ? 1 : 0);

  return {
    services: models.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key)),
    traffic,
  };
};

export const formatRate = (bytesPerSec: number) => {
  const bits = bytesPerSec * 8;

  if (bits >= 1e9) return `${(bits / 1e9).toFixed(1)} Gb/s`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mb/s`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(0)} kb/s`;

  return `${Math.round(bits)} b/s`;
};
