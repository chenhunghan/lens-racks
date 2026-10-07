import { Badge } from "@k8slens/badge";
import { DrawerItem } from "@k8slens/details-panel-components";
import { Button, Div, Span } from "@k8slens/element-components";
import {
  CloseIcon,
  CpuIcon,
  FullscreenIcon,
  KeyboardArrowDownIcon,
  KeyboardArrowRightIcon,
  NetworkIcon,
  NodesIcon,
  NotificationsIcon,
  OpenInBrowserIcon,
  PodsIcon,
  SearchIcon,
} from "@k8slens/icon";
import { PlainButton, PrimaryButton, TextInput } from "@k8slens/input-components";
import { useInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import { useEffect, useRef } from "react";
import type { BladeModel, DatacenterModel, PodHealth, RackModel } from "./model/datacenter-model";
import { clusterFeedInjectable } from "./model/cluster-feed.injectable";
import type { ShelfInfo } from "./scene/datacenter-scene";
import { formatRate, type PodTraffic, type ServiceModel } from "./model/network-model";
import { rackViewActionsInjectable } from "./rack-view-actions.injectable";
import { rackViewStateInjectable, type RackViewState } from "./rack-view-state.injectable";
import styles from "./rack-view.module.scss";
import { healthLabel, namespaceCss } from "./scene/palette";
import { type QualitySetting, type RackPart, sameTarget, type SceneEvent } from "./scene/scene-types";

// Status colours are Lens's own theme roles.
const healthVar: Record<PodHealth, string> = {
  running: "var(--success)",
  pending: "var(--warning)",
  failed: "var(--critical)",
  succeeded: "var(--primary)",
  terminating: "var(--grey40)",
  unknown: "var(--notice)",
};

const cores = (milli: number) => (milli >= 1000 ? `${(milli / 1000).toFixed(milli >= 10000 ? 0 : 2)} cores` : `${Math.round(milli)}m`);
const bytes = (value: number) => {
  if (value >= 2 ** 30) return `${(value / 2 ** 30).toFixed(1)} GiB`;
  if (value >= 2 ** 20) return `${Math.round(value / 2 ** 20)} MiB`;

  return `${Math.round(value / 2 ** 10)} KiB`;
};
const age = (iso?: string) => {
  if (!iso) return "—";
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 120) return `${Math.round(seconds)}s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h`;

  return `${Math.round(seconds / 86400)}d`;
};

// Every HUD panel is the same glass: see .panel in the stylesheet.
const Panel = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <Div $className={[styles.panel, className]} $border={{ radius: "m" }} $boxShadow $padding={{ horizontal: "s", vertical: "xs" }}>
    {children}
  </Div>
);

// HUD hints are native tooltips: Lens's tooltip positions itself in page coordinates, which
// the HUD's zoomed panels would throw off.
const IconAction = ({ children, $onClick, $tooltip, active }: { children: React.ReactNode; $onClick: () => void; $tooltip: string; active?: boolean }) => (
  <Button
    $onClick={$onClick}
    title={$tooltip}
    $flex={{ verticalAlign: "center", horizontalAlign: "center" }}
    $padding="xs"
    $color={active ? "primary" : { normal: "textMuted", hover: "textHighlight" }}
    $backgroundColor={{ hover: "backgroundPrimary" }}
    $border={{ radius: "s" }}
    aria-label={$tooltip}
    aria-pressed={active}
  >
    {children}
  </Button>
);

const Dot = ({ color, live }: { color: string; live?: boolean }) => (
  <span className={[styles.dot, live ? styles.live : ""].join(" ")} style={{ background: color }} />
);

// ---------------------------------------------------------------------------

// One quiet line: what is live, and only the trouble worth a glance. The details of where
// the numbers come from are in its tooltip.
const Summary = observer(({ clusterId, model }: { clusterId: string; model: DatacenterModel }) => {
  const feed = useInject(clusterFeedInjectable)(clusterId);
  const pods = [...model.racks.flatMap((rack) => rack.blades), ...model.unscheduled];
  const count = (health: PodHealth) => pods.filter((pod) => pod.health === health).length;
  const ready = model.racks.filter((rack) => rack.ready).length;
  const networkModel = feed.network.get();
  feed.revision.get();
  const sources = [
    model.hasUsageMetrics ? "CPU and memory from metrics-server" : "No metrics-server: load shows CPU requests",
    networkModel &&
      `${networkModel.services.length} services, ${networkModel.services.filter((s) => s.exposure !== "internal").length} reachable from outside; traffic ${networkModel.traffic ? `from ${networkModel.traffic.source === "prometheus" ? "Prometheus" : "kubelet stats"}` : "being measured"}${networkModel.traffic?.meshSource ? `, calls from ${networkModel.traffic.meshSource}` : ""}`,
  ].filter(Boolean).join(". ");
  const trouble = (["failed", "pending"] as const).filter((health) => count(health) > 0);

  return (
    <Panel>
      <Div $flex={{ direction: "horizontal", gap: "m", verticalAlign: "center" }} title={sources}>
        <Span $flex={{ gap: "xs", verticalAlign: "center" }} $color="textDefault" $font={{ size: "xs", bold: true }}>
          <Dot color="var(--success)" live /> Live
        </Span>
        <Span $color="textMuted" $font={{ size: "xs" }} title="Nodes Ready / total">
          {ready}/{model.racks.length} nodes
        </Span>
        <Span $color="textMuted" $font={{ size: "xs" }}>{pods.length} pods</Span>
        {trouble.map((health) => (
          <Span key={health} $flex={{ gap: "xs", verticalAlign: "center" }} $color={health === "failed" ? "critical" : "warning"} $font={{ size: "xs" }}>
            <Dot color={healthVar[health]} /> {count(health)} {healthLabel[health].toLowerCase()}
          </Span>
        ))}
      </Div>
    </Panel>
  );
});

