// src/viewer/api.ts
// viewer API: onModelLoaded, get/setCameraPose, isolate, getSnapshot, getElementProperties

import * as THREE from "three";
import * as OBC from "@thatopen/components";
import { getActiveModel, getActiveModelId } from "./state";
import { getActiveIfcModelId } from "./state";
import { getActiveIfcTypeIndex } from "./state";
import { viewerEvents } from "./events";
import type { ViewerContext } from "./initViewer";
import { VIEWER_GRID_REFERENCE, type ViewerGridReference } from "./gridConfig";
import {
  DOOR_CLEARANCE_DEFAULTS,
  HIGHLIGHT_ANNOTATION_DEFAULTS,
  type HighlightAnnotationMode,
} from "../config/prototypeSettings";

export type VisibilityState = {
  mode: "all" | "isolate";
  lastIsolateCount?: number;
};


export type CameraPose = {
  eye: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
};

export type ViewerSnapshot = {
  imageBase64Png: string;
  pose: CameraPose;
  meta: {
    timestampIso: string;
    modelId: string | null;
    note?: string;
    context?: Record<string, unknown>;
  };
};

export type { ViewerGridReference };

/**
 * Deterministic camera presets.
 * - "iso": good general-purpose overview (shows vertical + horizontal structure)
 * - "top": plan-like view (good for layout, but can hide interiors)
 */
export type StartPosePreset = "iso" | "top";

type HighlightOverlayEntry = {
  localId: number;
  meshes: THREE.Object3D[];
  boxes: THREE.Box3[];
  merged: THREE.Box3;
  ifcClass: string | null;
  props: Record<string, any> | null;
};

