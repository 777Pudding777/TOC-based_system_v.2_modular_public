// src/storage/complianceDb.ts
// IndexedDB storage for compliance checking decisions.
// Separate store from snapshots, but same "project/run" concept.
//
// Critical design decisions:
// - One rule per project: decisions are tied to a runId.
// - Store full decision JSON for reproducibility.
// - Use runId + timestampIso indexes so "latest" retrieval is deterministic.

import type { VlmDecision } from "../modules/vlmChecker";

type DecisionRow = {
  runId: string;
  decisionId: string;
  timestampIso: string;
  decision: VlmDecision;
};

// Keep DB name stable
const DB_NAME = "toc_based_system_db";
const DB_VERSION = 1;

const STORE_DECISIONS = "decisions";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains(STORE_DECISIONS)) {
        const store = db.createObjectStore(STORE_DECISIONS, { keyPath: "decisionId" });

        // Indexes for listing by run + ordering
        store.createIndex("byRunId", "runId", { unique: false });
        store.createIndex("byRunIdAndTime", ["runId", "timestampIso"], { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function createComplianceDb() {
  return {
    async saveDecision(runId: string, decision: VlmDecision) {
      const db = await openDb();
      const tx = db.transaction([STORE_DECISIONS], "readwrite");
      const store = tx.objectStore(STORE_DECISIONS);

      const row: DecisionRow = {
        runId,
        decisionId: decision.decisionId,
        timestampIso: decision.timestampIso,
        decision,
      };

      store.put(row);
      await txDone(tx);
      db.close();
    },

    async listDecisions(runId: string): Promise<VlmDecision[]> {
      const db = await openDb();
      const tx = db.transaction([STORE_DECISIONS], "readonly");
      const store = tx.objectStore(STORE_DECISIONS);
      const idx = store.index("byRunId");

      const req = idx.getAll(runId);

      const rows: DecisionRow[] = await new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result as DecisionRow[]);
        req.onerror = () => reject(req.error);
      });

      db.close();

      // Sort deterministically by time
      rows.sort((a, b) => (a.timestampIso < b.timestampIso ? -1 : a.timestampIso > b.timestampIso ? 1 : 0));
      return rows.map((r) => r.decision);
    },

    async clearAll() {
      const db = await openDb();
      const tx = db.transaction([STORE_DECISIONS], "readwrite");
      tx.objectStore(STORE_DECISIONS).clear();
      await txDone(tx);
      db.close();
    },
  };
}
