import { columnPattern } from "./patterns/index.js";

/**
 * "Load Multi-Sized Products" workflow — CapePack's own "Palletize Multiple
 * size packages". Several different PRODUCT sizes share one pallet load.
 *
 * Real Cape Pack Cloud screenshots (user-supplied: 3 real products, real
 * pallet, real result) showed this is NOT a side-by-side footprint split
 * (an earlier version of this file did that, and was wrong) — the real 3D
 * result clearly shows horizontal STACKING BANDS: each product occupies
 * full layers, stacked on top of each other using the FULL pallet
 * footprint, not a narrower zone. Rebuilt around that.
 *
 * What's independently, exactly verified from the real numbers (see
 * docs/ARCHITECTURE.md for the full derivation): solving the real
 * weight+count equations pins one product's own count to exactly 2 full
 * layers of its OWN best `columnPattern` density at its DECLARED Height —
 * not a better density some other pattern type or orientation could reach.
 * Matches "Algorithm Type: Column Algorithm" shown selected in the real
 * UI — so this uses `columnPattern` only (rotatable within the horizontal
 * plane, i.e. length/width may swap, but the declared Height always stays
 * the vertical axis — no orientation search standing the box on a
 * different face; a documented, disclosed scope decision).
 *
 * A real, PROVEN limit, not a guess: the most principled model built
 * during design (round-robin layer allocation — the same pattern this
 * engine already uses elsewhere for shared weight/height budgets) finds a
 * strictly BETTER result (more units, less height, less weight used) than
 * the one real example's own reported result, and a fully unconstrained
 * search finds an even better one still. The real result isn't the
 * optimum under any model tried — disclosed, not force-fit.
 *
 * products: [{ name, length, width, height, weight, absoluteMax?,
 *   desiredMin? }]
 *   absoluteMax: this product's own total unit cap across the whole load
 *   (round-robin stops adding full layers once one more would exceed it,
 *   then tops off with a single partial layer to get as close as possible
 *   without exceeding it — real use of the named field). Omitted = no cap.
 *   desiredMin: captured for round-trip only — no verified evidence for
 *   what it should guarantee when the shared budget can't fit it; NOT
 *   enforced by the search, same "captured but not computed" discipline
 *   as Resize's own "Vary Volume by" and Folded Carton's own "Folded
 *   Carton per Case" fields.
 * pallet: { length, width, maxHeight, maxWeight, deckHeight? }
 */