export function createViewerApi(ctx: ViewerContext) {
  const { world, fragments, hider } = ctx;


// Depending on OBC version, components live in ctx.components or fragments.components

function getComponentsAny(): any {
  // Depending on OBC version, components live in ctx.components or fragments.components
  return (ctx as any).components ?? (fragments as any).components ?? null;
}

function findClassifier(components: any): any | null {
  if (!components) return null;

  // common patterns: components.get(ClassName) or components.tools[...]
  // We probe deterministically by checking known keys and known method shapes.
  const candidates: any[] = [];

  // A) components.get("IfcClassifier") style
  if (typeof components.get === "function") {
    for (const key of ["IfcClassifier", "Classifier", "FragmentClassifier"]) {
      try {
        const c = components.get(key);
        if (c) candidates.push(c);
      } catch {}
    }
  }

  // B) components.tools map
  const tools = (components as any).tools;
  if (tools && typeof tools === "object") {
    for (const key of ["IfcClassifier", "Classifier", "FragmentClassifier"]) {
      const c = tools[key];
      if (c) candidates.push(c);
    }
  }

  // C) brute: scan enumerable values once (still deterministic order by sorted keys)
  const keys = Object.keys(components).sort();
  for (const k of keys) {
    const v = (components as any)[k];
    if (!v) continue;
    // identify by method signature
    if (typeof v.getMap === "function" || typeof v.getAll === "function" || typeof v.find === "function") {
      candidates.push(v);
    }
  }

  // pick first that looks like classifier by having category→map method
  for (const c of candidates) {
    if (typeof c.getMap === "function") return c;
    if (typeof c.getModelIdMap === "function") return c;
    if (typeof c.find === "function") return c;
  }
  return null;
}

function findHighlightController(components: any): any | null {
  if (!components) return null;

  const candidates: any[] = [];
  if (typeof components.get === "function") {
    for (const key of ["FragmentsManager", "Highlighter", "FragmentHighlighter"]) {
      try {
        const c = components.get((OBC as any)[key] ?? key);
        if (c) candidates.push(c);
      } catch {}
    }
  }

  const keys = Object.keys(components).sort();
  for (const k of keys) {
    const v = (components as any)[k];
    if (!v) continue;
    if (
      typeof v.getBBoxes === "function" ||
      typeof v.highlight === "function" ||
      typeof v.resetHighlight === "function"
    ) {
      candidates.push(v);
    }
  }

  for (const c of candidates) {
    if (
      typeof c.getBBoxes === "function" ||
      (typeof c.highlight === "function" && typeof c.resetHighlight === "function")
    ) {
      return c;
    }
  }

  return null;
}

function logPlaneTest(plane: THREE.Plane, abs: number, upAxis: "y" | "z") {
  const above = upAxis === "y"
    ? new THREE.Vector3(0, abs + 0.5, 0)
    : new THREE.Vector3(0, 0, abs + 0.5);

  const below = upAxis === "y"
    ? new THREE.Vector3(0, abs - 0.5, 0)
    : new THREE.Vector3(0, 0, abs - 0.5);

  const da = plane.distanceToPoint(above);
  const db = plane.distanceToPoint(below);

  console.log("[PlanCut:PlaneTest]", { abs, daAbove: da, dbBelow: db });
}

function calibratePlaneKeepBelow(plane: THREE.Plane, absHeight: number, upAxis: "y" | "z") {
  // We want: keep BELOW the cut (below = visible), clip ABOVE.
  const above = upAxis === "y"
    ? new THREE.Vector3(0, absHeight + 0.5, 0)
    : new THREE.Vector3(0, 0, absHeight + 0.5);

  const below = upAxis === "y"
    ? new THREE.Vector3(0, absHeight - 0.5, 0)
    : new THREE.Vector3(0, 0, absHeight - 0.5);

  const dAbove = plane.distanceToPoint(above);
  const dBelow = plane.distanceToPoint(below);

  // Empirical rule for Three clipping:
  // If your result is inverted, negate() flips it.
  // We expect: above should be "more clipped side" than below.
  // So if dAbove < dBelow, the plane is likely inverted for your pipeline → flip.
  if (dAbove < dBelow) {
    plane.negate();
    return { flipped: true, dAbove, dBelow };
  }
  return { flipped: false, dAbove, dBelow };
}

// Get active group in fragments.list for active model (any version)
function getActiveGroupAny(): any | null {
  const modelKey = getActiveModelId();
  if (!modelKey) return null;
  const listAny: any = (fragments as any).list;
  return typeof listAny?.get === "function" ? listAny.get(modelKey) : listAny?.[modelKey] ?? null;
}

  // Keep a copy of the last isolate map (so navigation can "go to what is currently isolated")
  let lastIsolateMap: OBC.ModelIdMap | null = null;
  // Track hidden items so we can report evidence metadata to the VLM deterministically.
  // Keys are modelIds; values are sets of localIds.
  const hiddenMapByModel: Record<string, Set<number>> = {};

  function ensureHiddenSet(modelId: string) {
    hiddenMapByModel[modelId] ??= new Set<number>();
    return hiddenMapByModel[modelId];
  }

  // Accepts:
  // - "123" (localId on active model)
  // - "modelId:123"
  // Returns null if it can't be parsed.
  function parseObjectId(id: string): { modelId: string; localId: number } | null {
    const raw = String(id ?? "").trim();
    if (!raw) return null;

    const activeModelId = getActiveModelId();
    if (!activeModelId) return null;

    // modelId:localId
    if (raw.includes(":")) {
      const [m, l] = raw.split(":");
      const localId = Number(l);
      if (!m || !Number.isFinite(localId)) return null;
      return { modelId: m, localId };
    }

    // localId only -> assume active model
    const localId = Number(raw);
    if (!Number.isFinite(localId)) return null;
    return { modelId: activeModelId, localId };
  }

  // ----------------------------
  // Highlight / selection state
  // ----------------------------
  let lastPickedObjectId: string | null = null;

  // Single shared highlight materials (deterministic)
  const highlightPrimaryMat = new THREE.MeshBasicMaterial({
    color: 0xffd54a,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false,
  });

  const highlightWarnMat = new THREE.MeshBasicMaterial({
    color: 0xff4a4a,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false,
  });

  function pickHighlightMaterial(style?: "primary" | "warn") {
    return style === "warn" ? highlightWarnMat : highlightPrimaryMat;
  }

  const highlightFillRoot = new THREE.Group();
  highlightFillRoot.name = "semantic-highlight-fill";
  world.scene.three.add(highlightFillRoot);
  const semanticOverlayRoot = new THREE.Group();
  semanticOverlayRoot.name = "semantic-highlight-overlays";
  world.scene.three.add(semanticOverlayRoot);
  const viewerHost = world.renderer.three.domElement.parentElement;
  if (viewerHost && getComputedStyle(viewerHost).position === "static") {
    viewerHost.style.position = "relative";
  }
  const highlightHudEl = document.createElement("div");
  highlightHudEl.style.position = "absolute";
  highlightHudEl.style.top = "12px";
  highlightHudEl.style.left = "50%";
  highlightHudEl.style.transform = "translateX(-50%)";
  highlightHudEl.style.zIndex = "20";
  highlightHudEl.style.pointerEvents = "none";
  highlightHudEl.style.display = "none";
  highlightHudEl.style.minWidth = "340px";
  highlightHudEl.style.maxWidth = "min(720px, calc(100% - 24px))";
  highlightHudEl.style.padding = "12px 16px";
  highlightHudEl.style.border = "2px solid rgba(255, 213, 74, 0.9)";
  highlightHudEl.style.borderRadius = "14px";
  highlightHudEl.style.background = "rgba(7, 10, 20, 0.9)";
  highlightHudEl.style.color = "#f8fafc";
  highlightHudEl.style.fontFamily = "ui-sans-serif, system-ui, sans-serif";
  highlightHudEl.style.boxShadow = "0 12px 30px rgba(0,0,0,0.3)";
  highlightHudEl.style.backdropFilter = "blur(6px)";
  if (viewerHost && !viewerHost.contains(highlightHudEl)) {
    viewerHost.appendChild(highlightHudEl);
  }
  const semanticClassByObjectId = new Map<string, string>();
  let highlightAnnotationMode: HighlightAnnotationMode = HIGHLIGHT_ANNOTATION_DEFAULTS.mode;
  let activeHighlightState:
    | {
        modelId: string;
        localIds: number[];
        style?: "primary" | "warn";
        entries: HighlightOverlayEntry[];
      }
    | null = null;
  let highlightRefreshScheduled = false;
  let highlightPlanCutAdjustmentInFlight = false;

  function clearHighlightFillOverlays() {
    for (const child of [...highlightFillRoot.children]) {
      highlightFillRoot.remove(child);
      const c: any = child as any;
      if (Array.isArray(c.material)) {
        for (const m of c.material) m?.dispose?.();
      } else {
        c.material?.dispose?.();
      }
    }
  }

  function clearSemanticOverlays() {
    for (const child of [...semanticOverlayRoot.children]) {
      semanticOverlayRoot.remove(child);
      const c: any = child as any;
      c.geometry?.dispose?.();
      c.material?.dispose?.();
    }
  }

  function clearHighlightHud() {
    highlightHudEl.innerHTML = "";
    highlightHudEl.style.display = "none";
  }

  function clearAllHighlightOverlays() {
    clearHighlightFillOverlays();
    clearSemanticOverlays();
    clearHighlightHud();
  }

  async function clearActiveHighlightState() {
    const controller = findHighlightController(getComponentsAny());
    const group = getActiveGroupAny();
    try {
      if (controller && typeof controller.resetHighlight === "function") {
        await controller.resetHighlight();
      } else if (group && typeof group.resetHighlight === "function") {
        await group.resetHighlight();
      }
    } catch {
      // best effort: clear overlays/state even if native reset fails
    }
    activeHighlightState = null;
    lastPickedObjectId = null;
    clearAllHighlightOverlays();
  }

  function getActiveHighlightObjectIds(): string[] {
    if (!activeHighlightState) return [];
    return activeHighlightState.localIds.map((localId) => toObjectId(activeHighlightState.modelId, localId));
  }

  async function ensurePlanCutContainsActiveHighlight(api: any) {
    if (
      highlightPlanCutAdjustmentInFlight ||
      !planCutState.enabled ||
      planCutState.mode !== "WORLD_UP" ||
      !activeHighlightState?.entries.length
    ) {
      return false;
    }

    const union = new THREE.Box3();
    let hasBox = false;
    for (const entry of activeHighlightState.entries) {
      if (!entry?.merged || entry.merged.isEmpty()) continue;
      union.union(entry.merged);
      hasBox = true;
    }
    if (!hasBox || union.isEmpty()) return false;

    const upAxis = getUpAxis();
    const minH = upAxis === "y" ? union.min.y : union.min.z;
    const maxH = upAxis === "y" ? union.max.y : union.max.z;
    const height = Math.max(0.01, maxH - minH);
    const margin = Math.max(0.01, height * 0.02);
    const requiredAbs = maxH + margin;

    if (requiredAbs <= planCutState.absoluteHeight + 1e-4) {
      return false;
    }

    highlightPlanCutAdjustmentInFlight = true;
    try {
      await api.setPlanCut({
        absoluteHeight: requiredAbs,
        mode: planCutState.mode,
        source: "highlight-top",
        storeyId: planCutState.storeyId,
      });
      return true;
    } finally {
      highlightPlanCutAdjustmentInFlight = false;
    }
  }

  async function restoreFullModelVisibilityPreserveHighlight() {
    await hider.set(true);
    lastIsolateMap = null;
    visibilityState = { mode: "all", lastIsolateCount: undefined };
    for (const k of Object.keys(hiddenMapByModel)) delete hiddenMapByModel[k];
    planCutState = { enabled: false, planes: [] };
    clearClippingPlanes();
    fragments.core.update(true);
    world.renderer.three.render(world.scene.three, world.camera.three);
  }

  function createLineMaterial(color: number, opacity = 0.94) {
    return new THREE.LineBasicMaterial({
      color,
      linewidth: HIGHLIGHT_ANNOTATION_DEFAULTS.lineWidth,
      depthTest: false,
      transparent: true,
      opacity,
    });
  }

  async function getElementPropertiesSafe(modelId: string, localId: number): Promise<Record<string, any> | null> {
    const activeModelId = getActiveModelId();
    if (!activeModelId || activeModelId !== modelId) return null;
    const model = getActiveModel();
    if (!model || typeof model.getProperties !== "function") return null;
    try {
      return (await model.getProperties(localId)) ?? null;
    } catch {
      return null;
    }
  }

  async function getMeshesForLocalIds(modelId: string, localIds: number[]): Promise<THREE.Object3D[]> {
    const listAny: any = (fragments as any).list;
    const group = typeof listAny?.get === "function" ? listAny.get(modelId) : listAny?.[modelId];
    if (!group) return [];

    const uniq = Array.from(new Set(localIds)).filter((n) => Number.isFinite(n));
    if (!uniq.length) return [];

    if (typeof group.getMeshesByItems === "function") {
      return (await group.getMeshesByItems(uniq)) ?? [];
    }
    if (typeof group.getMeshesByItem === "function") {
      const out: THREE.Object3D[] = [];
      for (const id of uniq) {
        const one = (await group.getMeshesByItem(id)) ?? [];
        out.push(...one);
      }
      return out;
    }
    return [];
  }

  async function getBoxesForLocalIds(modelId: string, localIds: number[]): Promise<THREE.Box3[]> {
    const components = getComponentsAny();
    const controller = findHighlightController(components);
    const uniq = Array.from(new Set(localIds)).filter((n) => Number.isFinite(n));
    if (!controller || !uniq.length || typeof controller.getBBoxes !== "function") return [];

    try {
      const boxes = await controller.getBBoxes({ [modelId]: new Set(uniq) });
      return Array.isArray(boxes)
        ? boxes.filter((b: any) => b?.isBox3 && !b.isEmpty())
        : [];
    } catch {
      return [];
    }
  }

  function makeTextSprite(text: string, color: number, background = "rgba(7, 10, 20, 0.82)") {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return null;

    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    ctx2d.fillStyle = background;
    ctx2d.strokeStyle = `#${color.toString(16).padStart(6, "0")}`;
    ctx2d.lineWidth = 6;
    const radius = 20;
    ctx2d.beginPath();
    ctx2d.moveTo(radius, 0);
    ctx2d.lineTo(canvas.width - radius, 0);
    ctx2d.quadraticCurveTo(canvas.width, 0, canvas.width, radius);
    ctx2d.lineTo(canvas.width, canvas.height - radius);
    ctx2d.quadraticCurveTo(canvas.width, canvas.height, canvas.width - radius, canvas.height);
    ctx2d.lineTo(radius, canvas.height);
    ctx2d.quadraticCurveTo(0, canvas.height, 0, canvas.height - radius);
    ctx2d.lineTo(0, radius);
    ctx2d.quadraticCurveTo(0, 0, radius, 0);
    ctx2d.closePath();
    ctx2d.fill();
    ctx2d.stroke();

    ctx2d.fillStyle = "#f8fafc";
    ctx2d.font = "bold 42px sans-serif";
    ctx2d.textAlign = "center";
    ctx2d.textBaseline = "middle";
    ctx2d.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.renderOrder = 1000;
    return sprite;
  }

  function addBadge(text: string, anchor: THREE.Vector3, color: number, scale = 0.8) {
    const badge = makeTextSprite(text, color);
    if (!badge) return;
    badge.position.copy(anchor);
    badge.scale.set(1.8 * scale, 0.45 * scale, 1);
    semanticOverlayRoot.add(badge);
  }

  function getEntrySizeReference(entry: HighlightOverlayEntry) {
    const { majorSize, minorSize, verticalSize } = getHorizontalAxes(entry.merged);
    return {
      width: majorSize,
      depth: minorSize,
      height: verticalSize,
    };
  }

  function getEntrySemanticLegend(entry: HighlightOverlayEntry, style?: "primary" | "warn") {
    const accent = `#${pickHighlightMaterial(style).color.getHexString()}`;
    const ifcClass = String(entry.ifcClass ?? "IfcElement").toUpperCase();
    if (ifcClass === "IFCDOOR") {
      return [
        { color: accent, label: "target" },
        { color: "#60a5fa", label: "hinge" },
        { color: "#34d399", label: "latch" },
        { color: "#f97316", label: "swing" },
      ];
    }
    if (ifcClass === "IFCRAMP") {
      return [
        { color: accent, label: "target" },
        { color: "#f97316", label: "slope axis" },
        { color: "#22d3ee", label: "landing edge" },
      ];
    }
    if (ifcClass === "IFCSTAIR" || ifcClass === "IFCSTAIRFLIGHT") {
      return [
        { color: accent, label: "target" },
        { color: "#f97316", label: "run axis" },
      ];
    }
    return [{ color: accent, label: "target" }];
  }

  function getEntrySemanticLegendMeaning(entry: HighlightOverlayEntry, style?: "primary" | "warn") {
    const legend = getEntrySemanticLegend(entry, style);
    const map: Record<string, string> = {
      target: "Highlighted target footprint, fill, and target emphasis",
      hinge: "Hinge side marker",
      latch: "Latch side marker",
      swing: "Door swing direction and swing arc",
      "slope axis": "Ramp run direction used to reason about slope and incline",
      "landing edge": "Ramp transition or landing edge marker",
      "run axis": "Primary stair run direction marker",
    };
    return legend.map((item) => ({ color: item.color, meaning: map[item.label] ?? item.label }));
  }

  function buildHighlightHudModel(entry: HighlightOverlayEntry, style?: "primary" | "warn") {
    const sizeRef = getEntrySizeReference(entry);
    const objectId = activeHighlightState ? `${activeHighlightState.modelId}:${entry.localId}` : `${entry.localId}`;
    const accent = `#${pickHighlightMaterial(style).color.getHexString()}`;
    return {
      accent,
      title: `${String(entry.ifcClass ?? "Element").toUpperCase()} ${objectId}`,
      dimensions: `W ${sizeRef.width.toFixed(3)} m   D ${sizeRef.depth.toFixed(3)} m   H ${sizeRef.height.toFixed(3)} m`,
      legend: getEntrySemanticLegend(entry, style),
      sizeReference: sizeRef,
    };
  }

  function renderHighlightHudDom(entry: HighlightOverlayEntry, style?: "primary" | "warn") {
    const hud = buildHighlightHudModel(entry, style);
    const legendHtml = hud.legend.length > 1
      ? hud.legend
      .map(
        (item) =>
          `<span style="display:inline-flex;align-items:center;gap:6px;margin-right:12px;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;">` +
          `<span style="display:inline-block;width:10px;height:10px;border-radius:999px;background:${item.color};box-shadow:0 0 0 1px rgba(255,255,255,0.15) inset;"></span>` +
          `${item.label}</span>`
      )
      .join("")
      : "";
    highlightHudEl.style.borderColor = hud.accent;
    highlightHudEl.innerHTML =
      `<div style="font-size:15px;font-weight:800;letter-spacing:0.04em;text-transform:uppercase;margin-bottom:6px;">${hud.title}</div>` +
      `<div style="font-size:14px;font-weight:700;margin-bottom:8px;">${hud.dimensions}</div>` +
      (legendHtml ? `<div style="font-size:11px;opacity:0.9;">${legendHtml}</div>` : "");
    highlightHudEl.style.display = "block";
  }

  function getHorizontalAxes(box: THREE.Box3) {
    const upAxis = getUpAxis();
    const size = box.getSize(new THREE.Vector3());
    const vertical = upAxis === "y" ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    const horizontalAxes =
      upAxis === "y"
        ? [
            { axis: new THREE.Vector3(1, 0, 0), size: size.x },
            { axis: new THREE.Vector3(0, 0, 1), size: size.z },
          ]
        : [
            { axis: new THREE.Vector3(1, 0, 0), size: size.x },
            { axis: new THREE.Vector3(0, 1, 0), size: size.y },
          ];
    horizontalAxes.sort((a, b) => b.size - a.size);
    return {
      vertical,
      majorAxis: horizontalAxes[0]?.axis ?? new THREE.Vector3(1, 0, 0),
      majorSize: horizontalAxes[0]?.size ?? 0,
      minorAxis: horizontalAxes[1]?.axis ?? new THREE.Vector3(0, 0, 1),
      minorSize: horizontalAxes[1]?.size ?? 0,
      verticalSize: upAxis === "y" ? size.y : size.z,
    };
  }

  function getCameraOverlayBias(distance = 0.035) {
    const dir = new THREE.Vector3();
    world.camera.three.getWorldDirection(dir);
    return dir.multiplyScalar(-distance);
  }

  function inferDoorAnnotation(props: Record<string, any> | null) {
    const raw =
      [
        props?.OperationType,
        props?.operationType,
        props?.UserDefinedOperationType,
        props?.OverallOperationType,
        props?.Name,
      ]
        .filter((v) => typeof v === "string" && v.trim())
        .join(" ")
        .toUpperCase();

    const hingeSide =
      raw.includes("RIGHT")
        ? "right"
        : raw.includes("LEFT")
          ? "left"
          : "left";
    const swingSide =
      raw.includes("REVERSE") || raw.includes("OUT") || raw.includes("OUTSWING")
        ? "reverse"
        : "forward";

    return { hingeSide, swingSide, raw };
  }

  function buildDoorClearanceFocusBox(entry: HighlightOverlayEntry): THREE.Box3 {
    const union = entry.merged.clone();
    const center = union.getCenter(new THREE.Vector3());
    const { vertical, majorAxis, majorSize, minorAxis, minorSize, verticalSize } = getHorizontalAxes(union);
    const { hingeSide, swingSide } = inferDoorAnnotation(entry.props);
    const hingeSign = hingeSide === "right" ? 1 : -1;
    const swingSign = swingSide === "reverse" ? -1 : 1;
    const pushDir = minorAxis.clone().normalize().multiplyScalar(swingSign);
    const pullDir = pushDir.clone().multiplyScalar(-1);
    const latchDir = majorAxis.clone().normalize().multiplyScalar(-hingeSign);

    const addPoint = (base: THREE.Vector3) => union.expandByPoint(base);
    const halfWidth = Math.max(majorSize * 0.5, 0.25);
    const halfDepth = Math.max(minorSize * 0.5, 0.05);
    const halfHeight = Math.max(verticalSize * 0.5, 0.1);
    const baseCorners = [
      center.clone().addScaledVector(majorAxis, halfWidth).addScaledVector(minorAxis, halfDepth),
      center.clone().addScaledVector(majorAxis, halfWidth).addScaledVector(minorAxis, -halfDepth),
      center.clone().addScaledVector(majorAxis, -halfWidth).addScaledVector(minorAxis, halfDepth),
      center.clone().addScaledVector(majorAxis, -halfWidth).addScaledVector(minorAxis, -halfDepth),
    ];
    for (const corner of baseCorners) {
      addPoint(corner.clone().addScaledVector(pushDir, DOOR_CLEARANCE_DEFAULTS.pushSideDepthMeters));
      addPoint(corner.clone().addScaledVector(pullDir, DOOR_CLEARANCE_DEFAULTS.pullSideDepthMeters));
      addPoint(corner.clone().addScaledVector(latchDir, DOOR_CLEARANCE_DEFAULTS.latchSideMeters));
      addPoint(corner.clone().addScaledVector(vertical, halfHeight * 0.15));
    }

    union.expandByScalar(0.06);
    return union;
  }

  function buildCenteredTopPoseFromBox(box: THREE.Box3, currentPose: CameraPose): CameraPose | null {
    if (!box || box.isEmpty()) return null;
    const center = box.getCenter(new THREE.Vector3());
    const upAxis = getUpAxis();
    if (upAxis === "y") {
      const height = Math.max(0.5, Math.abs(currentPose.eye.y - currentPose.target.y));
      return {
        eye: { x: center.x, y: center.y + height, z: center.z },
        target: { x: center.x, y: center.y, z: center.z },
      };
    }

    const height = Math.max(0.5, Math.abs(currentPose.eye.z - currentPose.target.z));
    return {
      eye: { x: center.x, y: center.y, z: center.z + height },
      target: { x: center.x, y: center.y, z: center.z },
    };
  }

  function boxVolume(box: THREE.Box3 | null | undefined) {
    if (!box || !box.isBox3 || box.isEmpty()) return 0;
    const size = box.getSize(new THREE.Vector3());
    return Math.max(0, size.x) * Math.max(0, size.y) * Math.max(0, size.z);
  }

  function updateHighlightHud(entry?: HighlightOverlayEntry | null, style?: "primary" | "warn") {
    clearHighlightHud();
    if (!entry) return;
    renderHighlightHudDom(entry, style);
  }

  function getHighlightAnnotationContext() {
    const style = activeHighlightState?.style ?? "primary";
    const topDown = isTopDownOverlayView();
    const primaryClass = activeHighlightState?.entries[0]?.ifcClass ?? null;
    const activeEntry = activeHighlightState?.entries.length === 1 ? activeHighlightState.entries[0] : undefined;
    const sizeReference = activeHighlightState?.entries.length === 1 && activeHighlightState?.entries[0]
      ? getEntrySizeReference(activeHighlightState.entries[0])
      : undefined;
    const legend = activeHighlightState?.entries.length === 1
      ? getEntrySemanticLegendMeaning(activeHighlightState.entries[0], style)
      : [];
    const isDoor = String(primaryClass ?? "").toUpperCase() === "IFCDOOR";
    const doorClearanceFocusBox = isDoor && activeEntry ? buildDoorClearanceFocusBox(activeEntry) : null;
    const entryBoxVolume = activeEntry ? boxVolume(activeEntry.merged) : 0;
    const focusBoxVolume = doorClearanceFocusBox ? boxVolume(doorClearanceFocusBox) : 0;
    const doorClearanceReadiness = isDoor
      ? {
          measurableLikely: Boolean(
            topDown &&
            planCutState.enabled &&
            sizeReference &&
            activeHighlightState?.entries.length === 1 &&
            focusBoxVolume > entryBoxVolume * 1.2
          ),
          missing: [
            ...(topDown ? [] : ["top_view_alignment"]),
            ...(planCutState.enabled ? [] : ["storey_plan_cut"]),
            ...(sizeReference ? [] : ["size_reference"]),
            ...(doorClearanceFocusBox ? [] : ["clearance_focus_box"]),
          ],
          evidenceBundle: {
            needsTopMeasurementView: true,
            needsContextConfirmView: true,
            topMeasurementViewReady: Boolean(topDown && planCutState.enabled && doorClearanceFocusBox),
            contextConfirmViewReady: Boolean(!topDown && sizeReference),
          },
          requiredZones: {
            pullSideDepthMeters: DOOR_CLEARANCE_DEFAULTS.pullSideDepthMeters,
            pushSideDepthMeters: DOOR_CLEARANCE_DEFAULTS.pushSideDepthMeters,
            latchSideMeters: DOOR_CLEARANCE_DEFAULTS.latchSideMeters,
          },
          focusBox: doorClearanceFocusBox
            ? {
                min: { x: doorClearanceFocusBox.min.x, y: doorClearanceFocusBox.min.y, z: doorClearanceFocusBox.min.z },
                max: { x: doorClearanceFocusBox.max.x, y: doorClearanceFocusBox.max.y, z: doorClearanceFocusBox.max.z },
              }
            : undefined,
        }
      : undefined;

    return {
      highlightAnnotations: {
        mode: highlightAnnotationMode,
        viewLayout: topDown ? "top_down" : "angled",
        lineWidth: HIGHLIGHT_ANNOTATION_DEFAULTS.lineWidth,
        highlightedIds: activeHighlightState
          ? activeHighlightState.localIds.map((localId) => `${activeHighlightState!.modelId}:${localId}`)
          : [],
        primaryClass,
        sizeReference,
        sizeHudVisible: Boolean(sizeReference),
        hudContents: activeHighlightState?.entries.length === 1
          ? buildHighlightHudModel(activeHighlightState.entries[0], style)
          : undefined,
        legend,
        ...(doorClearanceReadiness ? { doorClearanceReadiness } : {}),
        note:
          highlightAnnotationMode === "color_legend"
            ? "The top HUD is rendered into snapshots with class, id, dimensions, and color legend."
            : "On-image wording is enabled for visual reasoning, and the top HUD provides metric dimensions.",
      },
    } satisfies Record<string, unknown>;
  }

  async function composeSnapshotWithHud(imageBase64Png: string): Promise<string> {
    const entry = activeHighlightState?.entries.length === 1 ? activeHighlightState.entries[0] : null;
    if (!entry) return imageBase64Png;

    const hud = buildHighlightHudModel(entry, activeHighlightState?.style);
    const dataUrl = `data:image/png;base64,${imageBase64Png}`;
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("hud-image-load-failed"));
      image.src = dataUrl;
    });

    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return imageBase64Png;

    ctx2d.drawImage(image, 0, 0);

    const panelWidth = Math.min(canvas.width - 24, Math.max(420, canvas.width * 0.48));
    const hasLegend = hud.legend.length > 1;
    const panelHeight = hasLegend ? 88 : 62;
    const x = Math.round((canvas.width - panelWidth) / 2);
    const y = 14;
    const radius = 16;

    ctx2d.fillStyle = "rgba(7, 10, 20, 0.9)";
    ctx2d.strokeStyle = hud.accent;
    ctx2d.lineWidth = 3;
    ctx2d.beginPath();
    ctx2d.moveTo(x + radius, y);
    ctx2d.lineTo(x + panelWidth - radius, y);
    ctx2d.quadraticCurveTo(x + panelWidth, y, x + panelWidth, y + radius);
    ctx2d.lineTo(x + panelWidth, y + panelHeight - radius);
    ctx2d.quadraticCurveTo(x + panelWidth, y + panelHeight, x + panelWidth - radius, y + panelHeight);
    ctx2d.lineTo(x + radius, y + panelHeight);
    ctx2d.quadraticCurveTo(x, y + panelHeight, x, y + panelHeight - radius);
    ctx2d.lineTo(x, y + radius);
    ctx2d.quadraticCurveTo(x, y, x + radius, y);
    ctx2d.closePath();
    ctx2d.fill();
    ctx2d.stroke();

    ctx2d.fillStyle = "#f8fafc";
    ctx2d.textAlign = "center";
    ctx2d.textBaseline = "middle";
    ctx2d.font = "bold 20px sans-serif";
    ctx2d.fillText(hud.title, x + panelWidth / 2, y + 22);
    ctx2d.font = "600 16px sans-serif";
    ctx2d.fillText(hud.dimensions, x + panelWidth / 2, y + 46);

    if (hasLegend) {
      const legendY = y + 69;
      const itemSpacing = panelWidth / (hud.legend.length + 1);
      hud.legend.forEach((item, index) => {
        const itemX = x + itemSpacing * (index + 1);
        ctx2d.fillStyle = item.color;
        ctx2d.beginPath();
        ctx2d.arc(itemX - 28, legendY, 5, 0, Math.PI * 2);
        ctx2d.fill();
        ctx2d.fillStyle = "#f8fafc";
        ctx2d.font = "600 12px sans-serif";
        ctx2d.fillText(item.label.toUpperCase(), itemX + 10, legendY);
      });
    }

    const out = canvas.toDataURL("image/png");
    return out.startsWith("data:image/") ? (out.split(",")[1] ?? imageBase64Png) : out;
  }

  function drawLinearGuide(
    start: THREE.Vector3,
    end: THREE.Vector3,
    color: number,
    label?: string,
    labelOffset?: THREE.Vector3,
  ) {
    const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
    const line = new THREE.Line(
      geometry,
      createLineMaterial(color, 0.96)
    );
    line.renderOrder = 980;
    semanticOverlayRoot.add(line);

    const dir = end.clone().sub(start);
    const len = dir.length();
    if (len > 1e-5) {
      const arrow = new THREE.ArrowHelper(
        dir.clone().normalize(),
        start.clone(),
        len,
        color,
        Math.max(0.04, len * 0.18),
        Math.max(0.02, len * 0.09)
      );
      arrow.renderOrder = 981;
      arrow.traverse((child: any) => {
        child.renderOrder = 981;
        if (child.material) {
          child.material.depthTest = false;
          child.material.depthWrite = false;
          child.material.transparent = true;
        }
      });
      semanticOverlayRoot.add(arrow);
    }

    if (label && highlightAnnotationMode === "worded") {
      const labelPos = start.clone().lerp(end, 0.5).add(labelOffset ?? new THREE.Vector3(0, 0.15, 0));
      addBadge(label, labelPos, color, 0.55);
    }
  }

  function addMeshHighlightFill(meshes: THREE.Object3D[], style?: "primary" | "warn") {
    const baseMaterial = pickHighlightMaterial(style);
    for (const mesh of meshes) {
      const anyMesh: any = mesh as any;
      if (!anyMesh?.isMesh || !anyMesh.geometry) continue;

      const overlayMat = new THREE.MeshBasicMaterial({
        color: (baseMaterial.color?.getHex?.() ?? 0xffd54a),
        transparent: true,
        opacity: style === "warn" ? 0.24 : 0.14,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });

      const clone = new THREE.Mesh(anyMesh.geometry, overlayMat);
      clone.matrixAutoUpdate = false;
      clone.matrix.copy(anyMesh.matrixWorld);
      clone.matrixWorld.copy(anyMesh.matrixWorld);
      clone.frustumCulled = false;
      clone.renderOrder = 800;
      highlightFillRoot.add(clone);
    }
  }

  function renderHighlightOverlayEntries(entries: HighlightOverlayEntry[], style?: "primary" | "warn") {
    clearAllHighlightOverlays();
    const color = pickHighlightMaterial(style).color.getHex();
    updateHighlightHud(entries.length === 1 ? entries[0] : null, style);

    for (const entry of entries) {
      if (entry.meshes.length) addMeshHighlightFill(entry.meshes, style);
      if (entry.merged.isEmpty()) continue;

      const helper = new THREE.Box3Helper(entry.merged, color);
      semanticOverlayRoot.add(helper);
      helper.renderOrder = 920;

      drawGeneralSemanticOverlay(entry.merged, entry.ifcClass, color);
      if (typeof entry.ifcClass === "string" && entry.ifcClass.toUpperCase() === "IFCDOOR") {
        drawDoorSemanticOverlay(entry.merged, color, entry.props);
      } else if (typeof entry.ifcClass === "string" && entry.ifcClass.toUpperCase() === "IFCRAMP") {
        drawRampSemanticOverlay(entry.merged, color);
      }
    }
  }

  async function resolveHighlightOverlayEntries(
    modelId: string,
    localIds: number[],
  ): Promise<HighlightOverlayEntry[]> {
    const entries: HighlightOverlayEntry[] = [];
    const uniqueIds = Array.from(new Set(localIds)).slice(0, 12);

    for (const localId of uniqueIds) {
      const boxes = await getBoxesForLocalIds(modelId, [localId]);
      const meshes = await getMeshesForLocalIds(modelId, [localId]);
      const ifcClass = await inferSemanticClass(modelId, localId);
      const props = await getElementPropertiesSafe(modelId, localId);

      const merged = new THREE.Box3();
      for (const box of boxes) {
        if (!box.isEmpty()) merged.union(box);
      }
      for (const mesh of meshes) {
        const meshBox = new THREE.Box3().setFromObject(mesh);
        if (!meshBox.isEmpty()) merged.union(meshBox);
      }
      if (merged.isEmpty()) continue;

      entries.push({ localId, boxes, meshes, merged, ifcClass, props });
    }

    return entries;
  }

  function scheduleHighlightOverlayRefresh() {
    if (highlightRefreshScheduled) return;
    highlightRefreshScheduled = true;
    requestAnimationFrame(() => {
      highlightRefreshScheduled = false;
      if (!activeHighlightState) return;
      renderHighlightOverlayEntries(activeHighlightState.entries, activeHighlightState.style);
    });
  }

  async function inferSemanticClass(modelId: string, localId: number): Promise<string | null> {
    const key = `${modelId}:${localId}`;
    const cached = semanticClassByObjectId.get(key);
    if (cached) return cached;

    let ifcClass: string | null = null;
    try {
      const props = await getElementPropertiesSafe(modelId, localId);
      const raw =
        (props as any)?.type ??
        (props as any)?.ifcType ??
        (props as any)?.ifcClass ??
        (props as any)?.className ??
        null;
      if (typeof raw === "string" && raw.trim()) ifcClass = raw.trim();
    } catch {
      // ignore: fallback below
    }

    if (!ifcClass) {
      const listAny: any = (fragments as any).list;
      const group = typeof listAny?.get === "function" ? listAny.get(modelId) : listAny?.[modelId];
      if (group?.getItemsOfCategories) {
        for (const candidate of ["IFCDOOR", "IFCRAMP", "IFCSTAIR", "IFCSTAIRFLIGHT"]) {
          try {
            const out = await group.getItemsOfCategories([new RegExp(`^${candidate}$`, "i")]);
            const ids = extractNumericIdsFromUnknown(out, candidate);
            if (Array.isArray(ids) && ids.includes(localId)) {
              ifcClass = candidate.replace(/^IFC/, "Ifc");
              break;
            }
          } catch {
            // ignore fallback failure
          }
        }
      }
    }

    if (ifcClass) semanticClassByObjectId.set(key, ifcClass);
    return ifcClass;
  }

  function drawGeneralSemanticOverlay(box: THREE.Box3, ifcClass: string | null, color: number) {
    const center = box.getCenter(new THREE.Vector3());
    const { vertical, majorAxis, majorSize, minorAxis, minorSize, verticalSize } = getHorizontalAxes(box);
    const topDown = isTopDownOverlayView();
    const calloutLift = Math.max(0.36, verticalSize * 0.9);
    const sideOffset = majorAxis.clone().multiplyScalar(Math.max(0.55, majorSize * 0.9));
    const badgeAnchor = topDown
      ? center.clone().add(sideOffset).addScaledVector(vertical, Math.max(0.08, verticalSize * 0.18))
      : center.clone().addScaledVector(vertical, calloutLift);
    const scaleBoost = HIGHLIGHT_ANNOTATION_DEFAULTS.generalMarkerScale;
    const highlightRadius = Math.max(0.18, Math.max(majorSize, minorSize) * 0.52 * scaleBoost);

    const crosshairMajor = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        center.clone().addScaledVector(majorAxis, -highlightRadius),
        center.clone().addScaledVector(majorAxis, highlightRadius),
      ]),
      createLineMaterial(color, 0.82)
    );
    crosshairMajor.renderOrder = 911;
    semanticOverlayRoot.add(crosshairMajor);

    const crosshairMinor = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        center.clone().addScaledVector(minorAxis, -highlightRadius),
        center.clone().addScaledVector(minorAxis, highlightRadius),
      ]),
      createLineMaterial(color, 0.82)
    );
    crosshairMinor.renderOrder = 911;
    semanticOverlayRoot.add(crosshairMinor);

    if (topDown && highlightAnnotationMode === "worded") {
      const leaderStart = center.clone().addScaledVector(majorAxis, highlightRadius * 0.8);
      const leaderEnd = badgeAnchor.clone().addScaledVector(majorAxis, -0.3);
      const leader = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([leaderStart, leaderEnd]),
        createLineMaterial(color, 0.88)
      );
      leader.renderOrder = 912;
      semanticOverlayRoot.add(leader);
    }

    if (highlightAnnotationMode === "worded") {
      addBadge(`TARGET ${String(ifcClass ?? "ELEMENT").toUpperCase()}`, badgeAnchor, color, topDown ? 0.78 : 0.92);
    }
  }

  function drawDoorSemanticOverlay(
    box: THREE.Box3,
    color: number,
    props: Record<string, any> | null,
  ) {
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const { vertical, majorAxis, majorSize, minorAxis, minorSize, verticalSize } = getHorizontalAxes(box);
    const topDown = isTopDownOverlayView();
    const doorWidth = Math.max(majorSize, 0.25);
    const doorDepth = Math.max(minorSize, 0.08);
    const { hingeSide, swingSide } = inferDoorAnnotation(props);
    const hingeSign = hingeSide === "right" ? 1 : -1;
    const swingSign = swingSide === "reverse" ? -1 : 1;
    const hinge = center.clone().addScaledVector(majorAxis, hingeSign * doorWidth * 0.5);
    const latch = center.clone().addScaledVector(majorAxis, -hingeSign * doorWidth * 0.5);
    const lift = vertical.clone().multiplyScalar(Math.max(0.06, verticalSize * 0.08));
    const cameraBias = getCameraOverlayBias(Math.max(HIGHLIGHT_ANNOTATION_DEFAULTS.cameraOverlayBias, doorDepth * 0.45));
    const swingDir = minorAxis.clone().normalize().multiplyScalar(swingSign);
    const openTip = hinge.clone()
      .addScaledVector(swingDir, Math.max(doorWidth * 0.7, doorDepth * 1.6))
      .addScaledVector(majorAxis, -hingeSign * doorWidth * 0.1)
      .add(cameraBias);

    const markerRadius = topDown
      ? Math.max(HIGHLIGHT_ANNOTATION_DEFAULTS.doorMarkerRadiusTop, Math.max(doorDepth, doorWidth * 0.14))
      : Math.max(HIGHLIGHT_ANNOTATION_DEFAULTS.doorMarkerRadius, Math.min(size.x, size.y, size.z) * 0.12);
    const hingeMarker = new THREE.Mesh(
      new THREE.SphereGeometry(markerRadius, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0x60a5fa, depthTest: false, depthWrite: false })
    );
    hingeMarker.position.copy(hinge.clone().add(lift).add(cameraBias));
    hingeMarker.renderOrder = 950;
    semanticOverlayRoot.add(hingeMarker);

    const latchMarker = new THREE.Mesh(
      new THREE.SphereGeometry(markerRadius, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0x34d399, depthTest: false, depthWrite: false })
    );
    latchMarker.position.copy(latch.clone().add(lift).add(cameraBias));
    latchMarker.renderOrder = 950;
    semanticOverlayRoot.add(latchMarker);

    if (highlightAnnotationMode === "worded") {
      const sideOffset = majorAxis.clone().multiplyScalar(doorWidth * 0.18);
      const hingeBadgePos = topDown
        ? center.clone()
            .addScaledVector(majorAxis, -Math.max(0.55, doorWidth * 0.95))
            .addScaledVector(minorAxis, Math.max(0.32, doorDepth * 2.4))
            .addScaledVector(vertical, Math.max(0.06, verticalSize * 0.12))
        : hinge.clone().add(lift).add(cameraBias).addScaledVector(vertical, 0.18).add(sideOffset);
      addBadge(
        hingeSide === "right" ? "HINGE RIGHT" : "HINGE LEFT",
        hingeBadgePos,
        0x60a5fa,
        topDown ? 0.46 : 0.5
      );
    }
    drawLinearGuide(
      hinge.clone().add(lift).add(cameraBias),
      openTip.clone().add(lift).add(cameraBias),
      0xf97316,
      "SWING",
      topDown
        ? swingDir.clone().multiplyScalar(0.3).add(majorAxis.clone().multiplyScalar(-0.22))
        : vertical.clone().multiplyScalar(-0.2).add(swingDir.clone().multiplyScalar(0.12)),
    );

    const arcRadius = Math.max(doorWidth * 0.72, 0.2);
    const arcPoints: THREE.Vector3[] = [];
    const stepCount = 20;
    for (let i = 0; i <= stepCount; i++) {
      const t = i / stepCount;
      const theta = t * (Math.PI / 2);
      const closedDir = majorAxis.clone().multiplyScalar(-hingeSign * Math.cos(theta) * arcRadius);
      const swingOffset = minorAxis.clone().multiplyScalar(swingSign * Math.sin(theta) * arcRadius);
      const point = hinge.clone().add(closedDir).add(swingOffset).add(lift).add(cameraBias);
      arcPoints.push(point);
    }
    const arc = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(arcPoints),
      createLineMaterial(0xf97316, 0.95)
    );
    arc.renderOrder = 930;
    semanticOverlayRoot.add(arc);
  }

  function drawRampSemanticOverlay(box: THREE.Box3, color: number) {
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const { vertical, majorAxis, majorSize, minorAxis, minorSize, verticalSize } = getHorizontalAxes(box);
    const lift = vertical.clone().multiplyScalar(Math.max(0.06, verticalSize * 0.06));
    const cameraBias = getCameraOverlayBias(Math.max(HIGHLIGHT_ANNOTATION_DEFAULTS.cameraOverlayBias, Math.min(majorSize, minorSize) * 0.2));
    const halfRun = Math.max(majorSize * 0.45, 0.2);
    const start = center.clone().addScaledVector(majorAxis, -halfRun).add(lift).add(cameraBias);
    const end = center.clone().addScaledVector(majorAxis, halfRun).add(lift).add(cameraBias);
    drawLinearGuide(
      start,
      end,
      0xf97316,
      "SLOPE AXIS",
      isTopDownOverlayView()
        ? minorAxis.clone().multiplyScalar(Math.max(0.14, minorSize * 0.35))
        : vertical.clone().multiplyScalar(0.12)
    );

    const landingRadius = Math.max(0.045, Math.min(majorSize, minorSize, verticalSize) * 0.18, 0.06);
    for (const pos of [start, end]) {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(landingRadius, 16, 16),
        new THREE.MeshBasicMaterial({ color: 0x22d3ee, depthTest: false, depthWrite: false })
      );
      marker.position.copy(pos);
      marker.renderOrder = 950;
      semanticOverlayRoot.add(marker);
    }
  }

  async function drawSemanticHighlightOverlays(modelId: string, localIds: number[], style?: "primary" | "warn") {
    const entries = await resolveHighlightOverlayEntries(modelId, localIds);
    activeHighlightState = { modelId, localIds: [...localIds], style, entries };
    renderHighlightOverlayEntries(entries, style);
  }

  function buildModelIdMapFromObjectIds(objectIds: string[]): OBC.ModelIdMap {
    const map: OBC.ModelIdMap = {};
    for (const raw of objectIds ?? []) {
      const parsed = parseObjectId(raw);
      if (!parsed) continue;
      (map[parsed.modelId] ??= new Set<number>()).add(parsed.localId);
    }
    return map;
  }

  // Try hard to extract a localId from a raycast hit.
  // Works across OBC/fragments versions by probing common shapes.
  function extractLocalIdFromIntersection(hit: THREE.Intersection): number | null {
    const obj: any = hit.object as any;

    // A) Common userData patterns
    const ud = obj?.userData;
    for (const k of ["expressID", "expressId", "localId", "itemID", "itemId"]) {
      const v = ud?.[k];
      if (typeof v === "number" && isFinite(v)) return v;
    }

    // B) Geometry attribute per-vertex (expressID / itemID)
    const geom: any = obj?.geometry;
    const attrs = geom?.attributes;
    const attr =
      attrs?.expressID ??
      attrs?.expressId ??
      attrs?.itemID ??
      attrs?.itemId ??
      null;

    // Need indices + faceIndex to map triangle -> vertices
    if (!attr || hit.faceIndex == null || !geom?.index) return null;
    const index = geom.index;
    const tri = hit.faceIndex;

    const a = index.getX(tri * 3 + 0);
    const b = index.getX(tri * 3 + 1);
    const c = index.getX(tri * 3 + 2);

    const va = attr.getX(a);
    const vb = attr.getX(b);
    const vc = attr.getX(c);

    // Pick majority value (robust)
    const arr = [va, vb, vc].filter((n) => typeof n === "number" && isFinite(n));
    if (!arr.length) return null;

    arr.sort((x, y) => x - y);
    // majority of 3: middle is majority if there is one
    const mid = arr[Math.floor(arr.length / 2)];
    return typeof mid === "number" && isFinite(mid) ? mid : null;
  }

  function toObjectId(modelId: string, localId: number) {
    return `${modelId}:${localId}`;
  }

  function cloneModelIdMap(map: OBC.ModelIdMap): OBC.ModelIdMap {
    const out: OBC.ModelIdMap = {};
    for (const [mid, set] of Object.entries(map)) out[mid] = new Set(set);
    return out;
  }

  // Normalize user-provided category string to IFC standard form