const qualityOptions: Array<{ id: QualitySetting; label: string }> = [
  { id: "auto", label: "Auto" },
  { id: "ultra", label: "Ultra" },
  { id: "high", label: "High" },
  { id: "balanced", label: "Balanced" },
];

const Toolbar = observer(({ clusterId }: { clusterId: string }) => {
  const state = useInject(rackViewStateInjectable)(clusterId);
  const actions = useInject(rackViewActionsInjectable)(clusterId);
  const thermal = state.thermal.get();
  const network = state.network.get();
  const quality = state.quality.get();
  const matches = actions.matches();

  return (
    <Panel>
      <Div $flex={{ direction: "horizontal", gap: "xs", verticalAlign: "center" }}>
        <Div $flex={{ gap: "xs", verticalAlign: "center" }} $className={styles.search}>
          <SearchIcon $size="s" $color="textMuted" />
          <TextInput
            type="search"
            placeholder="Find pods…"
            value={state.search.get()}
            onChange={(event) => state.setSearch(event.target.value)}
            onKeyDown={(event) => {
              const first = actions.matches()?.[0];
              if (event.key === "Enter" && first) actions.focus({ type: "blade", uid: first.uid });
              if (event.key === "Escape") state.setSearch("");
            }}
            title="Name, namespace, owner or node. Enter flies to the first match."
          />
          {matches && (
            <Span $color={matches.length ? "textMuted" : "warning"} $font={{ size: "xs", noWrap: true }}>
              {matches.length}
            </Span>
          )}
        </Div>
        <IconAction
          $onClick={state.cycleNetwork}
          active={network !== "off"}
          $tooltip={{ all: "Network: every link. Click for busy links only.", busy: "Network: busy links only. Click to hide.", off: "Network hidden. Click to show every link." }[network]}
        >
          <NetworkIcon />
        </IconAction>
        <IconAction $onClick={state.toggleThermal} active={thermal} $tooltip={thermal ? "Thermal view on" : "Thermal view: colour blades by CPU load against their requests"}>
          <CpuIcon />
        </IconAction>
        <IconAction $onClick={actions.overview} $tooltip="Show the whole cluster (H)">
          <FullscreenIcon />
        </IconAction>
        <span className={styles.bell}>
          <IconAction $onClick={state.toggleEvents} active={state.showEvents.get()} $tooltip={state.showEvents.get() ? "Hide activity" : "Show activity"}>
            <NotificationsIcon />
          </IconAction>
          {state.unread.get() && !state.showEvents.get() && <span className={styles.unread} />}
        </span>
        <Button
          $onClick={() => state.setQuality(qualityOptions[(qualityOptions.findIndex((o) => o.id === quality) + 1) % qualityOptions.length]!.id)}
          title={`Render quality: ${quality === "auto" ? `auto (${state.activeQuality.get()})` : quality}, ${state.fps.get()} fps. Click to change.`}
          $color={{ normal: "textMuted", hover: "textDefault" }}
          $font={{ size: "xxs" }}
          $padding={{ horizontal: "xs", vertical: "xxs" }}
        >
          {state.fps.get()} fps
        </Button>
      </Div>
    </Panel>
  );
});

