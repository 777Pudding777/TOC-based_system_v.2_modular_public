// src/modules/snapshotCollector.ts
// Module to capture and store viewer snapshots with metadata for navigation agents.

import type { ViewerSnapshot } from "../viewer/api";
import { createSnapshotDb } from "../storage/snapshotDb";

/**
 * Snapshot capture modes.
 * Only PURE_RENDER + JSON_METADATA are fully implemented in PoC.
 * Overlay capture needs dedicated rendering or DOM capture (html2canvas),
 * Playwright belongs to an external controller architecture.
 */
export type SnapshotMode =
  | "PURE_RENDER"
  | "RENDER_PLUS_OVERLAY_2D"
  | "RENDER_PLUS_JSON_METADATA"
  | "MULTI_VIEW_BUNDLE";

/**
 * Stable artifact schema:
 * Keep this stable even if capture implementation changes later.
 * The whole point is: downstream modules (reporter, VLM checker) consume this schema.
 */
export type SnapshotArtifact = {
  id: string;
  mode: SnapshotMode;

  images: Array<{
    label: string; // "render", "wide", "close", ...
    imageBase64Png: string;
  }>;

  meta: {
    timestampIso: string;
    modelId: string | null;

    camera: ViewerSnapshot["pose"];

    visibility?: {
      mode: "all" | "isolate" | "unknown";
      visibleElementCount?: number;
    };

    contextPath?: string[];
    note?: string;
  };
};

export type SnapshotRun = {
  runId: string;
  startedIso: string;
  artifacts: SnapshotArtifact[];
};

export type SnapshotStore = {
  add: (artifact: SnapshotArtifact) => void;
  list: () => SnapshotArtifact[];
  clear: () => void;
};

/**
 * In-memory store is still useful:
 * - fast access for UI previews
 * - does not require reading back from IndexedDB
 *
 * Critical: this is not the "source of truth" once persistence is enabled.
 * It's just a convenience cache.
 */
export function createInMemorySnapshotStore(): SnapshotStore {
  const artifacts: SnapshotArtifact[] = [];
  return {
    add: (a) => artifacts.push(a),
    list: () => [...artifacts],
    clear: () => {
      artifacts.length = 0;
    },
  };
}

type ToastFn = (msg: string, ms?: number) => void;

/**
 * Visibility state interface expected from viewerApi.
 * You will implement viewerApi.getVisibilityState() accordingly.
 */
type VisibilityState = {
  mode: "all" | "isolate";
  lastIsolateCount?: number;
};

