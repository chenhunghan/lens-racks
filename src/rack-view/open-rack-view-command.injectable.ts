import { getCommandInjectableBunch } from "@k8slens/command-palette-contracts";
import { activeTabClusterIdInjectionToken, activeTabClusterIdReactiveInjectionToken } from "@k8slens/main-view-contracts";
import { computed } from "mobx";
import { openRackViewInjectable } from "./rack-view-tab.injectable";

export default getCommandInjectableBunch({
  id: "lens-racks.open-rack-view",
  title: "Rack View: Open for this cluster",

  isActive: {
    consumptions: [activeTabClusterIdReactiveInjectionToken],
    instantiate: (di) => {
      const activeClusterId = di.inject(activeTabClusterIdReactiveInjectionToken)();

      return () => computed(() => Boolean(activeClusterId.get()));
    },
  },

  action: {
    consumptions: [activeTabClusterIdInjectionToken],
    instantiate: (di) => {
      const activeTabClusterId = di.inject(activeTabClusterIdInjectionToken)();
      const openRackView = di.inject(openRackViewInjectable)();

      return () => async () => {
        const clusterId = await activeTabClusterId();

        if (clusterId) await openRackView(clusterId);
      };
    },
  },
});