function normalizeIfcCategory(raw: string): string {
  const upper = String(raw ?? "").trim().toUpperCase();
  const synonymToIfc: Record<string, string> = {
    DOOR: "IFCDOOR",
    DOORS: "IFCDOOR",
    SLAB: "IFCSLAB",
    SLABS: "IFCSLAB",
    STAIR: "IFCSTAIR",
    STAIRS: "IFCSTAIR",
    CEILING: "IFCCOVERING",
    CEILINGS: "IFCCOVERING",
    ROOF: "IFCROOF",
    ROOFS: "IFCROOF",
    WINDOW: "IFCWINDOW",
    WINDOWS: "IFCWINDOW",
    WALL: "IFCWALL",
    WALLS: "IFCWALL",
  };
  if (!upper) return upper;
  if (upper.startsWith("IFC")) return upper;
  return synonymToIfc[upper] ?? upper;
}

// Plan cut state
let planCutState:
  | { enabled: false; planes: [] }
  | {
      enabled: true;
      planes: THREE.Plane[];
      absoluteHeight: number;
      mode: "WORLD_UP" | "CAMERA";
      source?: "relative" | "absolute" | "highlight-top";
      storeyId?: string;
    } = { enabled: false, planes: [] };

type SavedMatState = {
  side: number;
  clippingPlanes?: THREE.Plane[] | null;
  clipIntersection?: boolean;
  clipping?: boolean;
};