const Legend = observer(({ clusterId, model }: { clusterId: string; model: DatacenterModel }) => {
  const state = useInject(rackViewStateInjectable)(clusterId);
  const focus = state.focusNamespace.get();
  const expanded = state.legendExpanded.get();
  const counts = new Map<string, number>();

  for (const blade of [...model.racks.flatMap((rack) => rack.blades), ...model.unscheduled]) {
    counts.set(blade.namespace, (counts.get(blade.namespace) ?? 0) + 1);
  }

  const item = (key: string, swatch: React.ReactNode, label: string) => (
    <Span key={key} $flex={{ gap: "xs", verticalAlign: "center" }} $color="textMuted" $font={{ size: "xxs" }}>
      {swatch} {label}
    </Span>
  );

  return (
    <Panel>
      <Div $flex={{ direction: "vertical", gap: "xs" }}>
        {state.thermal.get() && (
          <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
            <Span $color="textMuted" $font={{ size: "xxs" }}>Cool</Span>
            <span className={styles.heatScale} />
            <Span $color="textMuted" $font={{ size: "xxs" }}>{model.hasUsageMetrics ? "Hot · at its CPU request" : "Hot · large request"}</Span>
          </Div>
        )}
        <Div $flex={{ direction: "horizontal", gap: "s", wrap: true }}>
          {(["running", "pending", "failed", "succeeded"] as const).map((health) => item(health, <Dot color={healthVar[health]} />, healthLabel[health]))}
          {state.network.get() !== "off" && [
            item("internal", <span className={styles.fibre} style={{ background: "#d9b43a" }} />, "Internal"),
            item("outside", <span className={styles.fibre} style={{ background: "var(--primary)" }} />, "From outside"),
            item("in", <Dot color="var(--primary)" />, "In"),
            item("out", <Dot color="var(--warning)" />, "Out"),
          ]}
        </Div>
        <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center", wrap: true }}>
          <Span $color="textMuted" $font={{ size: "xxs" }}>Shelves</Span>
          {([["namespace", "By namespace"], ["even", "Spread evenly"]] as const).map(([mode, label]) => (
            <Button
              key={mode}
              $onClick={() => state.setShelves(mode)}
              aria-pressed={state.shelves.get() === mode}
              $font={{ size: "xxs", bold: state.shelves.get() === mode }}
              $padding={{ horizontal: "xs", vertical: "xxs" }}
              $border={{ radius: "s" }}
              $backgroundColor={state.shelves.get() === mode ? "backgroundPrimary" : { hover: "backgroundPrimary" }}
              $color={state.shelves.get() === mode ? "textHighlight" : { normal: "textMuted", hover: "textDefault" }}
              title={mode === "namespace" ? "Each namespace on shelves of its own, named on the shelf" : "Pods spread down every shelf of the rack"}
            >
              {label}
            </Button>
          ))}
          <Button
            $onClick={state.toggleLegend}
            $flex={{ gap: "xxs", verticalAlign: "center" }}
            $color={{ normal: "textMuted", hover: "textDefault" }}
            $font={{ size: "xxs" }}
            aria-expanded={expanded}
          >
            {expanded ? <KeyboardArrowDownIcon $size="xs" /> : <KeyboardArrowRightIcon $size="xs" />}
            {model.namespaces.length} namespaces
          </Button>
          {!expanded && focus && (
            <Badge small $onClick={() => state.setFocusNamespace(undefined)} title="Show every namespace">
              <Span $flex={{ gap: "xs", verticalAlign: "center" }}>
                <span className={styles.swatch} style={{ background: namespaceCss(focus) }} /> {focus} ×
              </Span>
            </Badge>
          )}
          <Span $color="textMuted" $font={{ size: "xxs" }} title="Drag to orbit · right-drag to pan · scroll to zoom · click a pod to draw it out · double-click to fly to · Esc to go back">
            ?
          </Span>
        </Div>
        {expanded && (
          <div className={styles.namespaces}>
            <Div $flex={{ direction: "horizontal", gap: "xs", wrap: true }}>
              {model.namespaces.map((namespace) => (
                <Badge
                  key={namespace}
                  small
                  title={focus === namespace ? "Show every namespace" : `Highlight ${namespace}`}
                  $onClick={() => state.setFocusNamespace(focus === namespace ? undefined : namespace)}
                  $faded={Boolean(focus && focus !== namespace)}
                >
                  <Span $flex={{ gap: "xs", verticalAlign: "center" }}>
                    <span className={styles.swatch} style={{ background: namespaceCss(namespace) }} />
                    {namespace} <Span $color="textMuted">{counts.get(namespace) ?? 0}</Span>
                  </Span>
                </Badge>
              ))}
            </Div>
          </div>
        )}
      </Div>
    </Panel>
  );
});

const BladeRows = ({ blade, traffic, services }: { blade: BladeModel; traffic?: PodTraffic; services: readonly ServiceModel[] }) => (
  <>
    <DrawerItem name="Namespace">
      <Span $flex={{ gap: "xs", verticalAlign: "center" }}>
        <span className={styles.swatch} style={{ background: namespaceCss(blade.namespace) }} /> {blade.namespace}
      </Span>
    </DrawerItem>
    <DrawerItem name="Status">
      <Badge small label={blade.reason && blade.health !== "running" ? blade.reason : blade.phase} $backgroundColor={blade.health === "running" ? "success" : blade.health === "failed" ? "critical" : blade.health === "pending" ? "warning" : undefined} $color={["running", "failed", "pending"].includes(blade.health) ? "white" : undefined} />
    </DrawerItem>
    <DrawerItem name="Node">{blade.nodeName || "Not scheduled"}</DrawerItem>
    <DrawerItem name="Containers">{blade.ready}/{blade.containers} ready</DrawerItem>
    <DrawerItem name="Restarts">{blade.restarts}</DrawerItem>
    {blade.ownerKind && <DrawerItem name="Controlled by">{blade.ownerKind} {blade.ownerName}</DrawerItem>}
    <DrawerItem name="CPU">
      {blade.cpuUsageMilli !== undefined ? `${cores(blade.cpuUsageMilli)} used · ` : ""}
      {blade.cpuRequestMilli ? `${cores(blade.cpuRequestMilli)} requested` : "no request"}
    </DrawerItem>
    <DrawerItem name="Memory">
      {blade.memUsageBytes !== undefined ? `${bytes(blade.memUsageBytes)} used · ` : ""}
      {blade.memRequestBytes ? `${bytes(blade.memRequestBytes)} requested` : "no request"}
    </DrawerItem>
    <DrawerItem name="Network">
      {blade.hostNetwork ? "Host network (shares the node's)" : traffic ? `↓ ${formatRate(traffic.rxBytesPerSec)} · ↑ ${formatRate(traffic.txBytesPerSec)}` : "—"}
    </DrawerItem>
    {services.length > 0 && <DrawerItem name="Services">{services.map((service) => service.name).join(", ")}</DrawerItem>}
    <DrawerItem name="Pod IP">{blade.podIp}</DrawerItem>
    <DrawerItem name="Age">{age(blade.startedAt)}</DrawerItem>
  </>
);

