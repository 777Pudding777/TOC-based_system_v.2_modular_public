// src/storage/complianceDb.ts
// IndexedDB storage for compliance checking decisions.
// Uses shared DB config to avoid version conflicts.

import type { VlmDecision } from "../modules/vlmChecker";
import { openDb, txDone, STORE_DECISIONS } from "./dbConfig";

type DecisionRow = {
  runId: string;
  decisionId: string;
  timestampIso: string;
  decision: VlmDecision;
};

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
