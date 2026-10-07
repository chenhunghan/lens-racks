import { Div, Span } from "@k8slens/element-components";
import { NodesIcon } from "@k8slens/icon";
import { getInjectable2 } from "@k8slens/injectable";
import { mainViewTabHostKind } from "@k8slens/main-view-contracts";
import {
  focusTabInjectionToken,
  getTabKind,
  getTabKindInjectableBunch,
  openTabInjectionToken,
  tabIsOpenInjectionToken,
  type TabProps,
} from "@k8slens/tab-contracts";
import { useInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import { clusterTitleInjectable } from "./cluster-title.injectable";
import { RackView } from "./rack-view";

// One tab per cluster, opened by the cluster's id.
export const rackViewTabKind = getTabKind()("rack-view");

const RackViewTitle = observer(({ tabId }: TabProps<typeof mainViewTabHostKind>) => {
  const title = useInject(clusterTitleInjectable)(tabId);

  return (
    <Div $flex={{ gap: "xs", verticalAlign: "center" }}>
      <NodesIcon $size="s" />
      <Span>Racks: {title.get() ?? "…"}</Span>
    </Div>
  );
});

const RackViewTab = ({ tabId }: TabProps<typeof mainViewTabHostKind>) => <RackView clusterId={tabId} />;

export default getTabKindInjectableBunch({
  tabHostKind: mainViewTabHostKind,
  kind: rackViewTabKind,
  Component: RackViewTab,
  Title: RackViewTitle,
});

export const openRackViewInjectable = getInjectable2({
  id: "lens-racks-open-rack-view",
  consumptions: [openTabInjectionToken, focusTabInjectionToken, tabIsOpenInjectionToken],

  instantiate: (di) => {
    const openTab = di.inject(openTabInjectionToken.for(mainViewTabHostKind).for(rackViewTabKind).for(di.scopeIds))();
    const focusTab = di.inject(focusTabInjectionToken.for(mainViewTabHostKind).for(rackViewTabKind).for(di.scopeIds))();
    const isOpen = di.inject(tabIsOpenInjectionToken.for(mainViewTabHostKind).for(rackViewTabKind).for(di.scopeIds))();

    return () => async (clusterId: string) => {
      if (await isOpen({ tabId: clusterId })) await focusTab({ tabId: clusterId });
      else await openTab({ tabId: clusterId });
    };
  },
});
