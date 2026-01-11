// src/viewer/ifc/classification.ts
// IFC classification utilities: rebuild classifications, build Space->Level map


import type * as OBC from "@thatopen/components";
import { flattenLocalIds } from "../../utils/modelIdMap";
import { getCenterY, getUnionBox } from "../../utils/geometry";
import * as THREE from "three";

export type SpaceToLevelMap = Map<string, string>;

/**
 * Rebuild classifications for a loaded model.
 *
 * Critical note:
 * classifier.list.clear() avoids duplicates (good),
 * but it also removes any custom groups you might want to keep.
 * If later you add more classifications, consider selective clearing.
 */
export async function rebuildClassifications(
  classifier: OBC.Classifier,
  modelId: string
) {
  classifier.list.clear();

  await classifier.byIfcBuildingStorey({ classificationName: "Levels" });
  await classifier.byCategory({ classificationName: "Categories" });

  // Create "Spaces" groups by splitting the IfcSpace category into one entry per space ID.
  const cats = classifier.list.get("Categories");
  if (!cats) return { ok: false, reason: "No categories classification found" };

  const candidates = ["IfcSpace", "IFCSPACE", "Space", "Spaces"];
  let spaceGroupData: any | null = null;

  for (const key of candidates) {
    if (cats.has(key)) {
      spaceGroupData = cats.get(key);
      break;
    }
  }

  // Fallback search by key substring
  if (!spaceGroupData) {
    for (const [key, data] of cats) {
      if (String(key).toLowerCase().includes("space")) {
        spaceGroupData = data;
        break;
      }
    }
  }

  if (!spaceGroupData) {
    return { ok: false, reason: "No IfcSpace category found in model" };
  }

  const allSpacesMap: OBC.ModelIdMap = await spaceGroupData.get();
  const ids = Array.from(allSpacesMap[modelId] ?? []);

  for (const id of ids) {
    classifier.addGroupItems("Spaces", `IfcSpace #${id}`, { [modelId]: new Set([id]) });
  }

  return { ok: true, spaceCount: ids.length };
}

/**
 * Build mapping SpaceName -> LevelName by geometric containment heuristic:
 * - compute representative Y for each level as union box center
 * - assign each space to closest level center by |y-space - y-level|
 *
 * Critical assessment:
 * - Works even without clean IFC storey relationships.
 * - But depends on geometry quality and may mis-assign complex structures.
 */
export async function buildSpaceToLevelMap(params: {
  classifier: OBC.Classifier;
  model: any;
  modelId: string;
}): Promise<SpaceToLevelMap> {
  const { classifier, model, modelId } = params;

  const out: SpaceToLevelMap = new Map();

  const levels = classifier.list.get("Levels");
  const spaces = classifier.list.get("Spaces");
  if (!levels || !spaces) return out;

  const levelGroups = Array.from(levels.entries());
  const spaceGroups = Array.from(spaces.entries());

  // Compute representative Y for each level
  const levelCenters: Array<{ name: string; y: number }> = [];

  for (const [levelName, levelData] of levelGroups) {
    const levelMap = await levelData.get();
    const ids = flattenLocalIds(levelMap, modelId);
    if (ids.length === 0) continue;

    const box = await getUnionBox(model, ids);
    const c = new THREE.Vector3();
    box.getCenter(c);
    levelCenters.push({ name: levelName, y: c.y });
  }

  levelCenters.sort((a, b) => a.y - b.y);

  for (const [spaceName, spaceData] of spaceGroups) {
    const spaceMap = await spaceData.get();
    const ids = flattenLocalIds(spaceMap, modelId);
    if (ids.length === 0) continue;

    const y = await getCenterY(model, ids[0]);

    let bestLevel = levelCenters[0]?.name ?? "";
    let bestDist = Number.POSITIVE_INFINITY;

    for (const lvl of levelCenters) {
      const dist = Math.abs(y - lvl.y);
      if (dist < bestDist) {
        bestDist = dist;
        bestLevel = lvl.name;
      }
    }

    if (bestLevel) out.set(spaceName, bestLevel);
  }

  return out;
}
