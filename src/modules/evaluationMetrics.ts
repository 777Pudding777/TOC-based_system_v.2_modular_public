/**
 * src/modules/evaluationMetrics.ts
 * Tracks and calculates evaluation metrics for compliance inspections.
 * Provides real-time metrics tracking and aggregation.
 *
 * @module evaluationMetrics
 */

import type { VlmVerdict } from "./vlmChecker";
import type { InspectionMetrics, StepMetrics, StressedFinding } from "../types/trace.types";

/**
 * Metrics collector for a single inspection run
 */
export interface MetricsCollector {
  /** Record a snapshot capture */
  recordSnapshot(captureTimeMs: number): void;
  /** Record a VLM response */
  recordVlmResponse(responseTimeMs: number, confidence: number, verdict: VlmVerdict): void;
  /** Record a navigation action */
  recordNavigation(action: string, success: boolean): void;
  /** Add a failure note */
  addFailureNote(note: string): void;
  /** Add a stressed finding */
  addFinding(finding: Omit<StressedFinding, "step">): void;
  /** Get current step metrics */
  getCurrentStepMetrics(): StepMetrics | null;
  /** Get all step metrics */
  getAllStepMetrics(): StepMetrics[];
  /** Calculate final metrics */
  finalize(finalVerdict: VlmVerdict, finalConfidence: number): InspectionMetrics;
  /** Get stressed findings */
  getFindings(): StressedFinding[];
}

/**
 * Create a metrics collector for an inspection run
 */
export function createMetricsCollector(): MetricsCollector {
  const startTime = Date.now();
  let currentStep = 0;
  let totalSnapshots = 0;
  let totalVlmCalls = 0;
  let totalNavigationSteps = 0;
  let totalVlmResponseTime = 0;
  let totalConfidence = 0;
  let uncertainSteps = 0;
  const failureNotes: string[] = [];
  const stepMetrics: StepMetrics[] = [];
  const findings: StressedFinding[] = [];

  // Track current step state
  let currentStepStartTime: number | null = null;
  let currentSnapshotTime: number | null = null;

  return {
    recordSnapshot(captureTimeMs: number) {
      totalSnapshots++;
      currentSnapshotTime = captureTimeMs;
      if (currentStepStartTime === null) {
        currentStepStartTime = Date.now();
        currentStep++;
      }
    },

    recordVlmResponse(responseTimeMs: number, confidence: number, verdict: VlmVerdict) {
      totalVlmCalls++;
      totalVlmResponseTime += responseTimeMs;
      totalConfidence += confidence;

      if (verdict === "UNCERTAIN") {
        uncertainSteps++;
      }

      const stepMetric: StepMetrics = {
        step: currentStep,
        snapshotCaptureTimeMs: currentSnapshotTime ?? undefined,
        vlmResponseTimeMs: responseTimeMs,
        confidence,
        verdict,
      };

      stepMetrics.push(stepMetric);

      // Reset for next step
      currentSnapshotTime = null;
      currentStepStartTime = null;
    },

    recordNavigation(action: string, success: boolean) {
      totalNavigationSteps++;
      if (!success) {
        failureNotes.push(`Navigation action ${action} failed`);
      }
    },

    addFailureNote(note: string) {
      failureNotes.push(note);
      // Also add to current step metrics if exists
      if (stepMetrics.length > 0) {
        const last = stepMetrics[stepMetrics.length - 1];
        last.failureNotes = last.failureNotes ? `${last.failureNotes}; ${note}` : note;
      }
    },

    addFinding(finding: Omit<StressedFinding, "step">) {
      findings.push({
        ...finding,
        step: currentStep,
      });
    },

    getCurrentStepMetrics(): StepMetrics | null {
      return stepMetrics.length > 0 ? stepMetrics[stepMetrics.length - 1] : null;
    },

    getAllStepMetrics(): StepMetrics[] {
      return [...stepMetrics];
    },

    getFindings(): StressedFinding[] {
      return [...findings];
    },

    finalize(finalVerdict: VlmVerdict, finalConfidence: number): InspectionMetrics {
      const endTime = Date.now();

      return {
        totalSnapshots,
        totalVlmCalls,
        totalNavigationSteps,
        totalDurationMs: endTime - startTime,
        avgVlmResponseTimeMs: totalVlmCalls > 0 ? totalVlmResponseTime / totalVlmCalls : 0,
        avgConfidence: totalVlmCalls > 0 ? totalConfidence / totalVlmCalls : 0,
        finalVerdict,
        finalConfidence,
        uncertainSteps,
        failureNotes,
      };
    },
  };
}

/**
 * Format metrics for display in UI
 */
export function formatMetricsForDisplay(metrics: InspectionMetrics): string {
  const lines = [
    `📊 Inspection Metrics`,
    `━━━━━━━━━━━━━━━━━━━━━`,
    `Snapshots: ${metrics.totalSnapshots}`,
    `VLM Calls: ${metrics.totalVlmCalls}`,
    `Nav Steps: ${metrics.totalNavigationSteps}`,
    `Duration: ${(metrics.totalDurationMs / 1000).toFixed(1)}s`,
    `Avg Response: ${(metrics.avgVlmResponseTimeMs / 1000).toFixed(2)}s`,
    `Avg Confidence: ${(metrics.avgConfidence * 100).toFixed(0)}%`,
    `Uncertain Steps: ${metrics.uncertainSteps}`,
    `━━━━━━━━━━━━━━━━━━━━━`,
    `Final: ${metrics.finalVerdict} (${(metrics.finalConfidence * 100).toFixed(0)}%)`,
  ];

  if (metrics.failureNotes.length > 0) {
    lines.push(``, `⚠️ Failure Notes:`);
    metrics.failureNotes.forEach((note) => lines.push(`  • ${note}`));
  }

  return lines.join("\n");
}

/**
 * Calculate confidence trend from step metrics
 */
export function calculateConfidenceTrend(steps: StepMetrics[]): "improving" | "declining" | "stable" {
  if (steps.length < 2) return "stable";

  const firstHalf = steps.slice(0, Math.floor(steps.length / 2));
  const secondHalf = steps.slice(Math.floor(steps.length / 2));

  const avgFirst = firstHalf.reduce((sum, s) => sum + s.confidence, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((sum, s) => sum + s.confidence, 0) / secondHalf.length;

  const diff = avgSecond - avgFirst;
  if (diff > 0.1) return "improving";
  if (diff < -0.1) return "declining";
  return "stable";
}