let savedMaterialState: Map<string, SavedMatState> | null = null;

function forEachMaterial(obj: THREE.Object3D, fn: (m: THREE.Material) => void) {
  obj.traverse((child: any) => {
    const mat = child?.material;
    if (!mat) return;
    if (Array.isArray(mat)) mat.forEach(fn);
    else fn(mat);
  });
}

function applyClippingPlanes(planes: THREE.Plane[]) {
  const model = getActiveModel();
  if (!model?.object) return;

  // ✅ enable clipping
  world.renderer.three.localClippingEnabled = true;

  // ✅ ALSO set global clipping planes (important for fragments/instancing edge cases)
  world.renderer.three.clippingPlanes = planes;

  // Save material state once when enabling plan cut
  if (!savedMaterialState) savedMaterialState = new Map();

  forEachMaterial(model.object, (m) => {
    const key = (m as any).uuid as string;
    if (!savedMaterialState!.has(key)) {
      savedMaterialState!.set(key, {
        side: (m as any).side,
        clippingPlanes: (m as any).clippingPlanes ?? null,
        clipIntersection: (m as any).clipIntersection,
      });
    }

    (m as any).side = THREE.DoubleSide;
    (m as any).clippingPlanes = planes;
    (m as any).clipIntersection = planes.length > 1;
    (m as any).clipping = true;
    m.needsUpdate = true;
  });
}