const exposureLabel: Record<ServiceModel["exposure"], string> = {
  internal: "Inside the cluster",
  "load-balancer": "Load balancer",
  "node-port": "Node port",
  ingress: "Ingress",
};

const ServiceRows = ({ service, traffic }: { service: ServiceModel; traffic: { rx: number; tx: number } }) => (
  <>
    <DrawerItem name="Namespace">
      <Span $flex={{ gap: "xs", verticalAlign: "center" }}>
        <span className={styles.swatch} style={{ background: namespaceCss(service.namespace) }} /> {service.namespace}
      </Span>
    </DrawerItem>
    <DrawerItem name="Type">{service.type}{service.headless ? " (headless)" : ""}</DrawerItem>
    <DrawerItem name="Reached from">
      <Badge small label={exposureLabel[service.exposure]} $backgroundColor={service.exposure === "internal" ? undefined : "primary"} $color={service.exposure === "internal" ? undefined : "white"} />
    </DrawerItem>
    {service.externalAddress && <DrawerItem name="Address">{service.externalAddress}</DrawerItem>}
    {service.ingressHosts.length > 0 && <DrawerItem name="Ingress hosts">{service.ingressHosts.join(", ")}</DrawerItem>}
    <DrawerItem name="Cluster IP">{service.clusterIp}</DrawerItem>
    <DrawerItem name="Ports">{service.ports}</DrawerItem>
    <DrawerItem name="Endpoints">
      {service.podUids.length === 0 && !service.headless ? <Badge small label="None ready" $backgroundColor="warning" $color="white" /> : `${service.podUids.length} pod${service.podUids.length === 1 ? "" : "s"}`}
    </DrawerItem>
    <DrawerItem name="Traffic">↓ {formatRate(traffic.rx)} · ↑ {formatRate(traffic.tx)}</DrawerItem>
  </>
);

const RackRows = ({ rack }: { rack: RackModel }) => {
  const pods = rack.blades.filter((b) => b.health !== "succeeded").length;

  return (
    <>
      <DrawerItem name="Status">
        <Badge
          small
          label={!rack.ready ? "NotReady" : rack.unschedulable ? "Cordoned" : "Ready"}
          $backgroundColor={!rack.ready ? "critical" : rack.unschedulable ? "warning" : "success"}
          $color="white"
        />
        {rack.pressure.map((p) => <Badge key={p} small label={p} $backgroundColor="warning" $color="white" />)}
      </DrawerItem>
      <DrawerItem name="Roles">{rack.roles.join(", ") || "worker"}</DrawerItem>
      <DrawerItem name="Pods">{pods} / {rack.podCapacity}</DrawerItem>
      <DrawerItem name="CPU">
        {rack.cpuUsageMilli !== undefined ? `${cores(rack.cpuUsageMilli)} used · ` : ""}
        {cores(rack.cpuRequestedMilli)} requested of {cores(rack.cpuAllocatableMilli)}
      </DrawerItem>
      <DrawerItem name="Memory">
        {rack.memUsageBytes !== undefined ? `${bytes(rack.memUsageBytes)} used · ` : ""}
        {bytes(rack.memRequestedBytes)} requested of {bytes(rack.memAllocatableBytes)}
      </DrawerItem>
      <DrawerItem name="Kubelet">{rack.kubeletVersion}</DrawerItem>
      <DrawerItem name="OS">{rack.osImage} ({rack.arch})</DrawerItem>
      <DrawerItem name="Internal IP">{rack.internalIp}</DrawerItem>
      {rack.zone && <DrawerItem name="Zone">{rack.zone}</DrawerItem>}
      {rack.instanceType && <DrawerItem name="Instance type">{rack.instanceType}</DrawerItem>}
    </>
  );
};