export function createSnapshotCollector(params: {
  viewerApi: {
    onModelLoaded: (cb: (p: { modelId: string; model: any }) => void) => () => void;
    
    getSnapshot: (opts?: { note?: string }) => Promise<ViewerSnapshot>;
    setCameraPose: (pose: ViewerSnapshot["pose"], smooth?: boolean) => Promise<void>;

    /**
     * New: provides current visibility context (all vs isolate).
     * This is essential metadata because it changes what the VLM "sees".
     */
    getVisibilityState?: () => VisibilityState;
  };

  /**
   * In-memory store for quick local access (optional).
   * Persistence is handled separately by IndexedDB.
   */
  store?: SnapshotStore;

  toast?: ToastFn;

  defaultMode?: SnapshotMode;
  autoCaptureOnModelLoad?: boolean;

  /**
   * Persist snapshots to IndexedDB.
   * Default true because you explicitly asked for local consistency.
   *
   * Critical: even if persistence is enabled, capture should still work if DB fails.
   */
  persistToIndexedDb?: boolean;
}) {
  const {
    viewerApi,
    toast,
    store = createInMemorySnapshotStore(),
    defaultMode = "RENDER_PLUS_JSON_METADATA",
    autoCaptureOnModelLoad = true,
    persistToIndexedDb = true,
  } = params;

  // IndexedDB adapter (only used if persistToIndexedDb true)
  const snapshotDb = createSnapshotDb();

let run: SnapshotRun = {
  runId: crypto.randomUUID(),
  startedIso: new Date().toISOString(),
  artifacts: [],
};


  // Ensure we only "register" this run once in the DB
  let runEnsured = false;

  function getVisibilityMeta(): SnapshotArtifact["meta"]["visibility"] {
    const vis = viewerApi.getVisibilityState?.();
    if (!vis) return { mode: "unknown" };

    if (vis.mode === "all") return { mode: "all" };
    return { mode: "isolate", visibleElementCount: vis.lastIsolateCount };
  }

  function makeId() {
    return `snap_${run.artifacts.length + 1}_${Date.now()}`;
  }

  /**
   * Persist asynchronously so we don't block UI.
   * Critical assessment:
   * - DB writes can be slow (especially with big images).
   * - Fire-and-forget is best for interactive UX.
   * - For strict experimental pipelines, you can later add a "awaitPersist" flag.
   */
  function persistArtifactAsync(artifact: SnapshotArtifact) {
    if (!persistToIndexedDb) return;

    // Ensure run exists in DB
    if (!runEnsured) {
      runEnsured = true;
      snapshotDb
        .ensureRun({ runId: run.runId, startedIso: run.startedIso })
        .catch((err) => {
          console.error("[SnapshotCollector] ensureRun failed", err);
          toast?.("Snapshot DB init failed (see console).");
        });
    }

    snapshotDb.saveArtifact(run.runId, artifact).catch((err) => {
      console.error("[SnapshotCollector] saveArtifact failed", err);
      toast?.("Snapshot persist failed (see console).");
    });
  }

  function addArtifact(a: SnapshotArtifact) {
    run.artifacts.push(a);
    store.add(a);
    persistArtifactAsync(a);
  }

  /**
   * Multi-view bundle:
   * - wide: current view
   * - close: eye moves 15% toward target (simple "zoom")
   *
   * Critical assessment:
   * - This is viewpoint-only, not target-aware.
   * - Still valuable because it reduces navigation loops later.
   * - Replace later with navigation-derived viewpoints (best).
   */
  async function captureMultiView(note?: string): Promise<SnapshotArtifact> {
    const nowIso = new Date().toISOString();
    const visibility = getVisibilityMeta();

    const wide = await viewerApi.getSnapshot({ note: note ? `${note} (wide)` : "wide" });

    const eye = wide.pose.eye;
    const target = wide.pose.target;

    const dx = target.x - eye.x;
    const dy = target.y - eye.y;
    const dz = target.z - eye.z;

    const closePose = {
      eye: { x: eye.x + dx * 0.15, y: eye.y + dy * 0.15, z: eye.z + dz * 0.15 },
      target: { ...target },
    };

    await viewerApi.setCameraPose(closePose, true);

    const close = await viewerApi.getSnapshot({ note: note ? `${note} (close)` : "close" });

    return {
      id: makeId(),
      mode: "MULTI_VIEW_BUNDLE",
      images: [
        { label: "wide", imageBase64Png: wide.imageBase64Png },
        { label: "close", imageBase64Png: close.imageBase64Png },
      ],
      meta: {
        timestampIso: nowIso,
        modelId: wide.meta.modelId,
        camera: wide.pose, // store wide pose as primary; can extend later
        visibility,
        contextPath: [],
        note,
      },
    };
  }

  async function capture(note?: string, mode: SnapshotMode = defaultMode): Promise<SnapshotArtifact> {
    if (mode === "MULTI_VIEW_BUNDLE") {
      const a = await captureMultiView(note);
      addArtifact(a);
      toast?.(`Snapshot bundle captured (${run.artifacts.length})`);
      return a;
    }

    const nowIso = new Date().toISOString();
    const visibility = getVisibilityMeta();

    const snap = await viewerApi.getSnapshot({ note });

    const artifact: SnapshotArtifact = {
      id: makeId(),
      mode,
      images: [{ label: "render", imageBase64Png: snap.imageBase64Png }],
      meta: {
        timestampIso: nowIso,
        modelId: snap.meta.modelId,
        camera: snap.pose,
        visibility,
        contextPath: [],
        note,
      },
    };

    addArtifact(artifact);
    toast?.(`Snapshot captured (${run.artifacts.length})`);
    return artifact;
  }

  let unsub: (() => void) | null = null;

  function start() {
    if (unsub) return;

    // Ensure run is created early so the DB has a stable run bucket
    if (persistToIndexedDb && !runEnsured) {
      runEnsured = true;
      snapshotDb
        .ensureRun({ runId: run.runId, startedIso: run.startedIso })
        .catch((err) => {
          console.error("[SnapshotCollector] ensureRun failed", err);
          toast?.("Snapshot DB init failed (see console).");
        });
    }

    unsub = viewerApi.onModelLoaded(async () => {
      if (!autoCaptureOnModelLoad) return;

      try {
        // Wait a couple frames so the model is truly visible
await new Promise<void>((r) => requestAnimationFrame(() => r()));
await new Promise<void>((r) => requestAnimationFrame(() => r()));

await capture("modelLoaded", "RENDER_PLUS_JSON_METADATA");

      } catch (err) {
        console.error("[SnapshotCollector] auto capture failed", err);
        toast?.("Snapshot auto-capture failed (see console).");
      }
    });
  }

  function stop() {
    unsub?.();
    unsub = null;
  }

  function getRun(): SnapshotRun {
    return { ...run, artifacts: [...run.artifacts] };
  }

async function reset(): Promise<void> {
  // new run object
  run = {
    runId: crypto.randomUUID(),
    startedIso: new Date().toISOString(),
    artifacts: [],
  };

  // clear in-memory cache
  store.clear();

  // force DB run re-creation
  runEnsured = false;

  if (persistToIndexedDb) {
    runEnsured = true;
    await snapshotDb.ensureRun({ runId: run.runId, startedIso: run.startedIso });
  }
}



  return {
    start,
    stop,
    capture,
    getRun,
    store,

    /**
     * Expose db for debugging / future reporter module.
     * Critical: this is optional; remove if you want strict encapsulation.
     * For rapid iteration, it's useful.
     */
    db: persistToIndexedDb ? snapshotDb : null,
    reset,
  };
}
