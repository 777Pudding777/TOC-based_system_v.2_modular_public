/**
 * src/storage/dbConfig.ts
 * Shared IndexedDB configuration for all stores.
 * Single source of truth for database name and version.
 *
 * @module dbConfig
 */

export const DB_NAME = "toc_based_system_db";
export const DB_VERSION = 3; // v3: unified version across all stores

export const STORE_DECISIONS = "decisions";
export const STORE_RULES = "rules";
export const STORE_RULE_META = "rule_metadata";
export const STORE_TRACES = "traces";

/**
 * Delete the entire database (used for recovery from version mismatch).
 */
export function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => {
      console.warn("[DB] deleteDatabase blocked — close all tabs and retry.");
      resolve(); // Don't block the flow
    };
  });
}

/**
 * Opens the shared IndexedDB database, creating/upgrading all stores.
 * All modules should use this single openDb to avoid version conflicts.
 */
export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      // Decisions store (complianceDb)
      if (!db.objectStoreNames.contains(STORE_DECISIONS)) {
        const store = db.createObjectStore(STORE_DECISIONS, { keyPath: "decisionId" });
        store.createIndex("byRunId", "runId", { unique: false });
        store.createIndex("byRunIdAndTime", ["runId", "timestampIso"], { unique: false });
      }

      // Rules store (ruleDb)
      if (!db.objectStoreNames.contains(STORE_RULES)) {
        const store = db.createObjectStore(STORE_RULES, { keyPath: "id" });
        store.createIndex("byCategory", "category", { unique: false });
        store.createIndex("bySeverity", "severity", { unique: false });
        store.createIndex("byEnabled", "enabled", { unique: false });
      }

      // Rule metadata store
      if (!db.objectStoreNames.contains(STORE_RULE_META)) {
        db.createObjectStore(STORE_RULE_META, { keyPath: "key" });
      }

      // Traces store (traceDb)
      if (!db.objectStoreNames.contains(STORE_TRACES)) {
        const store = db.createObjectStore(STORE_TRACES, { keyPath: "traceId" });
        store.createIndex("byRunId", "runId", { unique: false });
        store.createIndex("byTimestamp", "startedAt", { unique: false });
        store.createIndex("byStatus", "status", { unique: false });
        store.createIndex("byRuleId", "rule.id", { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Wait for an IDB transaction to complete.
 */
export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