const ShelfRows = ({ shelf, onPod }: { shelf: ShelfInfo; onPod: (uid: string) => void }) => (
  <>
    <DrawerItem name="Node">{shelf.rack.shortName}</DrawerItem>
    <DrawerItem name="Bays">{shelf.blades.length} used · {Math.max(0, shelf.open - shelf.blades.length)} open</DrawerItem>
    <DrawerItem name="Namespaces">
      <Div $flex={{ direction: "vertical", gap: "xxs" }}>
        {shelf.namespaces.length === 0 ? "—" : shelf.namespaces.map(([namespace, count]) => (
          <Span key={namespace} $flex={{ gap: "xs", verticalAlign: "center" }}>
            <span className={styles.swatch} style={{ background: namespaceCss(namespace) }} /> {namespace} <Span $color="textMuted">{count}</Span>
          </Span>
        ))}
      </Div>
    </DrawerItem>
    <DrawerItem name="Pods">
      <Div $flex={{ direction: "vertical", gap: "xxs" }}>
        {shelf.blades.length === 0 ? "—" : shelf.blades.map((blade) => (
          <Button
            key={blade.uid}
            $onClick={() => onPod(blade.uid)}
            $flex={{ gap: "xs", verticalAlign: "center" }}
            $color={{ normal: "textDefault", hover: "textHighlight" }}
            title={`${blade.namespace}/${blade.name}`}
          >
            <Dot color={healthVar[blade.health]} />
            <Span $font={{ textOverflow: "ellipsis", noWrap: true }}>{blade.name}</Span>
          </Button>
        ))}
      </Div>
    </DrawerItem>
  </>
);

const partLabel: Record<RackPart, string> = {
  switch: "Top-of-rack switch",
  controller: "Node controller",
  ups: "UPS",
};

const PartRows = ({ part, rack, traffic }: { part: RackPart; rack: RackModel; traffic: { rx: number; tx: number } }) => {
  if (part === "controller") return <RackRows rack={rack} />;

  if (part === "switch") {
    const running = rack.blades.filter((b) => b.health === "running").length;

    return (
      <>
        <DrawerItem name="Node">{rack.shortName}</DrawerItem>
        <DrawerItem name="Pod traffic">↓ {formatRate(traffic.rx)} · ↑ {formatRate(traffic.tx)}</DrawerItem>
        <DrawerItem name="Pods online">{running} running</DrawerItem>
        <DrawerItem name="Internal IP">{rack.internalIp}</DrawerItem>
        {rack.zone && <DrawerItem name="Zone">{rack.zone}</DrawerItem>}
        <DrawerItem name="Uplink">Trunk to the network core</DrawerItem>
      </>
    );
  }

  return (
    <>
      <DrawerItem name="Node">{rack.shortName}</DrawerItem>
      <DrawerItem name="Power">
        <Badge small label={rack.ready ? "Ready" : "NotReady"} $backgroundColor={rack.ready ? "success" : "critical"} $color="white" />
      </DrawerItem>
      <DrawerItem name="Conditions">
        {rack.pressure.length === 0 ? "No pressure" : rack.pressure.map((p) => <Badge key={p} small label={p} $backgroundColor="warning" $color="white" />)}
      </DrawerItem>
      <DrawerItem name="Schedulable">{rack.unschedulable ? "Cordoned" : "Yes"}</DrawerItem>
      <DrawerItem name="Kubelet">{rack.kubeletVersion}</DrawerItem>
    </>
  );
};

type Internet = ReturnType<ReturnType<ReturnType<typeof rackViewActionsInjectable.instantiate>>["internet"]>;

const InternetRows = ({ internet, onService }: { internet: Internet; onService: (key: string) => void }) => (
  <>
    <DrawerItem name="Inbound">↓ {formatRate(internet.rx)}</DrawerItem>
    <DrawerItem name="Outbound">↑ {formatRate(internet.tx)}</DrawerItem>
    <DrawerItem name="Measured at">the pods behind the Services below</DrawerItem>
    <DrawerItem name="Exposed">
      <Div $flex={{ direction: "vertical", gap: "xxs" }}>
        {internet.exposed.length === 0 ? "Nothing is reachable from outside" : internet.exposed.map((service) => (
          <Button
            key={service.key}
            $onClick={() => onService(service.key)}
            $flex={{ direction: "vertical" }}
            $color={{ normal: "textDefault", hover: "textHighlight" }}
            title={service.externalAddress ?? service.ingressHosts.join(", ")}
          >
            <Span $font={{ textOverflow: "ellipsis", noWrap: true }}>{service.namespace}/{service.name}</Span>
            <Span $color="textMuted" $font={{ size: "xs", textOverflow: "ellipsis", noWrap: true }}>
              {exposureLabel[service.exposure]}{service.externalAddress ? ` · ${service.externalAddress}` : service.ingressHosts.length ? ` · ${service.ingressHosts.join(", ")}` : ""}
            </Span>
          </Button>
        ))}
      </Div>
    </DrawerItem>
  </>
);

