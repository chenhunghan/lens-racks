import { clusterNavigatorItemKind } from "@k8slens/cluster-contracts";
import { NodesIcon } from "@k8slens/icon";
import { NavigatorItemIcon, NavigatorItemLabel, NavigatorLeafIndicator } from "@k8slens/navigator-components";
import { getNavigatorItemKind, getNavigatorItemKindInjectableBunch2, type NavigatorItemProps } from "@k8slens/navigator-contracts";
import { computed } from "mobx";
import { openRackViewInjectable } from "./rack-view-tab.injectable";

interface RackViewItem {
  readonly id: string;
  readonly name: string;
  readonly orderNumber: number;
}

export const rackViewNavigatorItemKind = getNavigatorItemKind<RackViewItem, [clusterId: string]>()("rack-view");

const RackViewRow = ({ item }: NavigatorItemProps<RackViewItem, typeof clusterNavigatorItemKind>) => (
  <>
    <NavigatorLeafIndicator />
    <NavigatorItemIcon><NodesIcon /></NavigatorItemIcon>
    <NavigatorItemLabel>{item.name}</NavigatorItemLabel>
  </>
);

export default getNavigatorItemKindInjectableBunch2({
  kind: rackViewNavigatorItemKind,
  parentKind: clusterNavigatorItemKind,
  description: "Opens the cluster as a live 3D datacenter: nodes as racks, pods as blades.",

  items: {
    instantiate: () => async () => computed((): RackViewItem[] => [{ id: "rack-view", name: "Rack View", orderNumber: 5 }]),
  },

  activate: {
    instantiate: (di) => {
      const openRackView = di.inject(openRackViewInjectable)();

      return (clusterId) => openRackView(clusterId);
    },
  },

  Component: RackViewRow,
});
