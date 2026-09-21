import { optimizePallet } from "./optimize.js";

/**
 * Truck/Container Loading — CapePack's "Generating a Truck Analysis" (docs
 * section 8.2), part of Report Builder: how many of the CURRENT pallet loads
 * fit into a truck or container.
 *
 * This is Level 3 of the decomposition in docs/PACKING_ALGORITHM.md: no new
 * math needed — a pallet load becomes the "box" and the truck/container
 * interior becomes the "pallet," so it's literally optimizePallet called one
 * level up. Kept as a named wrapper (rather than calling optimizePallet
 * directly from the UI) for a stable, documented API surface and because
 * pallets loaded into a truck are conventionally never tipped onto a side —
 * allowedVertical defaults to ['height'] unless the caller overrides it.
 *
 * palletLoad: { length, width, height, weight, allowedVertical? } — a
 *   computed solution's footprint/loadHeight/totalWeight, reshaped as a box.
 * truck:      same shape as optimizePallet's pallet argument (deckHeight is
 *   usually 0/omitted for a truck bed, unlike a wooden pallet's deck).
 * options:    same as optimizePallet's options.
 */
export function packPalletsIntoTruck(palletLoad, truck, options = {}) {
  const box = { allowedVertical: ["height"], ...palletLoad };
  return optimizePallet(box, truck, options);
}