const Inspector = observer(({ clusterId }: { clusterId: string }) => {
  const state = useInject(rackViewStateInjectable)(clusterId);
  const actions = useInject(rackViewActionsInjectable)(clusterId);
  const feed = useInject(clusterFeedInjectable)(clusterId);
  const selected = state.selected.get();
  feed.model.get();

  if (!selected) return null;

  const blade = selected.type === "blade" ? actions.findBlade(selected.uid) : undefined;
  const rack = selected.type === "rack" ? actions.findRack(selected.name) : undefined;
  const service = selected.type === "service" ? actions.findService(selected.key) : undefined;
  const shelf = selected.type === "shelf" ? actions.shelfInfo(selected.rack, selected.shelf) : undefined;
  const part = selected.type === "part" ? selected.part : undefined;
  const partRack = selected.type === "part" ? actions.findRack(selected.rack) : undefined;
  const internet = selected.type === "internet" ? actions.internet() : undefined;
  feed.network.get();

  if (!blade && !rack && !service && !shelf && !partRack && !internet) return null;

  const title = blade?.name ?? rack?.name ?? service?.name ?? (shelf && `Shelf ${shelf.shelf + 1} · ${shelf.rack.shortName}`) ?? (part && partRack && `${partLabel[part]} · ${partRack.shortName}`) ?? (internet && "Internet");

  return (
    <div className={styles.inspector}>
      <Panel>
        <Div $flex={{ direction: "vertical", gap: "s" }}>
          <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
            {blade ? <PodsIcon $size="m" /> : service ? <NetworkIcon $size="m" /> : <NodesIcon $size="m" />}
            <Div $flex={{ direction: "vertical" }} $className={styles.grow} $overflow="hidden">
              <Span $color="textMuted" $font={{ size: "xs", uppercase: true }}>{blade ? "Pod" : service ? "Service" : shelf ? "Shelf" : part ? partLabel[part] : internet ? "Gateway" : "Node"}</Span>
              <Span $color="textHighlight" $font={{ size: "s", bold: true, textOverflow: "ellipsis", noWrap: true }} title={title}>
                {title}
              </Span>
            </Div>
            <IconAction $onClick={() => actions.select(undefined)} $tooltip="Close (Esc)">
              <CloseIcon />
            </IconAction>
          </Div>
          <Div $overflow={{ y: "auto" }} $flex={{ direction: "vertical" }}>
            {blade ? (
              <BladeRows blade={blade} traffic={actions.trafficOf(blade)} services={actions.servicesOf(blade.uid)} />
            ) : rack ? (
              <RackRows rack={rack} />
            ) : service ? (
              <ServiceRows service={service} traffic={actions.serviceTraffic(service)} />
            ) : shelf ? (
              <ShelfRows shelf={shelf} onPod={(uid) => actions.focus({ type: "blade", uid })} />
            ) : part && partRack ? (
              <PartRows part={part} rack={partRack} traffic={actions.nodeTraffic(partRack.name)} />
            ) : internet ? (
              <InternetRows internet={internet} onService={(key) => actions.focus({ type: "service", key })} />
            ) : null}
          </Div>
          <Div $flex={{ direction: "horizontal", gap: "s" }}>
            {!internet && <PrimaryButton onClick={() => void actions.openInLens(selected)}>
              <Span $flex={{ gap: "xs", verticalAlign: "center" }}><OpenInBrowserIcon $size="s" /> Open details</Span>
            </PrimaryButton>}
            <PlainButton onClick={() => actions.focus(selected)}>Fly to</PlainButton>
            {(shelf || partRack) && (
              <PlainButton onClick={() => actions.focus({ type: "rack", name: (shelf?.rack ?? partRack)!.name })}>Show rack</PlainButton>
            )}
            {blade?.nodeName && (
              <PlainButton onClick={() => actions.focus({ type: "rack", name: blade.nodeName })}>Show node</PlainButton>
            )}
          </Div>
        </Div>
      </Panel>
    </div>
  );
});

const eventColor: Record<SceneEvent["kind"], string> = {
  added: "var(--success)",
  removed: "var(--grey40)",
  failed: "var(--critical)",
  recovered: "var(--success)",
  restarted: "var(--warning)",
  "rack-added": "var(--primary)",
  "rack-removed": "var(--grey40)",
  "rack-down": "var(--critical)",
  "rack-up": "var(--success)",
};

const Activity = observer(({ clusterId }: { clusterId: string }) => {
  const state = useInject(rackViewStateInjectable)(clusterId);
  const actions = useInject(rackViewActionsInjectable)(clusterId);
  const events = state.events.get();

  if (!state.showEvents.get()) return null;

  return (
    <div className={styles.bottomRight}>
      <Panel>
        <Div $flex={{ direction: "vertical", gap: "xs" }}>
          <Div $flex={{ direction: "horizontal", horizontalAlign: "space-between", verticalAlign: "center" }}>
            <Span $color="textHighlight" $font={{ size: "xs", bold: true }}>Activity</Span>
            {events.length > 0 && (
              <Button $onClick={state.clearEvents} $color={{ normal: "textMuted", hover: "textHighlight" }} $font={{ size: "xs" }}>Clear</Button>
            )}
          </Div>
          {events.length === 0 ? (
            <Span $color="textMuted" $font={{ size: "xs" }}>Watching the cluster. Changes show up here as they happen.</Span>
          ) : (
            <Div $flex={{ direction: "vertical", gap: "xxs" }} $overflow={{ y: "auto" }} $className={styles.eventList}>
              {events.map((event) => (
                <Button
                  key={event.id}
                  $className={styles.event}
                  $flex={{ gap: "xs", verticalAlign: "center" }}
                  $font={{ size: "xs" }}
                  $color={{ normal: "textDefault", hover: "textHighlight" }}
                  $onClick={() => event.target && actions.focus(event.target)}
                  title={new Date(event.at).toLocaleTimeString()}
                >
                  <Dot color={eventColor[event.kind]} />
                  <Span $font={{ size: "xs", textOverflow: "ellipsis", noWrap: true }}>{event.text}</Span>
                </Button>
              ))}
            </Div>
          )}
        </Div>
      </Panel>
    </div>
  );
});

