/**
 * Format Load Additions (docs section 8.1): physical elements added to a
 * computed load — pallet base caps, layer pads/trays, top boards/caps,
 * picture frames, corner posts, straps, shrouds, stretch wrap. Not every
 * addition type from the docs is modeled — only the ones with a real,
 * confirmed physical effect (several reverse-engineered from real
 * user-supplied before/after Format Load exports, see docs/
 * ARCHITECTURE.md):
 *
 *   - "once":        adds thickness+weight a single time (top board, top
 *                     cap, pallet base cap — sits once at the top or bottom
 *                     of the whole load)
 *   - "perLayerGap":  adds thickness+weight once for each gap BETWEEN
 *                     layers, i.e. (layers - 1) times (layer pads/trays —
 *                     sit between adjacent layers, not under the bottom or
 *                     over the top one)
 *   - "weightOnly":   adds weight × count, no thickness (straps, vertical
 *                     corner posts, stretch wrap — count defaults to 1;
 *                     straps' real "Num. of Straps" and corner posts' real
 *                     per-position checkboxes both confirmed exact
 *                     weight-scales-by-count linearly, e.g. 8 real corner
 *                     posts × 1.13kg = 9.04kg exactly)
 *   - "cornerPost":   weight × count (as weightOnly) PLUS a height
 *                     contribution that's always exactly 2× thickness,
 *                     regardless of count — confirmed identically across 2
 *                     real examples (3 posts checked, thickness 1.0 →
 *                     +2.0mm; 8 posts checked, thickness 6.4 → +12.8mm).
 *                     The real ×2 mechanism isn't understood (why always
 *                     2, not e.g. ×(top positions checked)) — reproduced
 *                     as confirmed numbers, not explained. A real "width"
 *                     field ALSO adds once (not ×2) to BOTH Length and
 *                     Width, but only when count > 0 — confirmed by one
 *                     real example (5 posts checked, Width 20.0000mm →
 *                     Length/Width both +20.00mm exactly).
 *   - "wrap":         wraps the load on all sides (shroud) — Length/Width
 *                     each grow by 2×thickness (both sides), Height by
 *                     1×thickness (over the top only — the load already
 *                     sits on the pallet/deck beneath it), Weight adds
 *                     flat once. Confirmed exactly against a real before/
 *                     after (Thickness 4.2mm → Length/Width +8.40mm each,
 *                     Height +4.20mm, Weight the flat field value).
 *   - "verticalCornerPost": weight × count (a fixed 4 — one per pallet
 *                     corner; unlike Horizontal Corner Posts, there's no
 *                     real per-corner checkbox UI to select fewer). Length
 *                     AND Width each grow by 2×thickness — the SAME
 *                     Shroud-style "both sides" convention, but on
 *                     Thickness here, not the post's own Width field (that
 *                     one has no confirmed effect for this type). NO
 *                     height effect at all — confirmed by a real before/
 *                     after where Height was unchanged (1550→1550mm)
 *                     despite Position="Top". Confirmed exactly against
 *                     one real example (Weight 1.13/Thickness 6.4 →
 *                     Length/Width +12.80mm each = 2×6.4, Weight +4.52kg =
 *                     4×1.13).
 *
 * Deliberately not modeled: corner post/strap *positioning* (CapePack's
 * own Across Length/Width fields, or which of the 8 real corner-post
 * positions are checked) — only the aggregate effect their count already
 * captures. Picture Frame uses the plain "once" type (a second, cleaner
 * real example resolved an earlier ambiguous one — see ARCHITECTURE.md).
 */
export function applyFormatLoadAdditions(solution, additions = []) {
  let addedHeight = 0;
  let addedWeight = 0;
  let addedLength = 0;
  let addedWidth = 0;
  const layerGaps = Math.max(solution.layers - 1, 0);

  for (const a of additions) {
    const count = a.count ?? 1;
    if (a.type === "perLayerGap") {
      // One physical pad per gap — both its height AND weight scale by
      // how many gaps actually exist (zero on a single-layer load).
      addedHeight += (a.thickness ?? 0) * layerGaps;
      addedWeight += (a.weight ?? 0) * layerGaps;
    } else if (a.type === "wrap") {
      addedLength += 2 * (a.thickness ?? 0);
      addedWidth += 2 * (a.thickness ?? 0);
      addedHeight += a.thickness ?? 0;
      addedWeight += a.weight ?? 0;
    } else if (a.type === "cornerPost") {
      addedWeight += (a.weight ?? 0) * count;
      addedHeight += 2 * (a.thickness ?? 0);
      // Real before/after (5 checked positions, Width 20.0000mm): Length
      // AND Width both grew by exactly 20.00mm — 1× the post's own real
      // Width field, on both footprint axes, only when at least one
      // position is actually checked (unlike height above, which adds
      // unconditionally on thickness alone — a real, unexplained
      // asymmetry between the two, reproduced as confirmed numbers, not
      // resolved). Only one real example exists for this footprint
      // effect specifically (height/weight each have two).
      if (count > 0 && a.width) {
        addedLength += a.width;
        addedWidth += a.width;
      }
    } else if (a.type === "verticalCornerPost") {
      addedWeight += (a.weight ?? 0) * count;
      addedLength += 2 * (a.thickness ?? 0);
      addedWidth += 2 * (a.thickness ?? 0);
      // No addedHeight — confirmed zero real height effect, unlike the
      // horizontal variant's own unconditional 2×thickness.
    } else {
      addedWeight += (a.weight ?? 0) * count;
      if (a.type === "once") addedHeight += a.thickness ?? 0;
    }
  }

  return {
    loadHeight: solution.loadHeight + addedHeight,
    totalWeight: solution.totalWeight + addedWeight,
    addedHeight,
    addedWeight,
    addedLength,
    addedWidth,
  };
}
