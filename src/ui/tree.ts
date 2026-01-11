// src/ui/tree.ts
// mount the model tree UI component into the DOM


import type { ViewerContext } from "../viewer/initViewer";
import type { ReturnType } from "./types"; // optional
import { rebuildClassifications, buildSpaceToLevelMap, type SpaceToLevelMap } from "../viewer/ifc/classification";
import { countItems } from "../utils/modelIdMap";
import type * as OBC from "@thatopen/components";

/**
 * A tiny interface for toasts so ui doesn't depend on viewer internals.
 * If you already have a toast module, use that type instead.
 */
type ToastFn = (msg: string, ms?: number) => void;

export function mountTree(params: {
  treeRoot: HTMLDivElement;
  ctx: ViewerContext;
  viewerApi: any;   // you can strongly-type later once api is stable
  toast: ToastFn;
}) {
  const { treeRoot, ctx, viewerApi, toast } = params;

  let spaceToLevel: SpaceToLevelMap = new Map();

  // ---------- DOM helpers ----------
  function makeIndentedLabel(text: string, depth: number) {
    const span = document.createElement("span");
    span.textContent = text;
    span.style.paddingLeft = `${depth * 14}px`;
    return span;
  }

  async function renderCategoriesSection(catGroups: Array<[string, any]>) {
    const section = document.createElement("details");
    section.open = false;

    const summary = document.createElement("summary");
    summary.appendChild(makeIndentedLabel("Categories", 0));
    section.appendChild(summary);

    for (const [catName, catData] of catGroups) {
      const map = await catData.get();
      const n = countItems(map);
      if (n === 0) continue;

      const row = document.createElement("div");
      row.className = "tree-row";
      row.appendChild(makeIndentedLabel(catName, 1));

      const nSpan = document.createElement("span");
      nSpan.className = "count";
      nSpan.textContent = String(n);
      row.appendChild(nSpan);

      row.addEventListener("click", async () => viewerApi.isolate(map));
      section.appendChild(row);
    }

    treeRoot.appendChild(section);
  }

  async function renderCadTree() {
    treeRoot.innerHTML = "";
    treeRoot.classList.add("tree");

    // Header
    const header = document.createElement("div");
    header.className = "tree-header";

    const title = document.createElement("div");
    title.textContent = "Model Tree";
    title.className = "tree-title";

    const resetBtn = document.createElement("button");
    resetBtn.textContent = "Reset";
    resetBtn.className = "tree-btn";
    resetBtn.onclick = () => viewerApi.resetVisibility();

    header.append(title, resetBtn);
    treeRoot.appendChild(header);

    const classifier = ctx.classifier;

    const levels = classifier.list.get("Levels");
    const spaces = classifier.list.get("Spaces");
    const cats = classifier.list.get("Categories");

    if (!levels || !spaces || !cats) {
      const msg = document.createElement("div");
      msg.textContent = "(Tree not ready yet)";
      treeRoot.appendChild(msg);
      return;
    }

    const levelGroups = Array.from(levels.entries());
    const spaceGroups = Array.from(spaces.entries());
    const catGroups = Array.from(cats.entries());

    // Levels -> Spaces
    for (const [levelName, levelData] of levelGroups) {
      const levelMap = await levelData.get();
      const levelCount = countItems(levelMap);

      const levelNode = document.createElement("details");
      levelNode.open = false;

      const levelSummary = document.createElement("summary");
      levelSummary.appendChild(makeIndentedLabel(levelName, 0));

      const levelCountSpan = document.createElement("span");
      levelCountSpan.className = "count";
      levelCountSpan.textContent = String(levelCount);
      levelSummary.appendChild(levelCountSpan);

      // Ctrl+click isolate storey
      levelSummary.addEventListener("click", async (e) => {
        if ((e as MouseEvent).ctrlKey) {
          e.preventDefault();
          await viewerApi.isolate(levelMap);
        }
      });

      levelNode.appendChild(levelSummary);

      // render spaces for this level
      for (const [spaceName, spaceData] of spaceGroups) {
        if (spaceToLevel.get(spaceName) !== levelName) continue;

        const spaceMap = await spaceData.get();
        const spaceCount = countItems(spaceMap);
        if (spaceCount === 0) continue;

        const spaceRow = document.createElement("div");
        spaceRow.className = "tree-row";
        spaceRow.appendChild(makeIndentedLabel(spaceName, 1));

        const nSpan = document.createElement("span");
        nSpan.className = "count";
        nSpan.textContent = String(spaceCount);
        spaceRow.appendChild(nSpan);

        spaceRow.addEventListener("click", async () => viewerApi.isolate(spaceMap));

        levelNode.appendChild(spaceRow);
      }

      treeRoot.appendChild(levelNode);
    }

    // Categories list
    await renderCategoriesSection(catGroups);

    toast("Tree updated");
  }

  /**
   * Subscribe once: rebuild classifications & tree on every model load.
   * This is the correct place for it because UI should react to state changes,
   * not drive loading logic.
   */
  viewerApi.onModelLoaded(async ({ modelId, model }: any) => {
    const classifier = ctx.classifier;

    const res = await rebuildClassifications(classifier, modelId);
    if (!res.ok) {
      toast(res.reason ?? "Classification failed");
      return;
    }

    spaceToLevel = await buildSpaceToLevelMap({ classifier, model, modelId });
    await renderCadTree();
  });
}