function clearClippingPlanes() {
  const model = getActiveModel();
  if (!model?.object) return;

  // ✅ clear global clipping planes
  world.renderer.three.clippingPlanes = [];

  if (savedMaterialState) {
    forEachMaterial(model.object, (m) => {
      const key = (m as any).uuid as string;
      const prev = savedMaterialState!.get(key);
      if (!prev) return;

      (m as any).side = prev.side;
      (m as any).clippingPlanes = prev.clippingPlanes ?? null;
      (m as any).clipIntersection = prev.clipIntersection;
      m.needsUpdate = true;
    });

    savedMaterialState = null;
  }
}



function getUpAxis(): "y" | "z" {
  const up = world.camera.three.up;
  // tolerate small float drift
  if (Math.abs(up.z) > Math.abs(up.y)) return "z";
  return "y";
}

function isTopDownOverlayView() {
  const cam = world.camera.three;
  const upAxis = getUpAxis();
  const forward = new THREE.Vector3();
  cam.getWorldDirection(forward);
  const verticalAbs = upAxis === "y" ? Math.abs(forward.y) : Math.abs(forward.z);
  return verticalAbs > 0.9;
}

/**
 * Wait for camera controls to finish moving.  
 */
function waitForControlsRest(timeoutMs = 1200): Promise<void> {
  return new Promise((resolve) => {
    const controls: any = world.camera.controls;

    // If controls expose a "rest" event, use it (you already do elsewhere).
    let done = false;
    const onRest = () => {
      if (done) return;
      done = true;
      controls.removeEventListener?.("rest", onRest);
      resolve();
    };

    controls.addEventListener?.("rest", onRest);

    // Fallback timeout (never hang snapshots)
    window.setTimeout(() => onRest(), timeoutMs);
  });
}

  world.camera.controls?.addEventListener?.("update", scheduleHighlightOverlayRefresh);
  world.camera.controls?.addEventListener?.("rest", scheduleHighlightOverlayRefresh);

/**
 * Stabilize the scene for snapshot capture: 
 * - wait for camera to stop moving
 */

async function waitFrames(n = 2) {
  for (let i = 0; i < n; i++) {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }
}

async function stabilizeSceneForSnapshot() {
  // 1) wait until camera stops (or timeout)
  await waitForControlsRest(1200);

  // 2) update fragments for the current camera
  fragments.core.update(true);

  // 3) give worker/main thread time to apply changes
  await waitFrames(4);

  // 4) update again (often fixes "half updated" frames)
  fragments.core.update(true);
  await waitFrames(3);

  // 5) force a render right before readback
world.renderer.three.render(world.scene.three, world.camera.three);
await waitFrames(1);
world.renderer.three.render(world.scene.three, world.camera.three);
}

  let visibilityState = {
    mode: "all" as const,
    lastIsolateCount: undefined as number | undefined,
  };

  function countItems(map: OBC.ModelIdMap): number {
    let total = 0;
    for (const ids of Object.values(map)) total += ids.size;
    return total;
  }

  /**
   * Compute model bounds as a bounding sphere.
   *
   * Critical assessment:
   * - Bounding sphere is a robust, exporter-agnostic way to place cameras.
   * - It works even if the model is not aligned to world axes.
   * - If model is missing/empty, return null (caller decides what to do).
   */
  function getModelBoundsSphere(): { center: THREE.Vector3; radius: number } | null {
    const model = getActiveModel();
    if (!model) return null;

    const obj = model.object;
    if (!obj) return null;

    const box = new THREE.Box3().setFromObject(obj);

    // If box is empty, we can't compute a meaningful camera pose
    if (box.isEmpty()) return null;

    const sphere = box.getBoundingSphere(new THREE.Sphere());
    return { center: sphere.center.clone(), radius: sphere.radius };
  }

  let lastSelection: OBC.ModelIdMap | null = null;

  /**
   * Create a deterministic pose from a preset ("iso" or "top").
   *
   * Critical assessment:
   * - We derive distance from model radius => consistent framing across different model scales.
   * - "iso" direction uses a slightly elevated diagonal, good default for overview.
   * - "top" targets the center from above; works best when roofs/slabs aren't blocking.
   */
  function getPresetPose(preset: StartPosePreset): CameraPose | null {
    const s = getModelBoundsSphere();
    if (!s) return null;

    const { center, radius } = s;

    // Keep a minimum distance so small models are still visible
    const dist = Math.max(radius * 2.2, 5);

    if (preset === "iso") {
      // Slightly above horizon so vertical structure is visible
      const dir = new THREE.Vector3(1, 0.8, 1).normalize();
      const eye = center.clone().add(dir.multiplyScalar(dist));

      return {
        eye: { x: eye.x, y: eye.y, z: eye.z },
        target: { x: center.x, y: center.y, z: center.z },
      };
    }

    // "top"
    const eye = center.clone().add(new THREE.Vector3(0, dist, 0));
    return {
      eye: { x: eye.x, y: eye.y, z: eye.z },
      target: { x: center.x, y: center.y, z: center.z },
    };
  }

