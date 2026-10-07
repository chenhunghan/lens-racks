// Where a pod's blade goes in its rack. A rack has a fixed number of shelves (blade
// enclosures) of equal width; the node's pod capacity is spread across them as "open
// bays", centred on each shelf, and the bays beyond capacity are closed with blanking
// plates. Placement only decides where *new* blades go: blades already in place never
// move on their own, so a live update cannot reshuffle the rack. Re-packing is explicit.

import type { ShelfMode } from "./scene-types";

export type { ShelfMode };

export interface ShelfLayout {
  readonly shelves: number;
  readonly perShelf: number;
  readonly usable: readonly boolean[]; // per slot: an open bay within the node's capacity
}

export const shelfLayout = (shelves: number, perShelf: number, capacity: number): ShelfLayout => {
  const usable: boolean[] = new Array(shelves * perShelf).fill(false);
  const base = Math.floor(capacity / shelves);
  const extra = capacity % shelves;

  for (let shelf = 0; shelf < shelves; shelf++) {
    const open = Math.min(perShelf, base + (shelf < extra ? 1 : 0));
    const start = Math.floor((perShelf - open) / 2);

    for (let i = 0; i < open; i++) usable[shelf * perShelf + start + i] = true;
  }

  return { shelves, perShelf, usable };
};

const shelfOf = (layout: ShelfLayout, slot: number) => Math.floor(slot / layout.perShelf);

const slotsOf = (layout: ShelfLayout, shelf: number) => Array.from({ length: layout.perShelf }, (_, i) => shelf * layout.perShelf + i);

const freeOpenSlot = (layout: ShelfLayout, slots: ReadonlyArray<string | undefined>, shelf: number) =>
  slotsOf(layout, shelf).find((slot) => layout.usable[slot] && !slots[slot]);

const openCount = (layout: ShelfLayout, shelf: number) => slotsOf(layout, shelf).filter((slot) => layout.usable[slot]).length;

const usedCount = (slots: ReadonlyArray<string | undefined>, layout: ShelfLayout, shelf: number) => slotsOf(layout, shelf).filter((slot) => slots[slot]).length;

// The slot for a new blade, or −1 when the rack is full.
export const pickSlot = (
  layout: ShelfLayout,
  slots: ReadonlyArray<string | undefined>,
  namespace: string,
  namespaceOf: (uid: string) => string | undefined,
  mode: ShelfMode,
): number => {
  const shelves = Array.from({ length: layout.shelves }, (_, shelf) => shelf);
  const withRoom = shelves.filter((shelf) => freeOpenSlot(layout, slots, shelf) !== undefined);

  if (withRoom.length > 0) {
    let shelf: number | undefined;

    if (mode === "namespace") {
      const holds = (s: number) => slotsOf(layout, s).some((slot) => slots[slot] && namespaceOf(slots[slot]!) === namespace);
      // Its namespace's shelf, then an empty shelf of its own, then the roomiest one.
      shelf = withRoom.find(holds)
        ?? withRoom.find((s) => usedCount(slots, layout, s) === 0)
        ?? [...withRoom].sort((a, b) => openCount(layout, b) - usedCount(slots, layout, b) - (openCount(layout, a) - usedCount(slots, layout, a)) || a - b)[0];
    } else {
      // The emptiest shelf, top first: an even spread down the rack.
      shelf = [...withRoom].sort((a, b) => usedCount(slots, layout, a) / Math.max(1, openCount(layout, a)) - usedCount(slots, layout, b) / Math.max(1, openCount(layout, b)) || a - b)[0];
    }

    if (shelf !== undefined) return freeOpenSlot(layout, slots, shelf)!;
  }

  // Beyond the node's capacity (it can happen for a moment): any free slot at all.
  return slots.findIndex((uid) => !uid);
};

// A fresh arrangement of every blade, for when the mode changes.
export const planShelves = (layout: ShelfLayout, blades: ReadonlyArray<{ uid: string; namespace: string; name: string }>, mode: ShelfMode) => {
  const slots: Array<string | undefined> = new Array(layout.shelves * layout.perShelf).fill(undefined);
  const namespaces = new Map(blades.map((blade) => [blade.uid, blade.namespace]));
  const sizes = new Map<string, number>();

  for (const blade of blades) sizes.set(blade.namespace, (sizes.get(blade.namespace) ?? 0) + 1);

  // Large namespaces first, so they get whole shelves; small ones share what is left.
  const ordered = [...blades].sort((a, b) =>
    mode === "namespace"
      ? (sizes.get(b.namespace)! - sizes.get(a.namespace)!) || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name)
      : a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name),
  );
  const placed = new Map<string, number>();

  for (const blade of ordered) {
    const slot = pickSlot(layout, slots, blade.namespace, (uid) => namespaces.get(uid), mode);
    if (slot < 0) continue;
    slots[slot] = blade.uid;
    placed.set(blade.uid, slot);
  }

  return placed;
};

// What a shelf's label says: the namespaces on it, largest first.
export const shelfNamespaces = (layout: ShelfLayout, slots: ReadonlyArray<string | undefined>, shelf: number, namespaceOf: (uid: string) => string | undefined) => {
  const counts = new Map<string, number>();

  for (const slot of slotsOf(layout, shelf)) {
    const uid = slots[slot];
    const namespace = uid && namespaceOf(uid);
    if (namespace) counts.set(namespace, (counts.get(namespace) ?? 0) + 1);
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

export const shelfOfSlot = shelfOf;