const HoverCard = observer(({ clusterId }: { clusterId: string }) => {
  const state = useInject(rackViewStateInjectable)(clusterId);
  const actions = useInject(rackViewActionsInjectable)(clusterId);
  const hover = state.hover.get();
  const selected = state.selected.get();

  if (!hover || (selected && sameTarget(hover.target, selected))) return null;

  const blade = hover.target.type === "blade" ? actions.findBlade(hover.target.uid) : undefined;
  const rack = hover.target.type === "rack" ? actions.findRack(hover.target.name) : undefined;
  const service = hover.target.type === "service" ? actions.findService(hover.target.key) : undefined;
  const shelf = hover.target.type === "shelf" ? actions.shelfInfo(hover.target.rack, hover.target.shelf) : undefined;
  const part = hover.target.type === "part" ? hover.target.part : undefined;
  const partRack = hover.target.type === "part" ? actions.findRack(hover.target.rack) : undefined;
  const internet = hover.target.type === "internet" ? actions.internet() : undefined;

  if (!blade && !rack && !service && !shelf && !partRack && !internet) return null;

  const serviceTraffic = service && actions.serviceTraffic(service);
  const bladeTraffic = blade && actions.trafficOf(blade);

  return (
    <div
      className={styles.tooltip}
      style={{
        left: hover.x,
        top: hover.y,
        transform: `translate(${hover.flipX ? "calc(-100% - 14px)" : "14px"}, ${hover.flipY ? "calc(-100% - 14px)" : "14px"})`,
      }}
    >
      <Div
        $className={styles.panel}
        $border={{ radius: "m" }}
        $boxShadow
        $padding={{ horizontal: "s", vertical: "xs" }}
      >
        {blade ? (
          <Div $flex={{ direction: "vertical", gap: "xxs" }}>
            <Span $flex={{ gap: "xs", verticalAlign: "center" }} $color="textHighlight" $font={{ size: "xs", bold: true }}>
              <Dot color={healthVar[blade.health]} /> {blade.name}
            </Span>
            <Span $color="textMuted" $font={{ size: "xs" }}>
              {blade.namespace} · {blade.reason && blade.health !== "running" ? blade.reason : blade.phase} · {blade.ready}/{blade.containers} ready{blade.restarts ? ` · ${blade.restarts} restarts` : ""}
            </Span>
            <Span $color="textMuted" $font={{ size: "xs" }}>
              CPU {blade.cpuUsageMilli !== undefined ? cores(blade.cpuUsageMilli) : "—"} / req {blade.cpuRequestMilli ? cores(blade.cpuRequestMilli) : "none"} · Mem {blade.memUsageBytes !== undefined ? bytes(blade.memUsageBytes) : "—"}
            </Span>
            {bladeTraffic && (
              <Span $color="textMuted" $font={{ size: "xs" }}>
                Net ↓ {formatRate(bladeTraffic.rxBytesPerSec)} · ↑ {formatRate(bladeTraffic.txBytesPerSec)}
              </Span>
            )}
          </Div>
        ) : internet ? (
          <Div $flex={{ direction: "vertical", gap: "xxs" }}>
            <Span $flex={{ gap: "xs", verticalAlign: "center" }} $color="textHighlight" $font={{ size: "xs", bold: true }}>
              <Dot color="var(--primary)" /> Internet
            </Span>
            <Span $color="textMuted" $font={{ size: "xs" }}>
              ↓ {formatRate(internet.rx)} · ↑ {formatRate(internet.tx)} · {internet.exposed.length} exposed service{internet.exposed.length === 1 ? "" : "s"}
            </Span>
          </Div>
        ) : part && partRack ? (
          <Div $flex={{ direction: "vertical", gap: "xxs" }}>
            <Span $flex={{ gap: "xs", verticalAlign: "center" }} $color="textHighlight" $font={{ size: "xs", bold: true }}>
              <Dot color={!partRack.ready ? "var(--critical)" : partRack.pressure.length ? "var(--warning)" : "var(--success)"} /> {partLabel[part]} · {partRack.shortName}
            </Span>
            <Span $color="textMuted" $font={{ size: "xs" }}>
              {part === "switch"
                ? (() => {
                    const t = actions.nodeTraffic(partRack.name);

                    return `Pod traffic ↓ ${formatRate(t.rx)} · ↑ ${formatRate(t.tx)}`;
                  })()
                : part === "ups"
                  ? `${partRack.ready ? "Ready" : "NotReady"} · ${partRack.pressure.length ? partRack.pressure.join(", ") : "no pressure"}`
                  : `${partRack.blades.filter((b) => b.health !== "succeeded").length}/${partRack.podCapacity} pods · ${partRack.kubeletVersion}`}
            </Span>
          </Div>
        ) : shelf ? (
          <Div $flex={{ direction: "vertical", gap: "xxs" }}>
            <Span $color="textHighlight" $font={{ size: "xs", bold: true }}>
              Shelf {shelf.shelf + 1} · {shelf.rack.shortName}
            </Span>
            <Span $color="textMuted" $font={{ size: "xs" }}>
              {shelf.blades.length} pods · {Math.max(0, shelf.open - shelf.blades.length)} open bays
            </Span>
            {shelf.namespaces.slice(0, 4).map(([namespace, count]) => (
              <Span key={namespace} $flex={{ gap: "xs", verticalAlign: "center" }} $color="textMuted" $font={{ size: "xs" }}>
                <span className={styles.swatch} style={{ background: namespaceCss(namespace) }} /> {namespace} · {count}
              </Span>
            ))}
          </Div>
        ) : service && serviceTraffic ? (
          <Div $flex={{ direction: "vertical", gap: "xxs" }}>
            <Span $flex={{ gap: "xs", verticalAlign: "center" }} $color="textHighlight" $font={{ size: "xs", bold: true }}>
              <Dot color={service.podUids.length === 0 && !service.headless ? "var(--warning)" : service.exposure === "internal" ? "var(--success)" : "var(--primary)"} /> {service.name}
            </Span>
            <Span $color="textMuted" $font={{ size: "xs" }}>
              {service.namespace} · {exposureLabel[service.exposure]} · {service.podUids.length} endpoint{service.podUids.length === 1 ? "" : "s"} · {service.ports}
            </Span>
            <Span $color="textMuted" $font={{ size: "xs" }}>
              ↓ {formatRate(serviceTraffic.rx)} · ↑ {formatRate(serviceTraffic.tx)}
            </Span>
          </Div>
        ) : rack ? (
          <Div $flex={{ direction: "vertical", gap: "xxs" }}>
            <Span $flex={{ gap: "xs", verticalAlign: "center" }} $color="textHighlight" $font={{ size: "xs", bold: true }}>
              <Dot color={!rack.ready ? "var(--critical)" : rack.unschedulable ? "var(--warning)" : "var(--success)"} /> {rack.name}
            </Span>
            <Span $color="textMuted" $font={{ size: "xs" }}>
              {rack.roles.join(", ") || "worker"} · {rack.blades.filter((b) => b.health !== "succeeded").length}/{rack.podCapacity} pods · {rack.kubeletVersion}
            </Span>
          </Div>
        ) : null}
      </Div>
    </div>
  );
});

