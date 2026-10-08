# Changelog

What changed in each version of this extension, newest first.

## 0.1.3

- Thermal view: no more black box over the scene on some graphics cards. A blade's heat could compute to an invalid number there, and the glow spread it over a large part of the view.
- Thermal view: searching or highlighting a namespace while it is on no longer stops the racks' beacons from updating.

## 0.1.2

- The README opens with a short recording of Rack View at work.

## 0.1.1

- "Report a problem" now opens the GitHub issues of the extension.
- The extension's page links to its source on GitHub, so the README's pictures show there too.

## 0.1.0

- Rack View: any cluster as a live 3D datacenter, nodes as racks and pods as blades, opened from the navigator under each cluster or from the command palette.
- Live: pods slide in and out and their lights change as the cluster does, nodes join and leave the row, and an Activity feed lists the changes.
- Live CPU and memory from metrics-server when the cluster has it, resource requests otherwise.
- Shelves with the node's capacity shown as open bays, pods grouped by namespace or spread evenly.
- Racks slide out, shelves open as drawers, blades draw out or lift up with a tag naming their pod; switch, node controller and UPS selectable on their own.
- Network as fibre: a patch-panel port per Service, an edge router for Services reachable from outside, fibres to every backing pod with pulses at the measured traffic rate, node trunks, an internet gateway with live in and out traffic, and service-to-service calls where Istio or Linkerd metrics are available.
- Thermal view in the manner of a thermal camera.
- A datacenter hall without end around the cluster, with depth of field and a polished floor.
- Pod search, namespace highlighting, an inspector with a link to Lens's details panel, and fly-to navigation.
- Follows the Lens theme, light or dark, and adjusts rendering quality to keep the view smooth.
