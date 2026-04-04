/**
 * src/modules/ruleLoader.ts
 * Loads and initializes the rule library from JSON.
 * Handles first-run initialization into IndexedDB.
 *
 * @module ruleLoader
 */

import type { RuleLibrary } from "../types/rule.types";
import type { RuleDb } from "../storage/ruleDb";

// Import the rule library JSON
import ruleLibraryJson from "../data/ruleLibrary.json";

function buildRuleSignature(library: RuleLibrary): string {
  return library.rules
    .map((rule) => `${rule.id}|${rule.title}|${rule.enabled ? "1" : "0"}|${rule.category}`)
    .sort()
    .join("||");
}

/**
 * Initialize the rule database with the rule library
 * Only loads rules on first run or when library version changes
 */
export async function initializeRuleLibrary(ruleDb: RuleDb): Promise<void> {
  try {
    const library = ruleLibraryJson as RuleLibrary;
    const isInitialized = await ruleDb.isInitialized();

    if (!isInitialized) {
      console.log("[RuleLoader] First run - initializing rule library...");
      await ruleDb.initializeFromLibrary(library);
      console.log(`[RuleLoader] Loaded ${library.rules.length} rules from library v${library.version}`);
    } else {
      const metadata = await ruleDb.getMetadata?.();
      const storedRules = await ruleDb.listRules();
      const storedSignature = storedRules
        .map((rule) => `${rule.id}|${rule.title}|${rule.enabled ? "1" : "0"}|${rule.category}`)
        .sort()
        .join("||");
      const embeddedSignature = buildRuleSignature(library);
      const shouldReload =
        !metadata ||
        metadata.version !== library.version ||
        metadata.lastUpdated !== library.lastUpdated ||
        storedRules.length !== library.rules.length ||
        storedSignature !== embeddedSignature;

      if (shouldReload) {
        console.log("[RuleLoader] Embedded rule library changed - reloading IndexedDB copy...");
        await ruleDb.initializeFromLibrary(library);
        console.log(
          `[RuleLoader] Reloaded ${library.rules.length} rules from library v${library.version} (${library.lastUpdated})`
        );
      } else {
        const rules = await ruleDb.listRules();
        console.log(`[RuleLoader] Rule library already initialized with ${rules.length} rules`);
      }
    }
  } catch (error) {
    console.error("[RuleLoader] Failed to initialize rule library:", error);
    throw error;
  }
}

/**
 * Force reload the rule library (for updates)
 */
export async function reloadRuleLibrary(ruleDb: RuleDb): Promise<void> {
  console.log("[RuleLoader] Force reloading rule library...");
  const library = ruleLibraryJson as RuleLibrary;
  await ruleDb.initializeFromLibrary(library);
  console.log(`[RuleLoader] Reloaded ${library.rules.length} rules`);
}

/**
 * Get the embedded rule library without database
 */
export function getEmbeddedRuleLibrary(): RuleLibrary {
  return ruleLibraryJson as RuleLibrary;
}