function sampleCanvasLuma(canvas: HTMLCanvasElement): number {
  // sample a few pixels deterministically from the center-ish area
  const ctx2d = document.createElement("canvas").getContext("2d");
  if (!ctx2d) return 0;

  const w = 32, h = 32;
  ctx2d.canvas.width = w;
  ctx2d.canvas.height = h;

  // draw current WebGL canvas into 2d (browser allows this for same-origin canvas)
  try {
    ctx2d.drawImage(canvas, 0, 0, w, h);
  } catch {
    // if blocked for any reason, return 0; calibration will fall back
    return 0;
  }

  const img = ctx2d.getImageData(0, 0, w, h).data;
  // compute average luma
  let sum = 0;
  for (let i = 0; i < img.length; i += 4) {
    const r = img[i], g = img[i + 1], b = img[i + 2];
    sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  return sum / (w * h);
}

async function renderBarrier() {
  fragments.core.update(true);
  world.renderer.three.render(world.scene.three, world.camera.three);
  await waitFrames(2);
  fragments.core.update(true);
  world.renderer.three.render(world.scene.three, world.camera.three);
}

  // Helpers for IFC type ID extraction from various shapes of output
function extractNumericIdsFromUnknown(out: any, preferredKey?: string): number[] | null {
  if (!out) return null;

  // direct array
  if (Array.isArray(out) && out.every((x) => typeof x === "number" && isFinite(x))) return out;

  // Set<number>
  if (out instanceof Set) {
    const arr = Array.from(out).filter((x) => typeof x === "number" && isFinite(x));
    return arr.length ? arr : null;
  }

  // Map<any, any>
  if (out instanceof Map) {
    // try preferred key first
    if (preferredKey != null && out.has(preferredKey)) {
      const v = out.get(preferredKey);
      const ids = extractNumericIdsFromUnknown(v);
      if (ids?.length) return ids;
    }

    // deterministic fallback: scan entries by sorted key string
    const entries = Array.from(out.entries()).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    for (const [, v] of entries) {
      const ids = extractNumericIdsFromUnknown(v);
      if (ids?.length) return ids;
    }
    return null;
  }

  // plain object: try preferred key, then scan keys deterministically
  if (typeof out === "object") {
    if (preferredKey != null) {
      const v =
        (out as any)[preferredKey] ??
        (out as any)[preferredKey.toUpperCase()] ??
        (out as any)[preferredKey.toLowerCase()];
      const ids = extractNumericIdsFromUnknown(v);
      if (ids?.length) return ids;
    }

    // common container fields
    for (const k of ["ids", "items", "expressIds", "elements"]) {
      const ids = extractNumericIdsFromUnknown((out as any)[k]);
      if (ids?.length) return ids;
    }

    // scan all keys in sorted order for first numeric array/set/map
    const keys = Object.keys(out).sort();
    for (const k of keys) {
      const ids = extractNumericIdsFromUnknown((out as any)[k]);
      if (ids?.length) return ids;
    }
  }

  return null;
}

function debugDescribeOut(out: any) {
  const kind = Object.prototype.toString.call(out);
  const keys = out && typeof out === "object" && !(out instanceof Map) && !(out instanceof Set) ? Object.keys(out).slice(0, 30) : [];
  return { kind, keys };
}


  //---------------------------------------------------//
  //--------------- Viewer API methods ----------------//
  //------------------Returned object -----------------//
  //---------------------------------------------------//
  // Return object with viewer API methods
  return {
    // Event: model loaded
    onModelLoaded(cb: (p: { modelId: string; model: any }) => void) {
      return viewerEvents.on("modelLoaded", cb);
    },

    hasModelLoaded(): boolean {
      return Boolean(getActiveModel() && getActiveModelId());
    },

        // --- low-level helpers for external modules (navigation, metrics, etc.) ---
    getThreeCamera() {
      return world.camera.three;
    },

    getRendererDomElement() {
      return world.renderer.three.domElement;
    },

    renderNow() {
      scheduleHighlightOverlayRefresh();
      world.renderer.three.render(world.scene.three, world.camera.three);
    },

    setHighlightAnnotationMode(mode: HighlightAnnotationMode) {
      highlightAnnotationMode = mode;
      scheduleHighlightOverlayRefresh();
    },

    getHighlightAnnotationMode() {
      return highlightAnnotationMode;
    },

    getLastSelection(): OBC.ModelIdMap | null {
  return lastSelection;
},

    getSceneObjects(): THREE.Object3D[] {
      // safest: the model root only, not helpers/grid
      const model = getActiveModel();
      return model?.object ? [model.object] : [];
    },

    async clearModel(): Promise<void> {
      const model = getActiveModel();
      const modelId = getActiveModelId();

      if (!model || !modelId) return;

      try {
        // Remove from scene
        world.scene.three.remove(model.object);

        // Try to dispose GPU resources if supported
        model.dispose?.();
        model.object?.traverse?.((obj: any) => {
          obj.geometry?.dispose?.();
          if (obj.material) {
            if (Array.isArray(obj.material)) obj.material.forEach((m: any) => m.dispose?.());
            else obj.material.dispose?.();
          }
        });

        // Remove from fragments list if possible
        fragments.list.delete?.(modelId);

        // Reset visibility state
        visibilityState = { mode: "all", lastIsolateCount: undefined };
        await clearActiveHighlightState();

        // Optional: emit event so UI modules can react
        viewerEvents.emit("modelUnloaded", {});
      } catch (err) {
        console.error("[ViewerApi] clearModel failed", err);
      }
    },

    async getCameraPose(): Promise<CameraPose> {
      const cam = world.camera.controls;

      // try to use control helpers if available, fallback otherwise
      // @ts-expect-error
      const pos = cam.getPosition ? cam.getPosition(new THREE.Vector3()) : world.camera.three.position.clone();
      // @ts-expect-error
      const tgt = cam.getTarget ? cam.getTarget(new THREE.Vector3()) : new THREE.Vector3(0, 0, 0);

      return {
        eye: { x: pos.x, y: pos.y, z: pos.z },
        target: { x: tgt.x, y: tgt.y, z: tgt.z },
      };
    },

    async setCameraPose(pose: CameraPose, smooth = true) {
      const { eye, target } = pose;
      await world.camera.controls.setLookAt(
        eye.x, eye.y, eye.z,
        target.x, target.y, target.z,
        smooth
      );
    },

    /**
     * Sets camera to a deterministic preset view (iso/top).
     *
     * Critical assessment:
     * - We do not do this automatically; caller decides when to enforce determinism.
     * - Used for: controlled experiments OR a fallback if user pose is too occluded.
     */
    async setPresetView(preset: StartPosePreset, smooth = true) {
      if (preset === "top" && activeHighlightState?.entries.length) {
        const currentPose = await this.getCameraPose();
        const union = new THREE.Box3();
        let hasBox = false;
        for (const entry of activeHighlightState.entries) {
          if (!entry?.merged || entry.merged.isEmpty()) continue;
          union.union(entry.merged);
          hasBox = true;
        }
        if (hasBox && !union.isEmpty()) {
          const centeredTop = buildCenteredTopPoseFromBox(union, currentPose);
          if (centeredTop) {
            await this.setCameraPose(centeredTop, smooth);
            return;
          }
        }
      }
      const pose = getPresetPose(preset);
      if (!pose) return;
      await this.setCameraPose(pose, smooth);
    },

    async moveCameraRelative(delta: { dx: number; dy: number; dz: number }, smooth = true) {
      const pose = await this.getCameraPose();
      await this.setCameraPose({
        eye: { x: pose.eye.x + delta.dx, y: pose.eye.y + delta.dy, z: pose.eye.z + delta.dz },
        target: { x: pose.target.x + delta.dx, y: pose.target.y + delta.dy, z: pose.target.z + delta.dz },
      }, smooth);
    },

async isolate(map: OBC.ModelIdMap) {
  const count = countItems(map);
  if (count === 0) return;

  await hider.set(true);
  await hider.isolate(map);
  await clearActiveHighlightState();

  // update visibility state for metadata/logging
  lastIsolateMap = cloneModelIdMap(map);
  visibilityState = { mode: "isolate", lastIsolateCount: count };

  // ✅ settle barrier so next snapshot isn't too early
  await stabilizeSceneForSnapshot();
  fragments.core.update(true);
  world.renderer.three.render(world.scene.three, world.camera.three);
},

async resetVisibility() {
  await hider.set(true);
  lastIsolateMap = null;
  visibilityState = { mode: "all", lastIsolateCount: undefined };
  for (const k of Object.keys(hiddenMapByModel)) delete hiddenMapByModel[k];

  // ✅ clear plan cut too
  planCutState = { enabled: false, planes: [] }
  clearClippingPlanes();
  await clearActiveHighlightState();

  fragments.core.update(true);
  world.renderer.three.render(world.scene.three, world.camera.three);
},


    getVisibilityState(): VisibilityState {
      // Return a copy so external modules can't mutate internal state by accident.
      return { ...visibilityState };
    },

async isolateCategory(category: string): Promise<OBC.ModelIdMap | null> {
  const modelKey = getActiveModelId();
  if (!modelKey) return null;
  const ids = await this.listCategoryObjectIds(category);
  if (!ids.length) return null;

  const localIds = ids
    .map((id) => Number(String(id).split(":")[1]))
    .filter((n) => Number.isFinite(n));

  if (!localIds.length) return null;
  const map: OBC.ModelIdMap = { [modelKey]: new Set(localIds) };
  await this.isolate(map);
  return map;
},

async listCategoryObjectIds(category: string, limit = 300): Promise<string[]> {
  const modelKey = getActiveModelId();
  if (!modelKey) return [];

  const listAny: any = (fragments as any).list;
  const group = typeof listAny?.get === "function" ? listAny.get(modelKey) : listAny?.[modelKey];
  if (!group || typeof group.getItemsOfCategories !== "function") {
    return [];
  }
  
  const raw = String(category ?? "").trim();
  if (!raw) return [];
  const upper = raw.toUpperCase();

  // deterministic synonym mapping for common user words
  const synonymToIfc: Record<string, string> = {
    DOOR: "IFCDOOR",
    DOORS: "IFCDOOR",
    STAIR: "IFCSTAIR",
    STAIRS: "IFCSTAIR",
    STAIRCASE: "IFCSTAIR",
    WALL: "IFCWALL",
    WALLS: "IFCWALL",
    SLAB: "IFCSLAB",
    SLABS: "IFCSLAB",
    CEILING: "IFCCOVERING",
    CEILINGS: "IFCCOVERING",
    WINDOW: "IFCWINDOW",
    WINDOWS: "IFCWINDOW",
    SPACE: "IFCSPACE",
    SPACES: "IFCSPACE",
    RAMP: "IFCRAMP",
    RAMPS: "IFCRAMP",
  };

  // If user passed "IfcDoor" -> "IFCDOOR"
  const ifcLike = upper.startsWith("IFC") ? upper : synonymToIfc[upper] ?? upper;
  const candidates = [ifcLike, ...(ifcLike.startsWith("IFC") ? [] : [`IFC${ifcLike}`])];

  let out: any = null;
  let chosenTag: string | null = null;
  for (const c of candidates) {
    const re = new RegExp(`^${c}$`, "i");
    try {
      out = await group.getItemsOfCategories([re]);
    } catch {
      out = null;
    }

    const ids = extractNumericIdsFromUnknown(out, c);
    if (ids?.length) {
      chosenTag = c;
      break;
    }
  }

  if (!chosenTag && typeof group.getCategories === "function") {
    let cats: string[] = [];
    try {
      cats = (await group.getCategories()) ?? [];
    } catch {
      cats = [];
    }

    const sorted = Array.from(new Set(cats.map((x) => String(x)))).sort();

    // deterministic fallback order: exact -> contains -> startsWith
    const pick =
      sorted.find((k) => k.toUpperCase() === ifcLike) ??
      sorted.find((k) => k.toUpperCase().includes(ifcLike)) ??
      sorted.find((k) => k.toUpperCase().startsWith(ifcLike));

    if (pick) {
      const re = new RegExp(`^${pick}$`, "i");
      try {
        out = await group.getItemsOfCategories([re]);
        chosenTag = pick.toUpperCase();
      } catch {
        out = null;
      }
    }
  }

  const localIds = extractNumericIdsFromUnknown(out, chosenTag ?? ifcLike) ?? [];
  if (!localIds.length) return [];

  const uniqSorted = Array.from(new Set(localIds))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
    .slice(0, Math.max(1, limit));

  return uniqSorted.map((localId) => `${modelKey}:${localId}`);
},

async listStoreys(): Promise<string[]> {
  const levels = (ctx as any).classifier?.list?.get?.("Levels");
  if (!levels) return [];
  return Array.from(levels.keys()).map((k) => String(k));
},

async isolateStorey(storeyId: string): Promise<OBC.ModelIdMap | null> {
  const levels = (ctx as any).classifier?.list?.get?.("Levels");
  if (!levels) {
    console.warn("[viewerApi] isolateStorey: Levels not available");
    return null;
  }

  // storeyId here is the levelName shown in the UI tree (e.g. "First floor")
  const entry = levels.get(String(storeyId));
  if (!entry?.get) {
    console.warn("[viewerApi] isolateStorey: unknown storeyId", storeyId);
    return null;
  }

  const map = await entry.get();
  const count =
    map && typeof map === "object"
      ? Object.values(map).reduce((acc: number, s: any) => acc + (s?.size ?? 0), 0)
      : 0;

  if (!map || count === 0) {
    console.warn("[viewerApi] isolateStorey: empty map", storeyId);
    return null;
  }

  await this.isolate(map);
  return map;
},

async isolateSpace(spaceId: string): Promise<OBC.ModelIdMap | null> {
  const spaces = (ctx as any).classifier?.list?.get?.("Spaces");
  if (!spaces) {
    console.warn("[viewerApi] isolateSpace: Spaces not available");
    return null;
  }

  const entry = spaces.get(String(spaceId));
  if (!entry?.get) {
    console.warn("[viewerApi] isolateSpace: unknown spaceId", spaceId);
    return null;
  }

  const map = await entry.get();
  const count =
    map && typeof map === "object"
      ? Object.values(map).reduce((acc: number, s: any) => acc + (s?.size ?? 0), 0)
      : 0;

  if (!map || count === 0) {
    console.warn("[viewerApi] isolateSpace: empty map", spaceId);
    return null;
  }

  await this.isolate(map);
  return map;
},



async setPlanCut(params: {
  height?: number;
  absoluteHeight?: number;
  thickness?: number;
  mode?: "WORLD_UP" | "CAMERA";
  source?: "relative" | "absolute" | "highlight-top";
  storeyId?: string;
}) {
  const hasAbsoluteHeight = Number.isFinite(params.absoluteHeight);
  const hasRelativeHeight = Number.isFinite(params.height);
  if (!hasAbsoluteHeight && !hasRelativeHeight) return;

  const mode = params.mode ?? "WORLD_UP";

  // --- compute absolute cut position (abs) in a stable way ---
  const upAxis = getUpAxis();

  // Base: if storey isolated -> use its min; else use camera target (stable)
  let base = 0;
  const current = (this as any).getCurrentIsolateSelection?.() as OBC.ModelIdMap | null;

  if (current) {
    const box = await this.getSelectionWorldBox(current);
    if (box && !box.isEmpty()) base = upAxis === "y" ? box.min.y : box.min.z;
    else {
      const pose = await this.getCameraPose();
      base = upAxis === "y" ? pose.target.y : pose.target.z;
    }
  } else {
    const pose = await this.getCameraPose();
    base = upAxis === "y" ? pose.target.y : pose.target.z;
  }

  let abs = hasAbsoluteHeight ? Number(params.absoluteHeight) : base + Number(params.height);

  // Clamp inside model bounds so we never clip everything by accident
  const model = getActiveModel();
  if (model?.object) {
    const box = new THREE.Box3().setFromObject(model.object);
    if (!box.isEmpty()) {
      const minH = upAxis === "y" ? box.min.y : box.min.z;
      const maxH = upAxis === "y" ? box.max.y : box.max.z;
      const eps = (maxH - minH) * 0.01;
      abs = Math.max(minH + eps, Math.min(maxH - eps, abs));
    }
  }

  // --- Build a SINGLE clipping plane ---
  // For WORLD_UP: plane normal is world-up; we keep BELOW and clip ABOVE.
  // For CAMERA: plane normal is opposite the camera forward vector, so we clip "in front"
  //             and keep the side nearer to the camera (CAD-like sectioning).
  let n: THREE.Vector3;
  let p0: THREE.Vector3;

  if (mode === "CAMERA") {
    // camera forward direction in world coords: from eye -> target
    const pose = await this.getCameraPose();
    const eye = new THREE.Vector3(pose.eye.x, pose.eye.y, pose.eye.z);
    const target = new THREE.Vector3(pose.target.x, pose.target.y, pose.target.z);
    const forward = target.clone().sub(eye).normalize();

    // We want the kept half-space to be the side nearer the camera.
    // Using normal = -forward typically keeps the camera side.
    n = forward.clone().negate();

    // Position plane at "abs" along world up axis (still driven by height input).
    // (This keeps your current semantics: height is a vertical plan height.)
    p0 = upAxis === "y" ? new THREE.Vector3(0, abs, 0) : new THREE.Vector3(0, 0, abs);
  } else {
    // WORLD_UP (classic plan cut): keep below abs, clip above
    n = upAxis === "y" ? new THREE.Vector3(0, -1, 0) : new THREE.Vector3(0, 0, -1);
    p0 = upAxis === "y" ? new THREE.Vector3(0, abs, 0) : new THREE.Vector3(0, 0, abs);
  }

  let plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, p0);

  // --- Deterministic orientation sanity: ensure "below" is kept for WORLD_UP ---
  // We do a simple check for WORLD_UP only (CAMERA mode depends on view direction).
  if (mode !== "CAMERA") {
    const abovePt = upAxis === "y"
      ? new THREE.Vector3(0, abs + 0.5, 0)
      : new THREE.Vector3(0, 0, abs + 0.5);

    const belowPt = upAxis === "y"
      ? new THREE.Vector3(0, abs - 0.5, 0)
      : new THREE.Vector3(0, 0, abs - 0.5);

    const dAbove = plane.distanceToPoint(abovePt);
    const dBelow = plane.distanceToPoint(belowPt);

    // If below isn't the "kept" side (positive-ish), flip.
    // This matches many Three pipelines where negative is clipped.
    if (dBelow < dAbove) {
      plane = plane.clone().negate();
    }
  }

  const planes = [plane];

  planCutState = {
    enabled: true,
    planes,
    absoluteHeight: abs,
    mode,
    source: params.source ?? (hasAbsoluteHeight ? "absolute" : "relative"),
    storeyId: params.storeyId,
  };
  applyClippingPlanes(planes);

  fragments.core.update(true);
  world.renderer.three.render(world.scene.three, world.camera.three);

  console.log("[PlanCut:Single]", { mode, upAxis, base, height: params.height, abs, source: planCutState.source, storeyId: params.storeyId });
},


/**
 * Storey-aware plan cut: isolates a storey and sets a plan cut at a
 * fraction of its bounding-box height (default 1.2 m above floor, or
 * 40% up the storey if storey is shorter than 3 m).
 * This is the preferred way to get a CAD-style floor-plan view.
 */
async setStoreyPlanCut(params: {
  storeyId: string;
  offsetFromFloor?: number;  // metres above floor, default 1.2
  mode?: "WORLD_UP" | "CAMERA";
}) {
  const storeyId = params.storeyId;
  const mode = params.mode ?? "WORLD_UP";
  const levels = (ctx as any).classifier?.list?.get?.("Levels");
  const entry = levels?.get?.(String(storeyId));
  const map = entry?.get ? await entry.get() : null;
  const highlightedIds = getActiveHighlightObjectIds();
  const highlightedMap = highlightedIds.length ? buildModelIdMapFromObjectIds(highlightedIds) : null;
  const highlightBox = highlightedMap ? await this.getSelectionWorldBox(highlightedMap) : null;
  const box = map ? await this.getSelectionWorldBox(map) : null;
  const upAxis = getUpAxis();
  let abs: number | null = null;

  if (highlightBox && !highlightBox.isEmpty()) {
    const highlightTop = upAxis === "y" ? highlightBox.max.y : highlightBox.max.z;
    const highlightMin = upAxis === "y" ? highlightBox.min.y : highlightBox.min.z;
    const height = Math.max(0.02, highlightTop - highlightMin);
    abs = highlightTop + Math.max(0.01, height * 0.02);
  }

  if (abs == null && box && !box.isEmpty()) {
    const minH = upAxis === "y" ? box.min.y : box.min.z;
    const maxH = upAxis === "y" ? box.max.y : box.max.z;
    const storeyHeight = maxH - minH;

    // Determine absolute cut height
    let offset = params.offsetFromFloor ?? 1.2;
    // If storey is short, use proportional cut (40% up)
    if (storeyHeight < 3.0 || offset > storeyHeight * 0.8) {
      offset = storeyHeight * 0.4;
    }
    abs = minH + offset;
  }

  if (abs == null) {
    const pose = await this.getCameraPose();
    abs = (upAxis === "y" ? pose.target.y : pose.target.z) + (params.offsetFromFloor ?? 1.2);
  }

  await restoreFullModelVisibilityPreserveHighlight();
  await this.setPlanCut({
    absoluteHeight: abs,
    mode,
    source: highlightBox && !highlightBox.isEmpty() ? "highlight-top" : "absolute",
    storeyId,
  });

  if (highlightedIds.length) {
    await this.highlightIds(highlightedIds, "primary");
  }

  console.log("[setStoreyPlanCut]", { storeyId, mode, absoluteHeight: abs, highlightedIds: highlightedIds.length });
},

async clearPlanCut() {
  planCutState = { enabled: false, planes: [] };
  clearClippingPlanes();
  fragments.core.update(true);
  world.renderer.three.render(world.scene.three, world.camera.three);
},

getPlanCutState() {
  return planCutState.enabled
    ? {
        enabled: true,
        planes: planCutState.planes.length,
        absoluteHeight: planCutState.absoluteHeight,
        mode: planCutState.mode,
        source: planCutState.source,
        storeyId: planCutState.storeyId,
      }
    : { enabled: false, planes: 0 };
},


async hideCategory(category: string): Promise<boolean> {
  const modelKey = getActiveModelId();
  if (!modelKey) return false;

  const listAny: any = (fragments as any).list;
  const group = typeof listAny?.get === "function" ? listAny.get(modelKey) : listAny?.[modelKey];
  if (!group?.getItemsOfCategories) return false;

  const norm = normalizeIfcCategory(category);
  if (!norm) return false;

  const re = new RegExp(`^${norm}$`, "i");

  let out: any;
  try {
    out = await group.getItemsOfCategories([re]);
  } catch (e) {
    console.warn("[viewerApi] hideCategory: getItemsOfCategories threw", e);
    return false;
  }

  const ids = extractNumericIdsFromUnknown(out, norm);
  if (!ids?.length) return false;

  const map: OBC.ModelIdMap = { [modelKey]: new Set(ids) };

  // track hidden for evidence (if you added hidden tracking earlier)
  for (const id of ids) ensureHiddenSet(modelKey).add(id);

  await hider.set(false, map);
  fragments.core.update(true);
  world.renderer.three.render(world.scene.three, world.camera.three);
  return true;
},

async showCategory(category: string): Promise<boolean> {
  const modelKey = getActiveModelId();
  if (!modelKey) return false;

  const listAny: any = (fragments as any).list;
  const group = typeof listAny?.get === "function" ? listAny.get(modelKey) : listAny?.[modelKey];
  if (!group?.getItemsOfCategories) return false;

  const norm = normalizeIfcCategory(category);
  if (!norm) return false;

  const re = new RegExp(`^${norm}$`, "i");

  let out: any;
  try {
    out = await group.getItemsOfCategories([re]);
  } catch (e) {
    console.warn("[viewerApi] showCategory: getItemsOfCategories threw", e);
    return false;
  }

  const ids = extractNumericIdsFromUnknown(out, norm);
  if (!ids?.length) return false;

  const map: OBC.ModelIdMap = { [modelKey]: new Set(ids) };

  const hs = (hiddenMapByModel as any)?.[modelKey] as Set<number> | undefined;
  if (hs) for (const id of ids) hs.delete(id);

  await hider.set(true, map);
  fragments.core.update(true);
  world.renderer.three.render(world.scene.three, world.camera.three);
  return true;
},


    async hideIds(ids: string[]) {
      const activeModelId = getActiveModelId();
      if (!activeModelId) return;

      // Build a ModelIdMap grouped by model
      const map: OBC.ModelIdMap = {};
      for (const raw of ids ?? []) {
        const parsed = parseObjectId(raw);
        if (!parsed) continue;
        (map[parsed.modelId] ??= new Set<number>()).add(parsed.localId);
        ensureHiddenSet(parsed.modelId).add(parsed.localId);
      }

      // Nothing to hide
      if (Object.keys(map).length === 0) return;

      // Hide just these items
      await hider.set(false, map); // <- This is the intended usage. :contentReference[oaicite:1]{index=1}
      fragments.core.update(true);
    },

    async showIds(ids: string[]) {
      const map: OBC.ModelIdMap = {};
      for (const raw of ids ?? []) {
        const parsed = parseObjectId(raw);
        if (!parsed) continue;
        (map[parsed.modelId] ??= new Set<number>()).add(parsed.localId);

        const s = hiddenMapByModel[parsed.modelId];
        if (s) s.delete(parsed.localId);
      }

      if (Object.keys(map).length === 0) return;

      // Show just these items (inverse of hide)
      await hider.set(true, map);
      fragments.core.update(true);
    },

    async getHiddenIds(): Promise<string[]> {
      // Return canonical "modelId:localId" strings (stable & multi-model safe)
      const out: string[] = [];
      const modelIds = Object.keys(hiddenMapByModel).sort();
      for (const mid of modelIds) {
        const ids = Array.from(hiddenMapByModel[mid] ?? []).filter(Number.isFinite).sort((a, b) => a - b);
        for (const localId of ids) out.push(toObjectId(mid, localId));
      }
      return out;
    },

async highlightIds(ids: string[], style?: "primary" | "warn") {
  const modelId = getActiveModelId();
  if (!modelId) return;

  const group = getActiveGroupAny();
  const controller = findHighlightController(getComponentsAny());
  if (!group && !controller) return;

  // reset previous highlights
  try {
    if (controller && typeof controller.resetHighlight === "function") {
      await controller.resetHighlight();
    } else if (group && typeof group.resetHighlight === "function") {
      await group.resetHighlight();
    }
  } catch {
    // no-op
  }

  // Convert objectIds to local numeric ids
  const localIds: number[] = [];
  for (const raw of ids ?? []) {
    const parsed = parseObjectId(raw);
    if (!parsed) continue;
    if (parsed.modelId !== modelId) continue;
    localIds.push(parsed.localId);
  }
  if (!localIds.length) {
    activeHighlightState = null;
    clearAllHighlightOverlays();
    return;
  }

  const map = buildModelIdMapFromObjectIds(ids);
  const baseMaterial = pickHighlightMaterial(style);
  const highlightDefinition: any = {
    color: baseMaterial.color.clone(),
    renderedFaces: 1,
    opacity: Math.max(0.4, Math.min(0.92, baseMaterial.opacity ?? 0.82)),
    transparent: true,
    depthTest: false,
    customId: `semantic-highlight-${style ?? "primary"}`,
  };

  let nativeHighlightApplied = false;
  if (controller && typeof controller.highlight === "function") {
    try {
      await controller.highlight(highlightDefinition, map);
      nativeHighlightApplied = true;
    } catch {
      nativeHighlightApplied = false;
    }
  }

  if (!nativeHighlightApplied && group && typeof group.highlight === "function") {
    try {
      await group.highlight(localIds, highlightDefinition);
    } catch {
      try {
        await group.highlight(localIds);
      } catch {
        // overlay fallback below still runs
      }
    }
  }

  await drawSemanticHighlightOverlays(modelId, localIds, style);
  await ensurePlanCutContainsActiveHighlight(this);
  
  fragments.core.update(true);
  world.renderer.three.render(world.scene.three, world.camera.three);
},


async pickObjectAt(x: number, y: number): Promise<string | null> {
  const modelId = getActiveModelId();
  if (!modelId) return null;
  const group = getActiveGroupAny();

  const canvas = world.renderer.three.domElement;
  const rect = canvas.getBoundingClientRect();

  // Convert to normalized device coords
  const nx = (x / rect.width) * 2 - 1;
  const ny = -(y / rect.height) * 2 + 1;
  const ndc = new THREE.Vector2(nx, ny);

  const resolveThreeCamera = (): THREE.Camera | null => {
    const candidates: any[] = [
      (world as any)?.camera?.three,
      (world as any)?.camera?.camera,
      (world as any)?.camera?.controls?.camera,
    ];
    for (const c of candidates) {
      if (!c) continue;
      if (c.isCamera === true) return c as THREE.Camera;
      if (typeof c.updateProjectionMatrix === "function" && c.matrixWorld && c.projectionMatrix) {
        return c as THREE.Camera;
      }
    }
    return null;
  };

  const model = getActiveModel();
  const root = model?.object;
  if (!root) return null;
  const threeCamera = resolveThreeCamera();
  if (!threeCamera) {
    console.warn("[viewerApi] pickObjectAt: no valid THREE camera available");
    return null;
  }

  const raycaster = new THREE.Raycaster();
  try {
    raycaster.setFromCamera(ndc, threeCamera);
  } catch (err) {
    console.warn("[viewerApi] pickObjectAt: setFromCamera failed", err);
    return null;
  }

  // Prefer modern fragments raycast API when available:
  // group.raycast({ camera, mouse, dom }) -> { localId, ... }
  if (group && typeof group.raycast === "function") {
    const candidates = [new THREE.Vector2(x, y), ndc];
    for (const mouse of candidates) {
      try {
        const hit: any = await Promise.resolve(
          group.raycast({
            camera: threeCamera,
            mouse,
            dom: canvas,
          })
        );
        const localId =
          (typeof hit?.localId === "number" ? hit.localId : null) ??
          (typeof hit?.itemId === "number" ? hit.itemId : null) ??
          (typeof hit?.id === "number" ? hit.id : null);
        if (localId != null && isFinite(localId)) {
          const objectId = `${modelId}:${localId}`;
          lastPickedObjectId = objectId;
          return objectId;
        }
      } catch (err) {
        console.warn("[viewerApi] pickObjectAt: group.raycast(data) failed", err);
      }
    }
  }

  // Fallback: traverse meshes with THREE.Raycaster.
  const intersections: THREE.Intersection[] = [];
  // Safer than one deep call: traverse meshes and ignore malformed geometry errors.
  root.traverse((obj: any) => {
    if (!obj?.isMesh) return;
    try {
      const hits = raycaster.intersectObject(obj, false);
      if (hits?.length) intersections.push(...hits);
    } catch {
      // ignore broken buffers/attributes from specific meshes
    }
  });

  intersections.sort((a, b) => a.distance - b.distance);
  for (const hit of intersections) {
    const localId = extractLocalIdFromIntersection(hit);
    if (localId == null) continue;
    const objectId = `${modelId}:${localId}`;
    lastPickedObjectId = objectId;
    return objectId;  
}

  return null;
},


        async getProperties(objectId: string): Promise<Record<string, unknown> | null> {
      const parsed = parseObjectId(objectId);
      if (!parsed) return null;

      // Current implementation only supports active model properties reliably.
      const active = getActiveModelId();
      if (!active || parsed.modelId !== active) return null;

      const props = await this.getElementProperties(parsed.localId);
      return (props ?? null) as any;
    },

async hideSelected(): Promise<void> {
  if (!lastPickedObjectId) return;
  await this.hideIds([lastPickedObjectId]);
},

        getLastPickedObjectId(): string | null {
      return lastPickedObjectId;
    },

__debug: {
  getActiveModelKeys: () => Object.keys((getActiveModel() as any) || {}),
  getActiveModel: () => getActiveModel(),
  getFragmentsKeys: () => Object.keys((fragments as any) || {}),
  getFragmentsCoreKeys: () => Object.keys(((fragments as any)?._core) || {}),
  getFragmentsComponentsKeys: () => Object.keys(((fragments as any)?.components) || {}),
getFragmentsListKeys: () => {
  const l: any = (fragments as any).list;
  if (!l) return [];
  // Map keys if possible
  if (typeof l.keys === "function") return Array.from(l.keys());
  return Object.getOwnPropertyNames(l);
},
getActiveFragmentsGroupKeys: () => {
  const modelKey = getActiveModelId();
  const l: any = (fragments as any).list;
  const g = modelKey && typeof l?.get === "function" ? l.get(modelKey) : null;
  if (!g) return [];
  return Object.getOwnPropertyNames(g).sort();
},
getActiveFragmentsGroupProtoKeys: () => {
  const modelKey = getActiveModelId();
  const l: any = (fragments as any).list;
  const g = modelKey && typeof l?.get === "function" ? l.get(modelKey) : null;
  if (!g) return [];
  return Object.getOwnPropertyNames(Object.getPrototypeOf(g) || {}).sort();
},
sampleGroupProperties: () => {
  const modelKey = getActiveModelId();
  const l: any = (fragments as any).list;
  const g = modelKey && typeof l?.get === "function" ? l.get(modelKey) : null;
  const pm: any = g?.properties;
  if (!pm?.entries) return null;
  const it = pm.entries();
  const first = it.next();
  if (first.done) return null;
  const [k, v] = first.value;
  return { keyType: typeof k, key: k, value: v };
},
getGroupCategories: () => {
  const modelKey = getActiveModelId();
  const listAny: any = (fragments as any).list;
  const group = modelKey && typeof listAny?.get === "function" ? listAny.get(modelKey) : null;
  if (!group) return [];
  if (typeof group.getCategories === "function") {
    try { return group.getCategories(); } catch { return []; }
  }
  return [];
},
sampleCategoryCount: (cat: string) => {
  const modelKey = getActiveModelId();
  const listAny: any = (fragments as any).list;
  const group = modelKey && typeof listAny?.get === "function" ? listAny.get(modelKey) : null;
  if (!group) return { ok: false, reason: "no-group" };

  const norm = String(cat).trim().toUpperCase();

  if (typeof group.getItemsOfCategories !== "function") {
    return { ok: false, reason: "no-getItemsOfCategories" };
  }

  try {
    const re = new RegExp(`^${norm}$`, "i");
    out = group.getItemsOfCategories([re]);


    const asArray = Array.isArray(out)
      ? out
      : out instanceof Set
        ? Array.from(out)
        : typeof out?.get === "function"
          ? (out.get(norm) ?? out.get(norm.toLowerCase()) ?? out.get(norm.toUpperCase()) ?? [])
          : (out?.[norm] ?? out?.[norm.toLowerCase()] ?? out?.[norm.toUpperCase()] ?? []);

    return { ok: true, norm, count: Array.isArray(asArray) ? asArray.length : 0, outKind: Object.prototype.toString.call(out) };
  } catch (e: any) {
    return { ok: false, norm, reason: String(e?.message ?? e) };
  }
},

dumpItemsOfCategories: async (cat: string) =>{
  const modelKey = getActiveModelId();
  const listAny: any = (fragments as any).list;
  const group = modelKey && typeof listAny?.get === "function" ? listAny.get(modelKey) : null;
  if (!group?.getItemsOfCategories) return { ok: false, reason: "no-getItemsOfCategories" };

  const norm = String(cat).trim().toUpperCase();
  const re = new RegExp(`^${norm}$`, "i");
  const out = await group.getItemsOfCategories([re]);



  return {
    ok: true,
    norm,
    outInfo: debugDescribeOut(out),
    // show a small sample deterministically (won’t blow up console)
    sampleIds: (extractNumericIdsFromUnknown(out, norm) ?? []).slice(0, 20),
  };
},




},



        getCurrentIsolateSelection(): OBC.ModelIdMap | null {
      return lastIsolateMap ? cloneModelIdMap(lastIsolateMap) : null;
    },


    /**
     * Compute a world-space bounding box for a selection.
     * If the library provides a direct method, use it.
     * Otherwise: fallback to model bounds (still useful for early PoC navigation).
     */
    async getSelectionWorldBox(map: OBC.ModelIdMap): Promise<THREE.Box3 | null> {
      const model = getActiveModel();
      if (!model?.object) return null;

      const union = new THREE.Box3();
      let hasSelectionBox = false;
      const modelIds = Object.keys(map ?? {}).sort();
      for (const modelId of modelIds) {
        const localIds = Array.from(map[modelId] ?? [])
          .filter((id) => typeof id === "number" && isFinite(id))
          .sort((a, b) => a - b);
        if (!localIds.length) continue;

        const boxes = await getBoxesForLocalIds(modelId, localIds);
        for (const box of boxes) {
          if (!box?.isBox3 || box.isEmpty()) continue;
          union.union(box);
          hasSelectionBox = true;
        }

        const meshes = await getMeshesForLocalIds(modelId, localIds);
        for (const mesh of meshes) {
          const meshBox = new THREE.Box3().setFromObject(mesh);
          if (meshBox.isEmpty()) continue;
          union.union(meshBox);
          hasSelectionBox = true;
        }
      }

      if (hasSelectionBox && !union.isEmpty()) {
        return union;
      }

      // Try common OBC/fragments helpers if they exist (version differences)
      const f: any = fragments as any;

      // 1) If fragments provides something like getBoundingBox(map)
      if (typeof f.getBoundingBox === "function") {
        try {
          const b = await f.getBoundingBox(map);
          if (b && b.isBox3 && !b.isEmpty()) return b as THREE.Box3;
        } catch {}
      }

      // 2) If model provides a selection bbox helper
      if (typeof (model as any).getBoundingBox === "function") {
        try {
          const b = await (model as any).getBoundingBox(map);
          if (b && b.isBox3 && !b.isEmpty()) return b as THREE.Box3;
        } catch {}
      }

      // 3) Fallback: model bounds (not selection-specific, but prevents null)
      const box = new THREE.Box3().setFromObject(model.object);
      if (box.isEmpty()) return null;
      return box;
    },

    async getDoorClearanceFocusBox(ids?: string[]): Promise<THREE.Box3 | null> {
      const modelId = getActiveModelId();
      if (!modelId) return null;

      let targetEntry = activeHighlightState?.entries.length === 1 ? activeHighlightState.entries[0] : null;
      if (ids?.length) {
        const wanted = new Set(ids.map((id) => String(id)));
        const localIds: number[] = [];
        for (const raw of ids) {
          const parsed = parseObjectId(raw);
          if (!parsed || parsed.modelId !== modelId) continue;
          localIds.push(parsed.localId);
        }
        if (localIds.length === 1) {
          const overlays = await resolveHighlightOverlayEntries(modelId, localIds);
          const candidate = overlays[0];
          if (candidate && wanted.has(`${modelId}:${candidate.localId}`)) {
            targetEntry = candidate;
          }
        }
      }

      if (!targetEntry || String(targetEntry.ifcClass ?? "").toUpperCase() !== "IFCDOOR") {
        return null;
      }

      return buildDoorClearanceFocusBox(targetEntry);
    },

async getSelectionMeshes(map: OBC.ModelIdMap): Promise<THREE.Object3D[]> {
  const modelKey = Object.keys(map ?? {})[0];
  if (!modelKey) return [];

  const ids = Array.from(map[modelKey] ?? []);
  if (!ids.length) return [];

  const listAny: any = (fragments as any).list;
  const group = typeof listAny?.get === "function" ? listAny.get(modelKey) : listAny?.[modelKey];
  if (!group) return [];

  const out: THREE.Object3D[] = [];
  const seen = new Set<string>();

  // Prefer batch method if available
  if (typeof group.getMeshesByItems === "function") {
    const meshes: THREE.Object3D[] = await group.getMeshesByItems(ids);
    for (const m of meshes ?? []) {
      if (!m) continue;
      if (!seen.has(m.uuid)) {
        seen.add(m.uuid);
        out.push(m);
      }
    }
    return out;
  }

  // Fallback: per-item
  if (typeof group.getMeshesByItem === "function") {
    for (const id of ids) {
      const meshes: THREE.Object3D[] = await group.getMeshesByItem(id);
      for (const m of meshes ?? []) {
        if (!m) continue;
        if (!seen.has(m.uuid)) {
          seen.add(m.uuid);
          out.push(m);
        }
      }
    }
    return out;
  }

  return [];
},

async getSnapshot(opts?: { note?: string }): Promise<ViewerSnapshot> {
  // 1) Ensure fragments update (geometry + visibility state)
  await stabilizeSceneForSnapshot();
  fragments.core.update(true);

  if (activeHighlightState) {
    renderHighlightOverlayEntries(activeHighlightState.entries, activeHighlightState.style);
  }

  // 2) Wait for browser to paint at least once
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  await new Promise<void>((r) => requestAnimationFrame(() => r()));

  // 3) Force render before readback
  world.renderer.three.render(world.scene.three, world.camera.three);

  const canvas = world.renderer.three.domElement;
  const dataUrl = canvas.toDataURL("image/png");
  const rawImageBase64Png = dataUrl.startsWith("data:image/")
    ? (dataUrl.split(",")[1] ?? "")
    : dataUrl;
  const imageBase64Png = await composeSnapshotWithHud(rawImageBase64Png);

  const pose = await this.getCameraPose();

  return {
    imageBase64Png,
    pose,
    meta: {
      timestampIso: new Date().toISOString(),
      modelId: getActiveModelId(),
      note: opts?.note,
      context: getHighlightAnnotationContext(),
    },
  };
},

async stabilizeForSnapshot(): Promise<void> {
  await stabilizeSceneForSnapshot();
},

getGridReference(): ViewerGridReference {
  return VIEWER_GRID_REFERENCE;
},

async getElementProperties(localId: number): Promise<Record<string, any> | null> {
  const model = getActiveModel();
  if (!model) return null;

  try {
    if (typeof model.getProperties === "function") {
      return await model.getProperties(localId);
    }
    return null;
  } catch {
    return null;
  }
},
  };
}
