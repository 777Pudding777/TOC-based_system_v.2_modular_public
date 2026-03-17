/**
 * src/storage/ruleDb.ts
 * IndexedDB storage for compliance rules with CRUD operations.
 * Uses shared DB config to avoid version conflicts.
 *
 * @module ruleDb
 */

import type { ComplianceRule, RuleLibrary } from "../types/rule.types";
import { openDb, txDone, STORE_RULES, STORE_RULE_META } from "./dbConfig";

/**
 * Rule metadata stored in IndexedDB
 */
interface RuleMetadata {
  key: "library_metadata";
  version: string;
  lastUpdated: string;
  initialized: boolean;
}

/**
 * Creates the rule database interface with CRUD operations
 */
export function createRuleDb() {
  return {
    /**
     * Check if the rule library has been initialized
     */
    async isInitialized(): Promise<boolean> {
      const db = await openDb();
      const tx = db.transaction([STORE_RULE_META], "readonly");
      const store = tx.objectStore(STORE_RULE_META);
      const req = store.get("library_metadata");

      return new Promise((resolve) => {
        req.onsuccess = () => {
          const meta = req.result as RuleMetadata | undefined;
          db.close();
          resolve(!!meta?.initialized);
        };
        req.onerror = () => {
          db.close();
          resolve(false);
        };
      });
    },

    /**
     * Initialize the rule library from JSON data
     */
    async initializeFromLibrary(library: RuleLibrary): Promise<void> {
      const db = await openDb();
      const tx = db.transaction([STORE_RULES, STORE_RULE_META], "readwrite");
      const ruleStore = tx.objectStore(STORE_RULES);
      const metaStore = tx.objectStore(STORE_RULE_META);

      // Clear existing rules
      ruleStore.clear();

      // Add all rules from library
      for (const rule of library.rules) {
        ruleStore.put(rule);
      }

      // Save metadata
      const meta: RuleMetadata = {
        key: "library_metadata",
        version: library.version,
        lastUpdated: library.lastUpdated,
        initialized: true,
      };
      metaStore.put(meta);

      await txDone(tx);
      db.close();
    },

    /**
     * Get all rules
     */
    async listRules(): Promise<ComplianceRule[]> {
      const db = await openDb();
      const tx = db.transaction([STORE_RULES], "readonly");
      const store = tx.objectStore(STORE_RULES);
      const req = store.getAll();

      return new Promise((resolve, reject) => {
        req.onsuccess = () => {
          db.close();
          resolve(req.result as ComplianceRule[]);
        };
        req.onerror = () => {
          db.close();
          reject(req.error);
        };
      });
    },

    /**
     * Get enabled rules only
     */
    async listEnabledRules(): Promise<ComplianceRule[]> {
      const rules = await this.listRules();
      return rules.filter((r) => r.enabled);
    },

    /**
     * Get a single rule by ID
     */
    async getRule(id: string): Promise<ComplianceRule | null> {
      const db = await openDb();
      const tx = db.transaction([STORE_RULES], "readonly");
      const store = tx.objectStore(STORE_RULES);
      const req = store.get(id);

      return new Promise((resolve, reject) => {
        req.onsuccess = () => {
          db.close();
          resolve((req.result as ComplianceRule) ?? null);
        };
        req.onerror = () => {
          db.close();
          reject(req.error);
        };
      });
    },

    /**
     * Get rules by category
     */
    async getRulesByCategory(category: string): Promise<ComplianceRule[]> {
      const db = await openDb();
      const tx = db.transaction([STORE_RULES], "readonly");
      const store = tx.objectStore(STORE_RULES);
      const idx = store.index("byCategory");
      const req = idx.getAll(category);

      return new Promise((resolve, reject) => {
        req.onsuccess = () => {
          db.close();
          resolve(req.result as ComplianceRule[]);
        };
        req.onerror = () => {
          db.close();
          reject(req.error);
        };
      });
    },

    /**
     * Update a rule
     */
    async updateRule(id: string, updates: Partial<ComplianceRule>): Promise<boolean> {
      const db = await openDb();
      const tx = db.transaction([STORE_RULES], "readwrite");
      const store = tx.objectStore(STORE_RULES);

      const existing = await new Promise<ComplianceRule | null>((resolve) => {
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => resolve(null);
      });

      if (!existing) {
        db.close();
        return false;
      }

      const updated = { ...existing, ...updates, id };
      store.put(updated);

      await txDone(tx);
      db.close();
      return true;
    },

    /**
     * Delete a rule
     */
    async deleteRule(id: string): Promise<void> {
      const db = await openDb();
      const tx = db.transaction([STORE_RULES], "readwrite");
      tx.objectStore(STORE_RULES).delete(id);
      await txDone(tx);
      db.close();
    },

    /**
     * Add a custom rule
     */
    async addRule(rule: ComplianceRule): Promise<void> {
      const db = await openDb();
      const tx = db.transaction([STORE_RULES], "readwrite");
      tx.objectStore(STORE_RULES).put(rule);
      await txDone(tx);
      db.close();
    },

    /**
     * Clear all rules and reset metadata
     */
    async clearAll(): Promise<void> {
      const db = await openDb();
      const tx = db.transaction([STORE_RULES, STORE_RULE_META], "readwrite");
      tx.objectStore(STORE_RULES).clear();
      tx.objectStore(STORE_RULE_META).clear();
      await txDone(tx);
      db.close();
    },
  };
}

export type RuleDb = ReturnType<typeof createRuleDb>;