export function loadMultiSizedProducts(products, pallet) {
  if (!products || products.length === 0) return null;
  const deckHeight = pallet.deckHeight ?? 0;
  const maxProductHeight = pallet.maxHeight - deckHeight;

  const zones = products.map((product) => {
    const zone = { product, absoluteMax: product.absoluteMax ?? Infinity };
    const a = columnPattern(product.length, product.width, pallet.length, pallet.width);
    const b = columnPattern(product.width, product.length, pallet.length, pallet.width);
    const best = b.count > a.count ? b : a;
    if (best.count <= 0 || product.height > maxProductHeight) {
      zone.infeasible = true;
      return zone;
    }
    zone.boxFootprint = { l: best.l, w: best.w, h: product.height };
    zone.perLayer = best.count;
    zone.positions = best.positions;
    zone.weightPerLayer = zone.perLayer * product.weight;
    zone.layers = 0;
    zone.units = 0;
    zone.partialUnitsInLastLayer = 0;
    return zone;
  });

  const feasibleZones = zones.filter((z) => !z.infeasible);

  // Round-robin, full layers only: add one layer to each zone in turn so
  // the shared height/weight budget is respected exactly and no single
  // product monopolizes it — mirrors this engine's own existing
  // round-robin convention (see the pre-rebuild version of this file, and
  // optimizeKdfBundleCount's own comment on the same technique), just
  // stacking in Z across the full footprint now instead of splitting X.
  let totalHeight = 0;
  let totalWeight = 0;
  let addedAny = true;
  while (addedAny) {
    addedAny = false;
    for (const zone of feasibleZones) {
      if (zone.units + zone.perLayer > zone.absoluteMax) continue; // one more full layer would exceed this product's own cap
      if (totalHeight + zone.boxFootprint.h > maxProductHeight) continue;
      if (totalWeight + zone.weightPerLayer > pallet.maxWeight) continue;
      zone.layers += 1;
      zone.units += zone.perLayer;
      totalHeight += zone.boxFootprint.h;
      totalWeight += zone.weightPerLayer;
      addedAny = true;
    }
  }

  // Top off with ONE partial final layer for any zone that stopped because
  // of its own absoluteMax specifically (not height/weight) — gets as
  // close to the real named cap as the shared height/weight budget still
  // allows, without exceeding it. A partial layer still costs its box's
  // own FULL height, same as buildBoxLayout's own "Allow Partial Top
  // Layer" convention elsewhere in this engine.
  for (const zone of feasibleZones) {
    const remaining = zone.absoluteMax - zone.units;
    if (remaining <= 0 || remaining >= zone.perLayer) continue;
    if (totalHeight + zone.boxFootprint.h > maxProductHeight) continue;
    if (totalWeight + remaining * zone.product.weight > pallet.maxWeight) continue;
    zone.layers += 1;
    zone.units += remaining;
    zone.partialUnitsInLastLayer = remaining;
    totalHeight += zone.boxFootprint.h;
    totalWeight += remaining * zone.product.weight;
  }

  const loadHeight = deckHeight + totalHeight;

  return {
    zones: zones.map((z) => ({
      name: z.product.name,
      infeasible: !!z.infeasible,
      boxFootprint: z.boxFootprint ?? null,
      perLayer: z.perLayer ?? 0,
      layers: z.layers ?? 0,
      partialUnitsInLastLayer: z.partialUnitsInLastLayer ?? 0,
      totalCount: z.units ?? 0,
      totalWeight: (z.units ?? 0) * z.product.weight,
      positions: z.positions ?? [],
    })),
    loadHeight,
    totalCount: feasibleZones.reduce((sum, z) => sum + z.units, 0),
    totalWeight,
  };
}

/**
 * Expands a loadMultiSizedProducts() result into explicit 3D boxes (one per
 * physical box, world-space x/y/z origin, tagged with which product it is)
 * for rendering — the multi-size equivalent of buildBoxLayout(). Each
 * zone now stacks starting at whatever Z the PREVIOUS zone's own layers
 * ended at (a running Z-cursor across zones), not all starting at
 * deckHeight — that assumption was correct for the old side-by-side
 * zones, wrong for stacked ones. Zone order follows the product list's
 * own order (first product's layers at the bottom) — no evidence for any
 * other real ordering rule, a disclosed judgment call.
 */
export function buildMultiSizeBoxLayout(result, pallet) {
  const deckHeight = pallet.deckHeight ?? 0;
  const boxes = [];
  let zCursor = deckHeight;
  for (const zone of result.zones) {
    if (zone.layers <= 0) continue;
    const fullLayers = zone.partialUnitsInLastLayer > 0 ? zone.layers - 1 : zone.layers;
    for (let k = 0; k < fullLayers; k++) {
      const z = zCursor + k * zone.boxFootprint.h;
      for (const pos of zone.positions) {
        boxes.push({ x: pos.x, y: pos.y, z, l: pos.l, w: pos.w, h: zone.boxFootprint.h, product: zone.name });
      }
    }
    if (zone.partialUnitsInLastLayer > 0) {
      const z = zCursor + fullLayers * zone.boxFootprint.h;
      for (const pos of zone.positions.slice(0, zone.partialUnitsInLastLayer)) {
        boxes.push({ x: pos.x, y: pos.y, z, l: pos.l, w: pos.w, h: zone.boxFootprint.h, product: zone.name });
      }
    }
    zCursor += zone.layers * zone.boxFootprint.h;
  }
  return boxes;
}
