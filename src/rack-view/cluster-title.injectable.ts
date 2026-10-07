import { clusterNameReactiveInjectionToken } from "@k8slens/cluster-contracts";
import { getInjectable2 } from "@k8slens/injectable";
import { computed, observable, reaction, runInAction } from "mobx";

// What the user calls the cluster, following renames: for the tab title and the sign
// over the cluster's cage.
export const clusterTitleInjectable = getInjectable2({
  id: "lens-racks-cluster-title",
  consumptions: [clusterNameReactiveInjectionToken],

  instantiate: (di) => {
    const clusterNameFor = di.inject(clusterNameReactiveInjectionToken);

    return (clusterId: string) => {
      const name = observable.box<string | undefined>(undefined);

      void clusterNameFor(clusterId).then((reactive) => {
        // Follows renames for as long as the title exists.
        reaction(() => reactive.get(), (value) => runInAction(() => name.set(value)), { fireImmediately: true });
      });

      return computed(() => name.get());
    };
  },
});

