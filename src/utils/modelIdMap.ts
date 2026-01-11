// src/utils/modelIdMap.ts
// utils for working with ModelIdMap structures

import type * as OBC from "@thatopen/components";

/**
 * Why keep these in utils?
 * - They are generic and used by multiple modules (tree, navigation, snapshots).
 * - Avoids copy/paste and keeps viewer/ui files readable.
 */

export function countItems(map: OBC.ModelIdMap): number {
  let total = 0;
  for (const ids of Object.values(map)) total += ids.size;
  return total;
}

export function flattenLocalIds(map: OBC.ModelIdMap, modelId: string): number[] {
  const set = map[modelId];
  return set ? Array.from(set) : [];
}

export function intersect(a: OBC.ModelIdMap, b: OBC.ModelIdMap): OBC.ModelIdMap {
  const out: OBC.ModelIdMap = {};
  for (const modelID of Object.keys(a)) {
    const setA = a[modelID];
    const setB = b[modelID];
    if (!setA || !setB) continue;

    const inter = new Set<number>();
    for (const id of setA) if (setB.has(id)) inter.add(id);

    if (inter.size > 0) out[modelID] = inter;
  }
  return out;
}