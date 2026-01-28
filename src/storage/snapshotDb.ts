// src/storage/snapshotDb.ts

import type { SnapshotArtifact } from "../modules/snapshotCollector";

/**
 * IndexedDB-based storage for snapshot runs and artifacts.
 *
 * Critical assessment:
 * - IndexedDB is the only browser-native storage suitable for many images.
 * - We store images as Blob (not base64) to reduce size and speed up.
 * - We also store a JSON-friendly version of meta for easy retrieval.
 *
 * Future rewrite friendliness:
 * - All DB logic is in this file.
 * - SnapshotCollector just calls store.saveArtifact().
 */

export type StoredRun = {
  runId: string;
  startedIso: string;
};

export type StoredArtifactIndex = {
  runId: string;
  artifactId: string;
  timestampIso: string;
  mode: string;
  note?: string;
};

type DbSchema = {
  runs: StoredRun;
  artifacts: StoredArtifactIndex & {
    artifact: SnapshotArtifact; // full artifact but with imageBase64 replaced or kept? see below
  };
  images: {
    artifactId: string;
    label: string;
    blob: Blob;
  };
};

const DB_NAME = "bim-snapshot-store";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      // runs: key = runId
      if (!db.objectStoreNames.contains("runs")) {
        db.createObjectStore("runs", { keyPath: "runId" });
      }

      // artifacts: key = artifactId, index by runId
      if (!db.objectStoreNames.contains("artifacts")) {
        const store = db.createObjectStore("artifacts", { keyPath: "artifactId" });
        store.createIndex("byRunId", "runId", { unique: false });
        store.createIndex("byTimestamp", "timestampIso", { unique: false });
      }

      // images: key = `${artifactId}:${label}`
      if (!db.objectStoreNames.contains("images")) {
        const store = db.createObjectStore("images", { keyPath: "key" });
        store.createIndex("byArtifactId", "artifactId", { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  db: IDBDatabase,
  storeNames: string[],
  mode: IDBTransactionMode,
  fn: (stores: Record<string, IDBObjectStore>) => Promise<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeNames, mode);
    const stores: Record<string, IDBObjectStore> = {};
    for (const name of storeNames) stores[name] = transaction.objectStore(name);

    transaction.oncomplete = () => {};
    transaction.onerror = () => reject(transaction.error);

    fn(stores).then(resolve).catch(reject);
  });
}

/**
 * Helper: base64 PNG -> Blob
 * Critical: base64 is convenient but bulky. Blob is efficient for IndexedDB.
 */
function normalizeToBase64(dataUrlOrBase64: string): string {
  const s = String(dataUrlOrBase64 ?? "").trim();
  if (!s) return "";

  // If it's a data URL: "data:image/png;base64,AAAA..."
  if (s.startsWith("data:image/")) {
    const parts = s.split(",");
    return parts[1] ?? "";
  }

  // Otherwise assume it's already raw base64
  return s;
}

function base64PngToBlob(dataUrlOrBase64: string): Blob {
  const base64 = normalizeToBase64(dataUrlOrBase64);
  if (!base64) return new Blob([], { type: "image/png" });

  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: "image/png" });
}


export function createSnapshotDb() {
  async function ensureRun(run: StoredRun) {
    const db = await openDb();
    await tx(db, ["runs"], "readwrite", async ({ runs }) => {
      runs.put(run);
      return true;
    });
    db.close();
  }

  /**
   * Save artifact:
   * - store artifact index + meta in artifacts store
   * - store each image blob in images store
   *
   * Critical assessment:
   * - We store the full artifact JSON too (minus big images).
   * - Images are stored separately as blobs for efficiency.
   */
  async function saveArtifact(runId: string, artifact: SnapshotArtifact) {
    const db = await openDb();

    // remove base64 from artifact before storing (optional but recommended)
    const artifactWithoutImages: SnapshotArtifact = {
      ...artifact,
      images: artifact.images.map((img) => ({ label: img.label, imageBase64Png: "" })),
    };

    await tx(db, ["artifacts", "images"], "readwrite", async ({ artifacts, images }) => {
      const idx: StoredArtifactIndex & { artifact: SnapshotArtifact } = {
        runId,
        artifactId: artifact.id,
        timestampIso: artifact.meta.timestampIso,
        mode: artifact.mode,
        note: artifact.meta.note,
        artifact: artifactWithoutImages,
      };

      artifacts.put(idx);

      for (const img of artifact.images) {
        const blob = base64PngToBlob(img.imageBase64Png);
        images.put({
          key: `${artifact.id}:${img.label}`,
          artifactId: artifact.id,
          label: img.label,
          blob,
        });
      }

      return true;
    });

    db.close();
  }

  async function listRuns(): Promise<StoredRun[]> {
    const db = await openDb();
    const res = await tx(db, ["runs"], "readonly", async ({ runs }) => {
      return await new Promise<StoredRun[]>((resolve, reject) => {
        const req = runs.getAll();
        req.onsuccess = () => resolve(req.result as StoredRun[]);
        req.onerror = () => reject(req.error);
      });
    });
    db.close();
    return res;
  }

  async function listArtifacts(runId: string): Promise<StoredArtifactIndex[]> {
    const db = await openDb();
    const res = await tx(db, ["artifacts"], "readonly", async ({ artifacts }) => {
      const idx = artifacts.index("byRunId");
      return await new Promise<StoredArtifactIndex[]>((resolve, reject) => {
        const req = idx.getAll(IDBKeyRange.only(runId));
        req.onsuccess = () => resolve(req.result as StoredArtifactIndex[]);
        req.onerror = () => reject(req.error);
      });
    });
    db.close();
    return res;
  }

  async function loadArtifact(artifactId: string): Promise<SnapshotArtifact | null> {
    const db = await openDb();
    const artifactRow = await tx(db, ["artifacts"], "readonly", async ({ artifacts }) => {
      return await new Promise<any>((resolve, reject) => {
        const req = artifacts.get(artifactId);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      });
    });

    if (!artifactRow) {
      db.close();
      return null;
    }

    const imagesRows = await tx(db, ["images"], "readonly", async ({ images }) => {
      const idx = images.index("byArtifactId");
      return await new Promise<any[]>((resolve, reject) => {
        const req = idx.getAll(IDBKeyRange.only(artifactId));
        req.onsuccess = () => resolve(req.result as any[]);
        req.onerror = () => reject(req.error);
      });
    });

    db.close();

    // Re-attach images as base64 data URLs (for display/export)
    const images: SnapshotArtifact["images"] = await Promise.all(
      imagesRows.map(async (row) => {
        const blob: Blob = row.blob;
        const dataUrl = await blobToDataUrl(blob);
        return { label: row.label, imageBase64Png: dataUrl };
      })
    );

    return {
      ...artifactRow.artifact,
      images,
    } as SnapshotArtifact;
  }

  async function clearAll(): Promise<void> {
    const db = await openDb();
    await tx(db, ["runs", "artifacts", "images"], "readwrite", async ({ runs, artifacts, images }) => {
      runs.clear();
      artifacts.clear();
      images.clear();
      return true;
      });
    db.close();
  }


  async function blobToDataUrl(blob: Blob): Promise<string> {
    return await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  return {
    ensureRun,
    saveArtifact,
    listRuns,
    listArtifacts,
    loadArtifact,
    clearAll,
  };
}
