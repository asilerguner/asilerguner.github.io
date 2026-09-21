import { optimizePallet } from "./optimize.js";

/**
 * Filling the Master Pallet Base (docs section 8.4): arrange multiple
 * copies of the CURRENT pallet load onto a larger "master" pallet base.
 * Identical decomposition to Truck Analysis (packPalletsIntoTruck) — the
 * current pallet load becomes the "box," the master pallet base becomes
 * the "pallet." Kept as its own named function (rather than calling
 * optimizePallet directly from the UI) because CapePack treats it as a
 * distinct Report Builder action with its own overhang/underhang/max-weight
 * inputs, even though the underlying math is the same Level 1/2 search one
 * level up.
 *
 * palletLoad: { length, width, height, weight, allowedVertical? }
 * masterBase: same shape as optimizePallet's pallet argument
 * options:    same as optimizePallet's options
 */
export function packPalletsOntoMasterBase(palletLoad, masterBase, options = {}) {
  const box = { allowedVertical: ["height"], ...palletLoad };
  return optimizePallet(box, masterBase, options);
}
