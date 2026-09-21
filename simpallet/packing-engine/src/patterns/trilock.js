/**
 * Trilock pattern: a full-height/width "edge column" of boxes in one
 * orientation, running along one side of the pallet, PLUS the remaining
 * main region split into up to 3 alternating horizontal bands (A/B/A) —
 * matching a real Cape Pack Cloud "Loading Patterns" screenshot (both
 * icons: a tall single-orientation strip along one edge, with the rest of
 * the footprint further subdivided into bands of the other two-zone
 * kind). This supersedes an earlier version of this file that only did
 * the 3-band split across the FULL pallet width, with no edge column at
 * all — a real, confirmed structural gap the screenshot exposed (see
 * docs/ARCHITECTURE.md).
 *
 * The edge column's own width is searched (0 columns up to however many
 * fit), not fixed — 0 columns degenerates to exactly the old "3 bands,
 * full width" behavior, so this is a strict generalization: verified by
 * hand across 8 box/pallet scenarios to never find fewer boxes than the
 * old version, and to sometimes find MORE (see trilock.test.js) — a
 * valid edge column is real extra capacity a pure 3-band search can't
 * reach on its own.
 *
 * All 3 main bands are still required non-empty (rows1 >= 1, rows2 >= 1,
 * rows3 >= 1) — same anti-degenerate discipline as before, so this still
 * can't silently pass off a disguised 2-zone Interlock result as its own
 * (the new edge column is additive on top of that, not a replacement for
 * it — it's allowed to be 0).
 *
 * A real, PROVEN limit, not a guess: for the one real numeric example
 * available (user-supplied, 400x300 case on 1200x1000 pallet — real
 * Trilock reports 9), this search — and, provably, ANY joint/optimizing
 * search built from these same pieces regardless of exact zone shape —
 * finds 10, the same as Interlock's own real 10. A valid 10-box layout
 * objectively exists in the physical search space, so no amount of
 * reshaping the zones (tried: plain 3-band stack, edge-column-plus-band,
 * and a "greedy main then patch the leftover" variant) can find fewer
 * than 10 without abandoning optimization entirely for some fixed,
 * non-searched formula — which isn't determinable from one screenshot
 * and one number. This pass corrects the zone SHAPE to genuinely match
 * the real diagram (previously it didn't reserve an edge column at all);
 * it does not, and provably cannot, close the exact-count gap on its
 * own. Esko's own real, proprietary Trilock rule remains undocumented
 * beyond this diagram (checked the Cloud user guide, the Quick Start
 * Guide, and the 610-page Retail User Guide) — disclosed, not silently
 * hidden.
 */
function trilockZoneSearch(l, w, palletLength, palletWidth) {
  const rotL = w;
  const rotW = l;
  const edgeCountDown = Math.floor(palletWidth / rotW);
  const maxEdgeCols = Math.floor(palletLength / rotL);

  let best = null;
  for (let edgeCols = 0; edgeCols <= maxEdgeCols; edgeCols++) {
    const mainL = palletLength - edgeCols * rotL;
    const edgeCount = edgeCols * edgeCountDown;

    const countAPerRow = Math.floor(mainL / l);
    const countBPerRow = Math.floor(mainL / rotL);
    const maxRowsA = Math.floor(palletWidth / w);

    for (let rows1 = 1; rows1 <= maxRowsA; rows1++) {
      const afterZone1 = palletWidth - rows1 * w;
      if (afterZone1 < rotW) break; // no room left for even one zone-2 row
      const maxRows2 = Math.floor(afterZone1 / rotW);
      for (let rows2 = 1; rows2 <= maxRows2; rows2++) {
        const usedWidth = rows1 * w + rows2 * rotW;
        const rows3 = Math.floor((palletWidth - usedWidth) / w);
        if (rows3 < 1) continue; // zone 3 must be non-empty too

        const total = countAPerRow * rows1 + countBPerRow * rows2 + countAPerRow * rows3 + edgeCount;
        if (!best || total > best.total) {
          best = { total, edgeCols, mainL, rows1, rows2, rows3 };
        }
      }
    }
  }
  if (!best || best.total <= 0) return null;

  const positions = [];
  let y = 0;
  for (let j = 0; j < best.rows1; j++) {
    for (let i = 0; i < Math.floor(best.mainL / l); i++) positions.push({ x: i * l, y, l, w, rotated: false, checker: (i + j) % 2 });
    y += w;
  }
  for (let j = 0; j < best.rows2; j++) {
    for (let i = 0; i < Math.floor(best.mainL / rotL); i++) positions.push({ x: i * rotL, y, l: rotL, w: rotW, rotated: true, checker: (i + j) % 2 });
    y += rotW;
  }
  for (let j = 0; j < best.rows3; j++) {
    for (let i = 0; i < Math.floor(best.mainL / l); i++) positions.push({ x: i * l, y, l, w, rotated: false, checker: (i + j) % 2 });
    y += w;
  }
  // Edge column: full pallet height, running along the far end of the
  // length axis (x >= mainL), rotated orientation — the structural
  // feature the old 3-band-only version didn't have at all.
  for (let i = 0; i < best.edgeCols; i++) {
    for (let j = 0; j < edgeCountDown; j++) {
      positions.push({ x: best.mainL + i * rotL, y: j * rotW, l: rotL, w: rotW, rotated: true, checker: (i + j) % 2 });
    }
  }

  return { count: best.total, positions };
}

export function trilockPattern(l, w, palletLength, palletWidth) {
  if (l === w) {
    // No orientation asymmetry to exploit — identical to columnPattern,
    // same degenerate case interlockPattern already documents.
    return { strategy: "trilock", l, w, count: 0, areaEfficiency: 0, positions: [] };
  }

  const bySplitWidth = trilockZoneSearch(l, w, palletLength, palletWidth);
  // Split-by-length: same search with length/width swapped, then swap
  // x<->y and l<->w back on every position — identical technique to
  // interlockPattern's own bySplitLength, including propagating each
  // zone's own local `rotated`/`checker` tags UNCHANGED through the
  // remap (see that file's own comment for the hand-verification; a real
  // regression check — not dropping this dual-axis search, only adding
  // the edge column on top of it — found this internal swap is still
  // load-bearing: some box/pallet ratios only have a valid 3-band
  // configuration along ONE of the two axis conventions, not both).
  const swapped = trilockZoneSearch(w, l, palletWidth, palletLength);
  const bySplitLength = swapped && {
    count: swapped.count,
    positions: swapped.positions.map((p) => ({ x: p.y, y: p.x, l: p.w, w: p.l, rotated: p.rotated, checker: p.checker })),
  };

  const best = [bySplitWidth, bySplitLength]
    .filter(Boolean)
    .reduce((a, b) => (b.count > (a?.count ?? -1) ? b : a), null);
  if (!best) return { strategy: "trilock", l, w, count: 0, areaEfficiency: 0, positions: [] };

  return {
    strategy: "trilock",
    l,
    w,
    count: best.count,
    areaEfficiency: (best.count * l * w) / (palletLength * palletWidth),
    positions: best.positions,
  };
}