const Status = observer(({ clusterId }: { clusterId: string }) => {
  const feed = useInject(clusterFeedInjectable)(clusterId);
  const status = feed.status.get();
  const model = feed.model.get();

  if (status === "error") {
    return (
      <div className={styles.center}>
        <Panel>
          <Div $flex={{ direction: "vertical", gap: "s" }} $className={styles.message}>
            <Span $color="critical" $font={{ size: "s", bold: true }}>Could not read the cluster</Span>
            <Span $color="textDefault" $font={{ size: "xs" }}>{feed.error.get()}</Span>
          </Div>
        </Panel>
      </div>
    );
  }

  if (model) {
    return model.racks.length === 0 ? (
      <div className={styles.center}>
        <Panel><Span $color="textMuted">This cluster has no nodes the connection can see.</Span></Panel>
      </div>
    ) : null;
  }

  return (
    <div className={styles.center}>
      <Panel>
        <Div $flex={{ gap: "s", verticalAlign: "center" }}>
          <Dot color="var(--primary)" live />
          <Span $color="textDefault">{status === "connecting" ? "Connecting to the cluster…" : "Racking up nodes and pods…"}</Span>
        </Div>
      </Panel>
    </div>
  );
});

const Hud = observer(({ clusterId }: { clusterId: string }) => {
  const feed = useInject(clusterFeedInjectable)(clusterId);
  const model = feed.model.get();

  return (
    <div className={styles.overlay}>
      {model && (
        <>
          <div className={styles.topLeft}><Summary clusterId={clusterId} model={model} /></div>
          <div className={styles.bottomLeft}><Legend clusterId={clusterId} model={model} /></div>
          <Inspector clusterId={clusterId} />
          <Activity clusterId={clusterId} />
          <HoverCard clusterId={clusterId} />
        </>
      )}
      <div className={styles.topRight}><Toolbar clusterId={clusterId} /></div>
      <Status clusterId={clusterId} />
    </div>
  );
});

export const RackView = ({ clusterId }: { clusterId: string }) => {
  const actions = useInject(rackViewActionsInjectable)(clusterId);
  const canvasHost = useRef<HTMLDivElement>(null);

  // The scene is imperative WebGL: React only hands it its element and its lifetime.
  useEffect(() => {
    if (!canvasHost.current) return undefined;

    return actions.mount(canvasHost.current);
  }, [actions]);

  return (
    <Div $className={styles.root} $backgroundColor="backgroundSecondary">
      <div ref={canvasHost} className={styles.canvas} />
      <Hud clusterId={clusterId} />
    </Div>
  );
};

export type { RackViewState };
