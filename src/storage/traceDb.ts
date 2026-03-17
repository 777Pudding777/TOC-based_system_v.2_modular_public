/**
 * src/storage/traceDb.ts
 * IndexedDB storage for conversation traces.
 * Uses shared DB config to avoid version conflicts.
 *
 * @module traceDb
 */

import type { ConversationTrace, TraceExport } from "../types/trace.types";
import { openDb, txDone, STORE_TRACES } from "./dbConfig";

/**
 * Creates the trace database interface
 */
export function createTraceDb() {
  return {
    /**
     * Save or update a trace
     */
    async saveTrace(trace: ConversationTrace): Promise<void> {
      const db = await openDb();
      const tx = db.transaction([STORE_TRACES], "readwrite");
      tx.objectStore(STORE_TRACES).put(trace);
      await txDone(tx);
      db.close();
    },

    /**
     * Get a trace by ID
     */
    async getTrace(traceId: string): Promise<ConversationTrace | null> {
      const db = await openDb();
      const tx = db.transaction([STORE_TRACES], "readonly");
      const store = tx.objectStore(STORE_TRACES);
      const req = store.get(traceId);

      return new Promise((resolve, reject) => {
        req.onsuccess = () => {
          db.close();
          resolve(req.result ?? null);
        };
        req.onerror = () => {
          db.close();
          reject(req.error);
        };
      });
    },

    /**
     * Get trace by run ID
     */
    async getTraceByRunId(runId: string): Promise<ConversationTrace | null> {
      const db = await openDb();
      const tx = db.transaction([STORE_TRACES], "readonly");
      const store = tx.objectStore(STORE_TRACES);
      const idx = store.index("byRunId");
      const req = idx.get(runId);

      return new Promise((resolve, reject) => {
        req.onsuccess = () => {
          db.close();
          resolve(req.result ?? null);
        };
        req.onerror = () => {
          db.close();
          reject(req.error);
        };
      });
    },

    /**
     * List all traces
     */
    async listTraces(): Promise<ConversationTrace[]> {
      const db = await openDb();
      const tx = db.transaction([STORE_TRACES], "readonly");
      const store = tx.objectStore(STORE_TRACES);
      const req = store.getAll();

      return new Promise((resolve, reject) => {
        req.onsuccess = () => {
          db.close();
          const traces = req.result as ConversationTrace[];
          traces.sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1));
          resolve(traces);
        };
        req.onerror = () => {
          db.close();
          reject(req.error);
        };
      });
    },

    /**
     * List recent traces (limited)
     */
    async listRecentTraces(limit: number = 10): Promise<ConversationTrace[]> {
      const all = await this.listTraces();
      return all.slice(0, limit);
    },

    /**
     * Delete a trace
     */
    async deleteTrace(traceId: string): Promise<void> {
      const db = await openDb();
      const tx = db.transaction([STORE_TRACES], "readwrite");
      tx.objectStore(STORE_TRACES).delete(traceId);
      await txDone(tx);
      db.close();
    },

    /**
     * Clear all traces
     */
    async clearAll(): Promise<void> {
      const db = await openDb();
      const tx = db.transaction([STORE_TRACES], "readwrite");
      tx.objectStore(STORE_TRACES).clear();
      await txDone(tx);
      db.close();
    },

    /**
     * Export a trace as JSON
     */
    async exportTrace(traceId: string): Promise<TraceExport | null> {
      const trace = await this.getTrace(traceId);
      if (!trace) return null;

      const exportData: TraceExport = {
        version: "1.0.0",
        exportedAt: new Date().toISOString(),
        application: {
          name: "IFC BIM Visual Compliance Checker",
          version: "1.0.0",
        },
        trace,
      };

      return exportData;
    },

    /**
     * Download trace as JSON file
     */
    async downloadTraceAsJson(traceId: string): Promise<boolean> {
      const exportData = await this.exportTrace(traceId);
      if (!exportData) return false;

      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `trace_${traceId.slice(0, 8)}_${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return true;
    },
  };
}

export type TraceDb = ReturnType<typeof createTraceDb>;
