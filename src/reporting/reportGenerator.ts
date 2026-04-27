/**
 * src/reporting/reportGenerator.ts
 * Generates standalone HTML reports for compliance inspection results.
 * Reports include rule info, snapshots, step-by-step trace, findings, and metrics.
 *
 * @module reportGenerator
 */

import type {
  ConversationTrace,
  InspectionMetrics,
  JudgeTaskVerdict,
  NavigationAction,
  SnapshotNoveltyMetrics,
  VlmResponseTrace,
} from "../types/trace.types";
import {
  DEFAULT_MAX_COMPLIANCE_STEPS,
  DEFAULT_MAX_SNAPSHOTS_PER_REQUEST,
  DEFAULT_PROTOTYPE_RUNTIME_SETTINGS,
  DEFAULT_REDUCED_TAVILY_MAX_CHARS,
  DEFAULT_TAVILY_MAX_CHARS,
  DOOR_CLEARANCE_DEFAULTS,
  ENTITY_REPEATED_WORKFLOW_TERMINATION_STEPS,
  ENTITY_UNCERTAIN_TERMINATION_CONFIDENCE,
  ENTITY_UNCERTAIN_TERMINATION_STEPS,
  getPrototypeRuntimeSettings,
  HIGHLIGHT_ANNOTATION_DEFAULTS,
  HIGHLIGHT_NAVIGATION_DEFAULTS,
  HIGHLIGHT_TARGET_AREA_RATIO,
  MAX_ORBIT_DEGREES_PER_AXIS,
  MAX_ORBIT_FOLLOW_UPS_PER_ENTITY,
  ORBIT_MAX_HIGHLIGHT_OCCLUSION_RATIO,
  RAMP_NAVIGATION_DEFAULTS,
  REPEATED_FOLLOW_UPS_BEFORE_ESCALATION,
  SEMANTIC_FOLLOW_UP_FAMILY_BUDGETS,
  TOP_VIEW_TARGET_AREA_RATIO,
  ZOOM_IN_EXHAUSTION_AREA_FACTOR,
} from "../config/prototypeSettings";
import { findModelById } from "../config/openRouterModels";
/**
 * Report generation options
 */
export interface ReportOptions {
  /** Include base64 images in report */
  embedImages?: boolean;
  /** Include raw VLM responses */
  includeRawResponses?: boolean;
  /** Include navigation details */
  includeNavigationDetails?: boolean;
  /** Report title override */
  title?: string;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Format duration in human-readable format
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = ((ms % 60000) / 1000).toFixed(0);
  return `${mins}m ${secs}s`;
}

/**
 * Format confidence as percentage
 */
function formatConfidence(confidence: number): string {
  return `${(confidence * 100).toFixed(0)}%`;
}

function formatSnapshotNovelty(novelty: SnapshotNoveltyMetrics | undefined): string {
  if (!novelty) return "";
  const score = novelty.approximateNoveltyScore.toFixed(2);
  const redundancy = novelty.redundancyWarning ? " | likely redundant" : "";
  const basis = novelty.comparedToSnapshotId ? ` | vs ${novelty.comparedToSnapshotId}` : "";
  return `Novelty ${score}${redundancy}${basis}`;
}
/**
 * Format token counts with thousands separators
 */
function formatTokenCount(tokens: number | undefined): string {
  const safe = typeof tokens === "number" && isFinite(tokens) ? Math.max(0, tokens) : 0;
  if (!Number.isInteger(safe)) {
    return safe.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    });
  }
  return safe.toLocaleString("en-US");
}

function toAnchorId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}


/**
 * Get verdict badge color
 */
function getVerdictColor(verdict: string): string {
  switch (verdict) {
    case "PASS":
      return "#22c55e";
    case "FAIL":
      return "#ef4444";
    case "UNCERTAIN":
      return "#f59e0b";
    default:
      return "#6b7280";
  }
}

/**
 * Get severity badge color
 */
function getSeverityColor(severity: string): string {
  switch (severity) {
    case "critical":
      return "#ef4444";
    case "moderate":
      return "#f59e0b";
    case "low":
      return "#22c55e";
    default:
      return "#6b7280";
  }
}

/**
 * Generate embedded CSS for the report
 */
function generateCss(): string {
  return `
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #1f2937;
      background: #f3f4f6;
      padding: 20px;
      scroll-behavior: smooth;
    }

    .page-layout {
      max-width: 1500px;
      margin: 0 auto;
      display: grid;
      grid-template-columns: 240px minmax(0, 1fr) 110px;
      gap: 24px;
      align-items: start;
    }

    .report-nav {
      position: sticky;
      top: 20px;
    }

    .report-nav-panel {
      background: transparent;
      border-radius: 0;
      box-shadow: none;
      border: none;
      padding: 8px 0;
      max-height: calc(100vh - 40px);
      overflow: auto;
    }

    .report-nav-title {
      font-size: 13px;
      font-weight: 800;
      color: #1e3a8a;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 12px;
    }

    .report-nav-group {
      margin-top: 18px;
    }

    .report-nav-group:first-of-type {
      margin-top: 0;
    }

    .report-nav-group-label {
      font-size: 12px;
      font-weight: 700;
      color: #1e3a8a;
      text-transform: uppercase;
      margin-bottom: 8px;
    }

    .report-nav-link {
      display: block;
      text-decoration: none;
      color: #1e3a8a;
      font-size: 14px;
      padding: 8px 0;
      border-radius: 8px;
      transition: color 0.2s ease;
      word-break: break-word;
    }

    .report-nav-link:hover {
      color: #3b82f6;
    }

    .report-actions {
      position: sticky;
      top: 20px;
      display: flex;
      justify-content: flex-end;
    }

    .report-action-button {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 4px;
      min-width: 72px;
      padding: 12px 10px;
      border: 1px solid #cbd5e1;
      border-radius: 12px;
      background: #fff;
      color: #1e3a8a;
      font-size: 13px;
      font-weight: 800;
      cursor: pointer;
      box-shadow: 0 4px 6px -1px rgba(0,0,0,0.08), 0 2px 4px -2px rgba(0,0,0,0.08);
      transition: color 0.2s ease, border-color 0.2s ease, background 0.2s ease;
    }

    .report-action-button:hover {
      color: #3b82f6;
      border-color: #93c5fd;
      background: #eff6ff;
    }

    .report-action-icon {
      font-size: 18px;
      line-height: 1;
    }

    .container {
      width: 100%;
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1);
      overflow: hidden;
    }

    .header {
      background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%);
      color: #fff;
      padding: 32px;
    }

    .header h1 {
      font-size: 28px;
      margin-bottom: 8px;
    }

    .header .meta {
      opacity: 0.9;
      font-size: 14px;
    }

    .section {
      padding: 24px 32px;
      border-bottom: 1px solid #e5e7eb;
      scroll-margin-top: 24px;
    }

    .section:last-child {
      border-bottom: none;
    }

    .section h2 {
      font-size: 20px;
      color: #1e3a8a;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .section h3 {
      font-size: 16px;
      color: #374151;
      margin-bottom: 12px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      padding: 4px 12px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
    }

    .verdict-badge {
      color: #fff;
      font-size: 16px;
      padding: 8px 24px;
    }

    .rule-card {
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 16px;
    }

    .rule-card .title {
      font-size: 18px;
      font-weight: 600;
      color: #111827;
      margin-bottom: 8px;
    }

    .rule-card .description {
      color: #4b5563;
      margin-bottom: 12px;
    }

    .rule-card .tags {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .tag {
      background: #e5e7eb;
      color: #374151;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
    }

    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 16px;
    }

    .metric-card {
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 16px;
      text-align: center;
    }

    .metric-card .value {
      font-size: 24px;
      font-weight: 700;
      color: #1e3a8a;
    }

    .metric-card .label {
      font-size: 12px;
      color: #6b7280;
      margin-top: 4px;
    }

    .summary-layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(280px, 420px);
      gap: 24px;
      align-items: start;
    }

    .summary-kpis {
      display: flex;
      align-items: center;
      gap: 24px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }

    .verdict-stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
    }

    .verdict-stat {
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      padding: 14px;
      background: #f9fafb;
      text-align: center;
    }

    .verdict-stat .count {
      font-size: 24px;
      font-weight: 800;
      color: #111827;
    }

    .verdict-stat .label {
      font-size: 12px;
      color: #6b7280;
      margin-top: 4px;
      text-transform: uppercase;
      font-weight: 700;
    }

    .verdict-stat.pass { border-top: 4px solid #22c55e; }
    .verdict-stat.fail { border-top: 4px solid #ef4444; }
    .verdict-stat.uncertain { border-top: 4px solid #f59e0b; }

    .verdict-stats-title {
      font-size: 14px;
      font-weight: 700;
      color: #1e3a8a;
      margin-bottom: 10px;
      text-align: center;
    }

    .pending-card {
      background: #f3f4f6;
      border: 1px dashed #9ca3af;
      color: #4b5563;
    }

    .pending-card .title {
      color: #4b5563;
    }

    .appendix-subsection {
      margin-top: 22px;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      background: #fff;
      overflow: hidden;
    }

    .appendix-subsection:first-of-type {
      margin-top: 0;
    }

    .appendix-subsection summary {
      cursor: pointer;
      list-style: none;
      padding: 14px 16px;
      font-size: 16px;
      font-weight: 700;
      color: #1e3a8a;
      background: #f9fafb;
      display: flex;
      align-items: center;
      gap: 10px;
      user-select: none;
    }

    .appendix-subsection summary::-webkit-details-marker {
      display: none;
    }

    .appendix-subsection summary::before {
      content: ">";
      font-size: 12px;
      color: #6b7280;
      transition: transform 0.2s ease;
    }

    .appendix-subsection[open] summary::before {
      transform: rotate(90deg);
    }

    .appendix-subsection-content {
      padding: 16px;
    }

    .entity-snapshots {
      margin: 14px 0 18px;
    }

    .entity-snapshots h3 {
      color: #1e3a8a;
    }

    .finding-card {
      border-left: 4px solid;
      padding: 16px;
      margin-bottom: 12px;
      background: #f9fafb;
      border-radius: 0 8px 8px 0;
    }

    .finding-card.pass { border-color: #22c55e; }
    .finding-card.fail { border-color: #ef4444; }
    .finding-card.warning { border-color: #f59e0b; }

    .finding-card .message {
      font-weight: 600;
      margin-bottom: 8px;
    }

    .finding-card .details {
      color: #4b5563;
      font-size: 14px;
    }

    .snapshot-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
    }

    .snapshot-card {
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      overflow: hidden;
    }

    .snapshot-card img {
      width: 100%;
      height: 200px;
      object-fit: cover;
      background: #1f2937;
    }

    .snapshot-card .info {
      padding: 12px;
    }

    .snapshot-card .reason {
      font-weight: 500;
      color: #111827;
      margin-bottom: 4px;
    }

    .snapshot-card .time {
      font-size: 12px;
      color: #6b7280;
    }

    .step-timeline {
      position: relative;
      padding-left: 32px;
    }

    .step-timeline::before {
      content: '';
      position: absolute;
      left: 11px;
      top: 0;
      bottom: 0;
      width: 2px;
      background: #e5e7eb;
    }

    .step-item {
      position: relative;
      padding-bottom: 24px;
    }

    .step-item::before {
      content: '';
      position: absolute;
      left: -25px;
      top: 4px;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #3b82f6;
      border: 2px solid #fff;
      box-shadow: 0 0 0 2px #3b82f6;
    }

    .step-item.pass::before { background: #22c55e; box-shadow: 0 0 0 2px #22c55e; }
    .step-item.fail::before { background: #ef4444; box-shadow: 0 0 0 2px #ef4444; }
    .step-item.uncertain::before { background: #f59e0b; box-shadow: 0 0 0 2px #f59e0b; }

    .step-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 8px;
    }

    .step-number {
      font-weight: 700;
      color: #1e3a8a;
    }

    .step-content {
      background: #f9fafb;
      border-radius: 8px;
      padding: 16px;
    }

    .step-content .rationale {
      color: #374151;
      margin-bottom: 12px;
    }

    .step-content .meta {
      font-size: 12px;
      color: #6b7280;
    }

    .step-snapshots {
      margin-bottom: 12px;
    }

    .step-snapshots-title {
      font-size: 13px;
      font-weight: 600;
      color: #374151;
      margin-bottom: 8px;
    }

    .step-snapshots-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 10px;
    }

    .step-snapshot-card {
      margin: 0;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      overflow: hidden;
      background: #fff;
    }

    .step-snapshot-card img {
      display: block;
      width: 100%;
      height: 800px;
      object-fit: cover;
      background: #111827;
    }

    .step-snapshot-placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 800px;
      background: #1f2937;
      color: #9ca3af;
      font-size: 12px;
    }

    .step-suppressed-card {
      display: flex;
      flex-direction: column;
      justify-content: center;
      min-height: 220px;
      padding: 18px;
      border: 1px dashed #f59e0b;
      border-radius: 8px;
      background: linear-gradient(180deg, #fff7ed 0%, #ffffff 100%);
      color: #9a3412;
    }

    .step-suppressed-label {
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #c2410c;
      margin-bottom: 6px;
    }

    .step-suppressed-title {
      font-size: 16px;
      font-weight: 700;
      color: #7c2d12;
      margin-bottom: 8px;
    }

    .step-suppressed-text {
      font-size: 13px;
      line-height: 1.5;
      color: #9a3412;
    }

    .step-snapshot-card figcaption {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 8px 10px;
      font-size: 12px;
      color: #6b7280;
    }

    .step-snapshot-card .snapshot-id {
      font-weight: 600;
      color: #1f2937;
    }

    .step-prompt {
      margin-top: 10px;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      background: #fff;
      overflow: hidden;
    }

    .step-prompt summary {
      cursor: pointer;
      list-style: none;
      padding: 10px 12px;
      font-size: 13px;
      font-weight: 600;
      color: #374151;
      display: flex;
      align-items: center;
      gap: 8px;
      user-select: none;
    }

    .step-prompt summary::-webkit-details-marker {
      display: none;
    }

    .step-prompt summary::before {
      content: "▶";
      font-size: 10px;
      color: #6b7280;
      transition: transform 0.2s ease;
    }

    .step-prompt[open] summary::before {
      transform: rotate(90deg);
    }

    .step-prompt pre {
      margin: 0;
      padding: 12px;
      border-top: 1px solid #e5e7eb;
      background: #f9fafb;
      color: #1f2937;
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }


    .footer {
      background: #f9fafb;
      padding: 24px 32px;
      text-align: center;
      font-size: 12px;
      color: #6b7280;
    }

      .appendix-item {
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
      background: #fafafa;
    }

    .appendix-meta {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 8px 16px;
      font-size: 12px;
      color: #6b7280;
      margin-bottom: 12px;
    }

    .settings-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 12px;
      margin-bottom: 0;
    }

    .settings-entry {
      min-width: 0;
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 10px 12px;
    }

    .settings-key {
      display: block;
      color: #4b5563;
      font-size: 11px;
      font-weight: 700;
      line-height: 1.35;
      overflow-wrap: anywhere;
      word-break: break-word;
      margin-bottom: 6px;
    }

    .settings-value {
      display: block;
      color: #111827;
      font-size: 12px;
      line-height: 1.45;
      overflow-wrap: anywhere;
      word-break: break-word;
      white-space: pre-wrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }

    .appendix-text {
      white-space: pre-wrap;
      word-break: break-word;
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      padding: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      line-height: 1.5;
      color: #111827;
      max-height: 320px;
      overflow: auto;
    }

    .appendix-table-wrap {
      width: 100%;
      overflow-x: auto;
    }

    .appendix-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    .appendix-table th,
    .appendix-table td {
      padding: 10px 12px;
      border: 1px solid #e5e7eb;
      vertical-align: top;
      text-align: left;
    }

    .appendix-table th {
      background: #f9fafb;
      color: #1e3a8a;
      font-weight: 700;
      white-space: nowrap;
    }

    .appendix-table td {
      color: #374151;
    }

    .novelty-stack {
      display: grid;
      gap: 8px;
      min-width: 280px;
    }

    .novelty-card {
      background: #f8fafc;
      border: 1px solid #dbeafe;
      border-radius: 10px;
      padding: 10px 12px;
    }

    .novelty-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
    }

    .novelty-card-title {
      font-size: 12px;
      font-weight: 700;
      color: #1e3a8a;
    }

    .novelty-card-score {
      font-size: 12px;
      font-weight: 800;
      color: #111827;
    }

    .novelty-bar {
      width: 100%;
      height: 8px;
      background: #e5e7eb;
      border-radius: 999px;
      overflow: hidden;
      margin-bottom: 8px;
    }

    .novelty-bar-fill {
      height: 100%;
      border-radius: 999px;
    }

    .novelty-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .novelty-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      line-height: 1.2;
      background: #e0f2fe;
      color: #075985;
    }

    .novelty-badge.warn {
      background: #fef3c7;
      color: #92400e;
    }

    .novelty-badge.alert {
      background: #fee2e2;
      color: #b91c1c;
    }

    .nav-log-list {
      display: grid;
      gap: 14px;
    }

    .nav-log-card {
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 14px;
      padding: 16px;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }

    .nav-log-card-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }

    .nav-log-step {
      font-size: 13px;
      font-weight: 800;
      color: #1e3a8a;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      margin-bottom: 4px;
    }

    .nav-log-entity {
      font-size: 15px;
      font-weight: 700;
      color: #111827;
    }

    .nav-log-storey {
      font-size: 13px;
      color: #6b7280;
    }

    .nav-log-result {
      display: inline-flex;
      align-items: center;
      padding: 5px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.02em;
    }

    .nav-log-result.success {
      background: #dcfce7;
      color: #166534;
    }

    .nav-log-result.no-op {
      background: #fef3c7;
      color: #92400e;
    }

    .nav-log-result.suppressed {
      background: #fee2e2;
      color: #b91c1c;
    }

    .nav-log-summary {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 14px;
    }

    .nav-log-chip {
      display: inline-flex;
      align-items: center;
      padding: 5px 10px;
      border-radius: 999px;
      background: #eff6ff;
      color: #1d4ed8;
      font-size: 12px;
      font-weight: 700;
    }

    .nav-log-grid {
      display: grid;
      grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
      gap: 16px;
      align-items: start;
    }

    .nav-log-text {
      font-size: 13px;
      line-height: 1.6;
      color: #374151;
    }

    .nav-log-meta {
      display: grid;
      gap: 8px;
      margin-top: 10px;
    }

    .nav-log-details {
      margin-top: 14px;
      border-top: 1px solid #e5e7eb;
      padding-top: 12px;
    }

    .nav-log-details summary {
      cursor: pointer;
      font-size: 13px;
      font-weight: 700;
      color: #1e3a8a;
      list-style: none;
    }

    .nav-log-details summary::-webkit-details-marker {
      display: none;
    }

    .nav-log-details-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px;
      margin-top: 12px;
    }

    .nav-log-detail-card {
      background: #f8fafc;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      padding: 12px;
      font-size: 12px;
      line-height: 1.5;
      color: #374151;
      overflow-wrap: anywhere;
    }

    .nav-log-detail-title {
      display: block;
      font-size: 12px;
      font-weight: 800;
      color: #1e3a8a;
      margin-bottom: 6px;
    }

    @media (max-width: 980px) {
      .nav-log-grid {
        grid-template-columns: 1fr;
      }
    }

    @media print {
      @page {
        size: A4;
        margin: 12mm;
      }

      body {
        background: #fff;
        padding: 0;
        font-size: 11pt;
      }
      .page-layout {
        display: block;
      }
      .report-nav {
        display: none;
      }
      .report-actions {
        display: none;
      }
      .container {
        box-shadow: none;
      }
      .header {
        padding: 18px 24px;
      }
      .section {
        padding: 14px 20px;
      }
      .section,
      .rule-card,
      .appendix-item,
      .step-snapshot-card,
      .snapshot-card {
        break-inside: avoid;
        page-break-inside: avoid;
      }
      .rule-card,
      .appendix-item {
        margin-bottom: 10px;
      }
      .step-header {
        margin-bottom: 4px;
      }
      .step-item {
        padding-bottom: 10px;
        break-inside: auto;
        page-break-inside: auto;
      }
      .step-content {
        display: grid;
        grid-template-columns: minmax(320px, 46%) minmax(0, 1fr);
        gap: 8px 14px;
        align-items: start;
        padding: 10px;
        background: #fff;
        border: 1px solid #e5e7eb;
        break-inside: auto;
        page-break-inside: auto;
      }
      .step-content .rationale {
        grid-column: 2;
        margin-bottom: 0;
        font-size: 10.5pt;
        line-height: 1.4;
      }
      .step-content .meta {
        grid-column: 2;
        font-size: 10px;
      }
      .step-snapshots {
        grid-column: 1;
        grid-row: 1 / span 2;
        margin-bottom: 0;
      }
      .step-snapshots-grid {
        grid-template-columns: 1fr;
      }
      .step-snapshot-card img {
        height: auto;
        max-height: 560px;
        object-fit: contain;
        background: #fff;
      }
      .step-snapshot-placeholder {
        height: 320px;
      }
      .step-snapshot-card figcaption {
        padding: 6px 8px;
        font-size: 10px;
      }
      .step-prompt {
        grid-column: 1 / -1;
        margin-top: 0;
      }
      .step-prompt:not([open]) {
        display: none;
      }
      .step-prompt summary {
        padding: 6px 8px;
        font-size: 11px;
      }
      .step-prompt pre {
        max-height: none;
        overflow: visible;
        font-size: 10px;
        line-height: 1.35;
      }
      .snapshot-card img {
        height: auto;
        max-height: 200px;
      }
    }

    @media (max-width: 800px) {
      .page-layout {
        grid-template-columns: 1fr;
      }
      .report-nav {
        position: static;
      }
      .report-actions {
        position: static;
        justify-content: flex-start;
      }
      .report-nav-panel {
        max-height: none;
      }
      .summary-layout,
      .verdict-stats {
        grid-template-columns: 1fr;
      }
    }
  `;
}

/**
 * Generate summary section
 */
function prettifyModelId(modelId: string): string {
  const tail = modelId.includes("/") ? modelId.split("/").pop() ?? modelId : modelId;
  return tail
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => (/^\d+(\.\d+)*$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

function getFriendlyVlmName(trace: ConversationTrace): string {
  const judgeModelId = trace.judgeReport?.modelId?.trim();
  const responseModelId = trace.responses.find((response) => response.decision.meta?.modelId)?.decision.meta.modelId?.trim();
  const promptModelId = trace.prompts.find((prompt) => prompt.modelId)?.modelId?.trim();
  const modelId = judgeModelId || responseModelId || promptModelId || "";
  const adapterName = trace.model.name?.trim() || "";

  if (modelId) {
    const openRouterMatch = findModelById(modelId);
    if (openRouterMatch?.label) return openRouterMatch.label;

    const normalized = modelId.toLowerCase();
    if (normalized.includes("claude")) return "Claude";
    if (normalized.includes("gpt") || normalized.includes("chatgpt")) return "ChatGPT";
    if (normalized.includes("gemini")) return "Gemini";
    if (normalized.includes("grok")) return "Grok";
    if (normalized.includes("kimi")) return "Kimi";
    if (normalized.includes("qwen")) return "Qwen";
    if (normalized.includes("nova")) return "Nova";
    if (normalized.includes("llama")) return "Llama";
    return prettifyModelId(modelId);
  }

  if (adapterName && !["openrouter", "openai", "mock"].includes(adapterName.toLowerCase())) {
    return adapterName;
  }

  return trace.model.provider || "Unknown VLM";
}

function getEntityVerdictStats(trace: ConversationTrace): {
  total: number;
  checked: number;
  pass: number;
  fail: number;
  uncertain: number;
} {
  const summary = buildEntitySummary(trace);
  const checked = summary.completed.length;
  const total = summary.remainingCount === null ? checked : checked + summary.remainingCount;

  return summary.completed.reduce(
    (acc, item) => {
      if (item.verdict === "PASS") acc.pass++;
      else if (item.verdict === "FAIL") acc.fail++;
      else acc.uncertain++;
      return acc;
    },
    { total, checked, pass: 0, fail: 0, uncertain: 0 }
  );
}

function buildReportNavigation(trace: ConversationTrace): string {
  const primaryLinks = [
    { href: "#report-top", label: "Report Header" },
    { href: "#rule-information", label: "Rule Information" },
    { href: "#inspection-summary", label: "Inspection Summary" },
    ...(trace.metrics ? [{ href: "#evaluation-metrics", label: "Evaluation Metrics" }] : []),
    { href: "#entity-summary", label: "Entity Summary" },
    { href: "#appendix", label: "Appendix" },
  ];

  const traceLinks = buildEntityTraceGroups(trace).map((group, index) => ({
    href: `#trace-${toAnchorId(group.entityId ?? `general-${index + 1}`)}`,
    label: group.entityId ? `Entity ${group.entityId}` : "General Trace",
  }));

  return `
    <aside class="report-nav" aria-label="Report navigation">
      <div class="report-nav-panel">
        <div class="report-nav-title">Navigation</div>
        <div class="report-nav-group">
          ${primaryLinks
            .map((link) => `<a class="report-nav-link" href="${link.href}">${escapeHtml(link.label)}</a>`)
            .join("")}
        </div>
        ${traceLinks.length
          ? `
            <div class="report-nav-group">
              <div class="report-nav-group-label">Entity Traces</div>
              ${traceLinks
                .map((link) => `<a class="report-nav-link" href="${link.href}">${escapeHtml(link.label)}</a>`)
                .join("")}
            </div>
          `
          : ""}
      </div>
    </aside>
  `;
}

function buildReportActions(): string {
  return `
    <aside class="report-actions" aria-label="Report actions">
      <button class="report-action-button" type="button" onclick="window.print()" title="Download report as PDF">
        <span>PDF</span>
        <span class="report-action-icon" aria-hidden="true">&#8681;</span>
      </button>
    </aside>
  `;
}

function generateSummarySection(trace: ConversationTrace): string {
  const verdictColor = getVerdictColor(trace.finalVerdict ?? "UNCERTAIN");
  const stats = getEntityVerdictStats(trace);
  const denominator = stats.total || stats.checked || trace.responses.length || 0;
  // Severity color used in rule section, not summary
  void getSeverityColor(trace.rule.severity);

  return `
    <div class="section" id="inspection-summary">
      <h2> Inspection Summary</h2>
      <div class="summary-layout">
        <div>
          <div class="summary-kpis">
            <div>
              <span style="color: #6b7280; font-size: 14px;">Final Verdict</span>
              <div style="margin-top: 4px;">
                <span class="badge verdict-badge" style="background: ${verdictColor};">
                  ${trace.finalVerdict ?? "PENDING"}
                </span>
              </div>
            </div>
            <div>
              <span style="color: #6b7280; font-size: 14px;">Confidence</span>
              <div style="font-size: 24px; font-weight: 700; color: #1e3a8a;">
                ${trace.finalConfidence != null ? formatConfidence(trace.finalConfidence) : "N/A"}
              </div>
            </div>
            <div>
              <span style="color: #6b7280; font-size: 14px;">Status</span>
              <div style="margin-top: 4px;">
                <span class="badge" style="background: ${trace.status === "completed" ? "#22c55e" : trace.status === "failed" ? "#ef4444" : "#f59e0b"}; color: #fff;">
                  ${trace.status.toUpperCase()}
                </span>
              </div>
            </div>
          </div>
        </div>
        <div>
          <div class="verdict-stats-title">Total checked: ${stats.checked}/${denominator} entities</div>
          <div class="verdict-stats" aria-label="Entity verdict counts">
            <div class="verdict-stat pass">
              <div class="count">${stats.pass}/${denominator}</div>
              <div class="label">Passed</div>
            </div>
            <div class="verdict-stat fail">
              <div class="count">${stats.fail}/${denominator}</div>
              <div class="label">Failed</div>
            </div>
            <div class="verdict-stat uncertain">
              <div class="count">${stats.uncertain}/${denominator}</div>
              <div class="label">Uncertain</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderListItems(items: string[]): string {
  if (!items.length) return `<p style="color: #6b7280;">No items recorded.</p>`;
  return `
    <ul style="margin-left: 18px; color: #374151;">
      ${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
    </ul>
  `;
}

function renderAppendixSubsection(title: string, content: string): string {
  return `
    <details class="appendix-subsection">
      <summary>${escapeHtml(title)}</summary>
      <div class="appendix-subsection-content">
        ${content}
      </div>
    </details>
  `;
}

function stepsOverlap(aStart?: number, aEnd?: number, bStart?: number, bEnd?: number): boolean {
  if (aStart == null || aEnd == null || bStart == null || bEnd == null) return false;
  return aStart <= bEnd && bStart <= aEnd;
}

function renderJudgeVerdictCard(args: {
  trace: ConversationTrace;
  entityId: string | null;
  stepStart?: number;
  stepEnd?: number;
}): string {
  const judge = args.trace.judgeReport;
  if (!judge) {
    return `
      <div class="rule-card" style="margin-bottom: 16px;">
        <div class="title">Primary VLM Summary</div>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px;">
          <span class="badge" style="background:${getVerdictColor(args.trace.finalVerdict ?? "UNCERTAIN")};color:#fff;">${escapeHtml(args.trace.finalVerdict ?? "PENDING")}</span>
          <span style="color:#4b5563;font-size:14px;">Confidence: ${args.trace.finalConfidence != null ? formatConfidence(args.trace.finalConfidence) : "N/A"}</span>
        </div>
        ${args.trace.finalRationale ? `<p style="color:#374151;">${escapeHtml(args.trace.finalRationale)}</p>` : ""}
      </div>
    `;
  }

  const matchingTasks = judge.taskVerdicts.filter((task) => {
    if (args.entityId && task.entityId === args.entityId) return true;
    if (!args.entityId && !task.entityId) return true;
    return stepsOverlap(task.stepStart, task.stepEnd, args.stepStart, args.stepEnd);
  });
  const tasks = matchingTasks.length
    ? matchingTasks
    : judge.taskVerdicts.length <= 1
      ? judge.taskVerdicts
      : [];

  const renderTask = (task: JudgeTaskVerdict) => `
    <div class="rule-card" style="margin-bottom: 12px;">
      <div class="title">${escapeHtml(task.taskLabel)}</div>
      ${task.entityId ? `<div class="description">Entity: ${escapeHtml(task.entityId)}</div>` : ""}
      ${task.stepStart != null && task.stepEnd != null ? `<div class="description">Judged steps: ${task.stepStart}${task.stepEnd !== task.stepStart ? `-${task.stepEnd}` : ""}</div>` : ""}
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px;">
        <span class="badge" style="background:${getVerdictColor(task.verdict)};color:#fff;">${escapeHtml(task.verdict)}</span>
        <span style="color:#4b5563;font-size:14px;">Judge confidence: ${formatConfidence(task.confidence)}</span>
      </div>
      <p style="color:#374151;">${escapeHtml(task.reasoning)}</p>
      ${task.evidenceSnapshotIds.length ? `<p style="margin-top:8px;color:#6b7280;font-size:12px;">Evidence snapshots: ${task.evidenceSnapshotIds.map(escapeHtml).join(", ")}</p>` : ""}
    </div>
  `;

  if (tasks.length) return tasks.map(renderTask).join("");

  return `
    <div class="rule-card" style="margin-bottom: 16px;">
      <div class="title">${args.entityId ? `Judge Verdict for Entity ${escapeHtml(args.entityId)}` : "Judge Verdict"}</div>
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px;">
        <span class="badge verdict-badge" style="background:${getVerdictColor(judge.verdict)};">${escapeHtml(judge.verdict)}</span>
        <span style="color:#4b5563;font-size:14px;">Judge confidence: ${formatConfidence(judge.confidence)}</span>
        <span style="color:#6b7280;font-size:12px;">${escapeHtml(judge.provider)} / ${escapeHtml(judge.modelId)}</span>
      </div>
      ${judge.error ? `<p style="color:#b91c1c;margin-bottom:8px;"><strong>Judge warning:</strong> ${escapeHtml(judge.error)}</p>` : ""}
      <p style="color:#374151;">${escapeHtml(judge.rationale)}</p>
    </div>
  `;
}

function generateJudgeAppendixSection(trace: ConversationTrace): string {
  const judge = trace.judgeReport;
  if (!judge) {
    return `
      ${renderAppendixSubsection("Suggestions for the User", `<p style="color: #6b7280;">No judge suggestions were recorded for this run.</p>`)}
      ${renderAppendixSubsection("Possible Mistakes and Debugging suggestions", `<p style="color: #6b7280;">No judge debugging suggestions were recorded for this run.</p>`)}
    `;
  }

  return `
    ${renderAppendixSubsection("Suggestions for the User", renderListItems(judge.suggestionsForUser))}
    ${renderAppendixSubsection("Possible Mistakes and Debugging suggestions", `
      <p style="color:#374151;margin-bottom:10px;">${escapeHtml(judge.debuggingAndSuggestions.primaryDecisionAssessment)}</p>
      <div style="margin-bottom:10px;"><strong>Possible mistakes:</strong>${renderListItems(judge.debuggingAndSuggestions.possibleMistakes)}</div>
      <div style="margin-bottom:10px;"><strong>Capability notes:</strong>${renderListItems(judge.debuggingAndSuggestions.capabilityNotes)}</div>
      <div><strong>Improvement suggestions:</strong>${renderListItems(judge.debuggingAndSuggestions.improvementSuggestions)}</div>
    `)}
  `;
}

/**
 * Generate rule info section
 */
function generateRuleSection(trace: ConversationTrace): string {
  const severityColor = getSeverityColor(trace.rule.severity);

  return `
    <div class="section" id="rule-information">
      <h2> Rule Information</h2>
      <div class="rule-card">
        <div class="title">${escapeHtml(trace.rule.title)}</div>
        <div class="description">${escapeHtml(trace.rule.description)}</div>
        <div class="tags">
          <span class="tag">${escapeHtml(trace.rule.category)}</span>
          <span class="badge" style="background: ${severityColor}; color: #fff; font-size: 11px;">
            ${trace.rule.severity.toUpperCase()}
          </span>
          <span class="tag">ID: ${escapeHtml(trace.rule.id)}</span>
        </div>
      </div>
    </div>
  `;
}

/**
 * Generate metrics section
 */
function generateMetricsSection(metrics: InspectionMetrics | undefined): string {
  if (!metrics) return "";

  return `
    <div class="section" id="evaluation-metrics">
      <h2> Evaluation Metrics</h2>
      <div class="metrics-grid">
        <div class="metric-card">
          <div class="value">${metrics.totalVlmCalls}</div>
          <div class="label">VLM Calls</div>
        </div>
        <div class="metric-card">
          <div class="value">${formatDuration(metrics.totalDurationMs)}</div>
          <div class="label">Total Duration</div>
        </div>
        <div class="metric-card">
          <div class="value">${formatTokenCount(metrics.complianceTokensUsed)}</div>
          <div class="label">Compliance Tokens Used</div>
        </div>
        <div class="metric-card">
          <div class="value">${metrics.totalSnapshots}</div>
          <div class="label">Snapshots</div>
        </div>
        <div class="metric-card">
          <div class="value">${formatConfidence(metrics.avgConfidence)}</div>
          <div class="label">Avg Confidence</div>
        </div>
      </div>
    </div>
  `;
}

function renderSnapshotsGrid(trace: ConversationTrace, embedImages: boolean): string {
  if (trace.snapshots.length === 0) {
    return `<p style="color: #6b7280;">No snapshots captured.</p>`;
  }

  const snapshotsHtml = trace.snapshots
    .map(
      (s) => `
      <div class="snapshot-card">
        ${embedImages && s.imageBase64 ? `<img src="data:image/png;base64,${s.imageBase64}" alt="Snapshot ${s.snapshotId}" />` : `<div style="height: 200px; background: #1f2937; display: flex; align-items: center; justify-content: center; color: #6b7280;">Image not embedded</div>`}
        <div class="info">
          <div class="reason">${escapeHtml(s.reason)}</div>
          <div class="time">${new Date(s.timestamp).toLocaleString()}</div>
          ${s.novelty ? `<div class="time">${escapeHtml(formatSnapshotNovelty(s.novelty))}</div>` : ""}
        </div>
      </div>
    `
    )
    .join("");

  return `
    <div class="snapshot-grid">
      ${snapshotsHtml}
    </div>
  `;
}

function renderEntitySnapshots(
  trace: ConversationTrace,
  group: EntityTraceGroup,
  snapshotsById: Map<string, ConversationTrace["snapshots"][number]>,
  promptByStep: Map<number, ConversationTrace["prompts"][number]>,
  snapshotIdByStep: Map<number, string>
): string {
  const snapshotIds = new Set<string>();

  for (const response of group.responses) {
    const currentStepSnapshotId =
      snapshotIdByStep.get(response.step) ??
      trace.snapshots.find((snapshot) => snapshot.reason.includes(`compliance_step_${response.step}_`))?.snapshotId;
    if (currentStepSnapshotId) snapshotIds.add(currentStepSnapshotId);
    for (const snapshotId of promptByStep.get(response.step)?.snapshotIds ?? []) {
      snapshotIds.add(snapshotId);
    }
  }

  for (const task of trace.judgeReport?.taskVerdicts ?? []) {
    const matchesEntity = group.entityId && task.entityId === group.entityId;
    const matchesSteps = stepsOverlap(task.stepStart, task.stepEnd, group.stepStart, group.stepEnd);
    if (matchesEntity || matchesSteps) {
      task.evidenceSnapshotIds.forEach((snapshotId) => snapshotIds.add(snapshotId));
    }
  }

  const snapshots = Array.from(snapshotIds)
    .map((snapshotId) => snapshotsById.get(snapshotId))
    .filter((snapshot): snapshot is ConversationTrace["snapshots"][number] => Boolean(snapshot));

  if (!snapshots.length) return "";

  return `
    <div class="entity-snapshots">
      <h3>Snapshots for this Entity</h3>
      <div class="snapshot-grid">
        ${snapshots
          .map(
            (snapshot) => `
          <div class="snapshot-card">
            ${snapshot.imageBase64 ? `<img src="data:image/png;base64,${snapshot.imageBase64}" alt="Snapshot ${snapshot.snapshotId}" />` : `<div style="height: 200px; background: #1f2937; display: flex; align-items: center; justify-content: center; color: #6b7280;">Image not embedded</div>`}
            <div class="info">
              <div class="reason">${escapeHtml(snapshot.reason)}</div>
              <div class="time">${escapeHtml(snapshot.snapshotId)} | ${new Date(snapshot.timestamp).toLocaleString()}</div>
              ${snapshot.novelty ? `<div class="time">${escapeHtml(formatSnapshotNovelty(snapshot.novelty))}</div>` : ""}
            </div>
          </div>
        `
          )
          .join("")}
      </div>
    </div>
  `;
}

function parseChecklistValue(promptText: string, key: string): string | null {
  const match = String(promptText ?? "").match(new RegExp(`^${key}=([^\\n]+)$`, "m"));
  return match ? match[1].trim() : null;
}

type EntitySummaryItem = {
  taskLabel: string;
  entityId: string;
  verdict: string;
  stepStart: number;
  stepEnd: number;
};

function buildEntitySummary(trace: ConversationTrace): {
  completed: EntitySummaryItem[];
  remainingCount: number | null;
} {
  const promptByStep = new Map(trace.prompts.map((prompt) => [prompt.step, prompt]));
  const groups: Array<{
    entityId: string;
    taskLabel: string;
    stepStart: number;
    stepEnd: number;
    finalVerdict: string;
    finalized: boolean;
  }> = [];

  for (const response of trace.responses) {
    const prompt = promptByStep.get(response.step);
    const promptText = prompt?.promptText ?? "";
    const entityId = parseChecklistValue(promptText, "activeEntity");
    if (!entityId || entityId === "none") continue;

    const activeTaskRaw = parseChecklistValue(promptText, "activeTask") ?? "entity.review|in_progress";
    const taskId = activeTaskRaw.split("|")[0] ?? "entity.review";
    const taskLabel = taskId.replace(/^entity\./, "").replace(/_/g, " ");
    const hasNoFollowUp = !response.decision.followUp;
    const verdictIsFinal = response.decision.verdict === "PASS" || response.decision.verdict === "FAIL";

    const current = groups[groups.length - 1];
    if (current && current.entityId === entityId) {
      current.stepEnd = response.step;
      current.finalVerdict = response.decision.verdict;
      current.finalized = current.finalized || hasNoFollowUp || verdictIsFinal;
    } else {
      groups.push({
        entityId,
        taskLabel,
        stepStart: response.step,
        stepEnd: response.step,
        finalVerdict: response.decision.verdict,
        finalized: hasNoFollowUp || verdictIsFinal,
      });
    }
  }

  const completed = groups
    .filter((group, index) => {
      if (group.finalized) return true;
      const next = groups[index + 1];
      return Boolean(next && next.entityId !== group.entityId);
    })
    .map((group, index) => ({
      taskLabel: `Task ${index + 1} - ${group.taskLabel}`,
      entityId: group.entityId,
      verdict: group.finalVerdict,
      stepStart: group.stepStart,
      stepEnd: group.stepEnd,
    }));

  const lastPrompt = trace.prompts[trace.prompts.length - 1];
  const entityProgressRaw = parseChecklistValue(lastPrompt?.promptText ?? "", "entityProgress");
  let remainingCount: number | null = null;
  if (entityProgressRaw && entityProgressRaw.includes("/")) {
    const [completedCountRaw, totalCountRaw] = entityProgressRaw.split("/");
    const completedCount = Number(completedCountRaw);
    const totalCount = Number(totalCountRaw);
    if (Number.isFinite(completedCount) && Number.isFinite(totalCount)) {
      remainingCount = Math.max(0, totalCount - completedCount);
    }
  }

  return { completed, remainingCount };
}

function generateEntitySummarySection(trace: ConversationTrace): string {
  const summary = buildEntitySummary(trace);
  const pendingCard = summary.remainingCount !== null && summary.remainingCount > 0
    ? `
      <div class="rule-card pending-card" style="margin-bottom: 12px;">
        <div class="title">${summary.remainingCount} more entit${summary.remainingCount === 1 ? "y needs" : "ies need"} check</div>
        <div class="description" style="margin-bottom: 8px;">These entities were still pending when the report was generated.</div>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
          <span class="badge" style="background:#9ca3af;color:#fff;">NEEDS CHECK</span>
          <span style="color:#4b5563;font-size:14px;">Remaining: ${summary.remainingCount}</span>
        </div>
      </div>
    `
    : "";

  if (!summary.completed.length) {
    return `
      <div class="section" id="entity-summary">
        <h2> Entity Summary</h2>
        <p style="color: #6b7280;">No entity tasks were completed in this run.</p>
        ${pendingCard}
      </div>
    `;
  }

  const cardsHtml = summary.completed
    .map(
      (item) => `
      <div class="rule-card" style="margin-bottom: 12px;">
        <div class="title">${escapeHtml(item.taskLabel)}</div>
        <div class="description" style="margin-bottom: 8px;">Entity: ${escapeHtml(item.entityId)}</div>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
          <span class="badge" style="background:${getVerdictColor(item.verdict)};color:#fff;">${escapeHtml(item.verdict)}</span>
          <span style="color:#4b5563;font-size:14px;">Steps ${item.stepStart}${item.stepEnd !== item.stepStart ? `-${item.stepEnd}` : ""}</span>
        </div>
      </div>
    `
    )
    .join("");

  return `
    <div class="section" id="entity-summary">
      <h2> Entity Summary</h2>
      ${cardsHtml}
      ${pendingCard}
    </div>
  `;
}

type EntityTraceGroup = {
  entityId: string | null;
  taskLabel: string;
  stepStart: number;
  stepEnd: number;
  responses: VlmResponseTrace[];
};

function buildEntityTraceGroups(trace: ConversationTrace): EntityTraceGroup[] {
  const promptByStep = new Map(trace.prompts.map((prompt) => [prompt.step, prompt]));
  const groupsByKey = new Map<string, EntityTraceGroup>();

  for (const response of trace.responses) {
    const promptText = promptByStep.get(response.step)?.promptText ?? "";
    const parsedEntityId = parseChecklistValue(promptText, "activeEntity");
    const entityId = parsedEntityId && parsedEntityId !== "none" ? parsedEntityId : null;
    const key = entityId ?? "__unassigned__";
    const activeTaskRaw = parseChecklistValue(promptText, "activeTask") ?? "entity.review|in_progress";
    const taskId = activeTaskRaw.split("|")[0] ?? "entity.review";
    const taskLabel = taskId.replace(/^entity\./, "").replace(/_/g, " ");
    const existing = groupsByKey.get(key);

    if (existing) {
      existing.stepEnd = response.step;
      existing.responses.push(response);
    } else {
      groupsByKey.set(key, {
        entityId,
        taskLabel,
        stepStart: response.step,
        stepEnd: response.step,
        responses: [response],
      });
    }
  }

  return Array.from(groupsByKey.values());
}

function renderSuppressedFollowUpPlaceholder(action: NavigationAction): string {
  const suppressed = action.suppressedFollowUp;
  if (!suppressed) return "";
  const title = `Suppressed "${suppressed.request}"`;
  const reason = suppressed.reason || action.finalizationReason || action.evaluationSummary || "The runtime blocked this follow-up before execution.";
  return `
    <div class="step-suppressed-card">
      <div class="step-suppressed-label">No New Snapshot</div>
      <div class="step-suppressed-title">${escapeHtml(title)}</div>
      <div class="step-suppressed-text">${escapeHtml(reason)}</div>
    </div>
  `;
}

function renderTraceStepItem(
  trace: ConversationTrace,
  response: VlmResponseTrace,
  snapshotsById: Map<string, ConversationTrace["snapshots"][number]>,
  promptByStep: Map<number, ConversationTrace["prompts"][number]>,
  snapshotIdByStep: Map<number, string>,
  navigationActionsByStep: Map<number, NavigationAction[]>
): string {
  const prompt = promptByStep.get(response.step);
  const promptSnapshotIds = prompt?.snapshotIds ?? [];
  const currentStepSnapshotId =
    snapshotIdByStep.get(response.step) ??
    trace.snapshots.find((snapshot) => snapshot.reason.includes(`compliance_step_${response.step}_`))?.snapshotId;
  const fallbackSnapshotId = currentStepSnapshotId ?? trace.snapshots[response.step - 1]?.snapshotId;
  const primarySnapshotId = fallbackSnapshotId ?? promptSnapshotIds[promptSnapshotIds.length - 1];
  const primarySnapshot = primarySnapshotId ? snapshotsById.get(primarySnapshotId) : undefined;
  const additionalSnapshotIds = promptSnapshotIds.filter((snapshotId) => snapshotId !== primarySnapshotId);
  const additionalSnapshotCount = additionalSnapshotIds.length;
  const stepActions = navigationActionsByStep.get(response.step) ?? [];
  const suppressedActions = stepActions.filter((action) => action.suppressedFollowUp);
  const uniqueSuppressedActions = suppressedActions.filter((action, index) => {
    const key = `${action.suppressedFollowUp?.request ?? ""}|${action.suppressedFollowUp?.reason ?? ""}`;
    return suppressedActions.findIndex(
      (candidate) =>
        `${candidate.suppressedFollowUp?.request ?? ""}|${candidate.suppressedFollowUp?.reason ?? ""}` === key
    ) === index;
  });
  const suppressedPlaceholders = uniqueSuppressedActions
    .map((action) => renderSuppressedFollowUpPlaceholder(action))
    .join("");

  const snapshotsHtml = primarySnapshot || suppressedPlaceholders
    ? `
    <div class="step-snapshots">
      <div class="step-snapshots-title">Visual evidence</div>
      ${additionalSnapshotCount > 0
        ? `<div class="step-snapshots-note">This VLM decision also cited ${additionalSnapshotCount} additional snapshot${additionalSnapshotCount === 1 ? "" : "s"}: ${additionalSnapshotIds.map(escapeHtml).join(", ")}.</div>`
        : ""}
      <div class="step-snapshots-grid">
        ${primarySnapshot
          ? `
        <figure class="step-snapshot-card">
          ${primarySnapshot.imageBase64
            ? `<img src="data:image/png;base64,${primarySnapshot.imageBase64}" alt="Snapshot ${primarySnapshot.snapshotId}" />`
            : `<div class="step-snapshot-placeholder">Image not embedded</div>`}
          <figcaption>
            <span class="snapshot-id">${escapeHtml(primarySnapshot.snapshotId)}</span>
            <span>${escapeHtml(primarySnapshot.reason)}</span>
            ${primarySnapshot.novelty ? `<span>${escapeHtml(formatSnapshotNovelty(primarySnapshot.novelty))}</span>` : ""}
          </figcaption>
        </figure>
        `
          : ""}
        ${suppressedPlaceholders}
      </div>
    </div>
  `
    : "";

  const semanticProgress = primarySnapshot?.semanticEvidenceProgress;
  const semanticNote = semanticProgress?.finalizationReason
    ? `<div class="meta" style="margin-top:8px;">Stopped because repeated views did not reduce missing evidence gaps.</div>`
    : semanticProgress?.semanticStagnationWarning
      ? `<div class="meta" style="margin-top:8px;">Semantic stagnation warning: unresolved evidence gaps stayed materially unchanged.</div>`
      : "";

  const promptHtml = prompt?.promptText
    ? `
    <details class="step-prompt">
      <summary>Prompt Text</summary>
      ${prompt.promptSource
        ? `<div style="padding: 0 12px 10px; color: #6b7280; font-size: 12px;">
        Source: ${escapeHtml(prompt.promptSource === "rule_library" ? "Rule Library" : "Custom User Prompt")}
        ${prompt.promptSourceLabel ? ` | Label: ${escapeHtml(prompt.promptSourceLabel)}` : ""}
      </div>`
        : ""}
      ${Array.isArray(prompt.webSourcesUsed) && prompt.webSourcesUsed.length > 0
        ? `<div style="padding: 0 12px 10px; color: #4b5563; font-size: 12px;">
        Web sources used:
        <ul style="margin: 6px 0 0 18px; padding: 0;">
          ${prompt.webSourcesUsed
            .map(
              (src) =>
                `<li>${escapeHtml(src.sourceType)} | ${escapeHtml(src.url)}${src.via ? ` | ${escapeHtml(src.via)}` : ""}</li>`
            )
            .join("")}
        </ul>
      </div>`
        : ""}
      <pre>${escapeHtml(prompt.promptText)}</pre>
    </details>
  `
    : "";

  return `
    <div class="step-item ${response.decision.verdict.toLowerCase()}">
      <div class="step-header">
        <span class="step-number">Step ${response.step}</span>
        <span class="badge" style="background: ${getVerdictColor(response.decision.verdict)}; color: #fff;">
          ${response.decision.verdict}
        </span>
        <span style="color: #6b7280; font-size: 12px;">
          ${formatConfidence(response.decision.confidence)} confidence
        </span>
      </div>
      <div class="step-content">
        <div class="rationale">${escapeHtml(response.decision.rationale)}</div>
        ${snapshotsHtml}
        ${semanticNote}
        ${promptHtml}
        <div class="meta">
          Response time: ${formatDuration(response.responseTimeMs)} |
          ${new Date(response.timestamp).toLocaleString()}
          ${response.decision.followUp ? ` | Next: ${response.decision.followUp.request}` : ""}
        </div>
      </div>
    </div>
  `;
}

/**
 * Generate entity-scoped step-by-step trace sections.
 */
function generateTraceSection(trace: ConversationTrace): string {
  if (trace.responses.length === 0) {
    return `
      <div class="section" id="trace-general">
        <h2> Step-by-Step Trace</h2>
        ${renderJudgeVerdictCard({ trace, entityId: null })}
        <p style="color: #6b7280;">No steps recorded.</p>
      </div>
    `;
  }

  const snapshotsById = new Map(trace.snapshots.map((snapshot) => [snapshot.snapshotId, snapshot]));
  const promptByStep = new Map(trace.prompts.map((prompt) => [prompt.step, prompt]));
  const navigationActionsByStep = new Map<number, NavigationAction[]>();
  for (const action of trace.navigationActions ?? []) {
    const bucket = navigationActionsByStep.get(action.step) ?? [];
    bucket.push(action);
    navigationActionsByStep.set(action.step, bucket);
  }
  const snapshotIdByStep = new Map(
    trace.sceneStates
      .filter((state) => state.step != null && Boolean(state.snapshotId))
      .map((state) => [state.step as number, state.snapshotId as string])
  );

  return buildEntityTraceGroups(trace)
    .map((group, index) => {
      const stepsHtml = group.responses
        .map((response) =>
          renderTraceStepItem(
            trace,
            response,
            snapshotsById,
            promptByStep,
            snapshotIdByStep,
            navigationActionsByStep
          )
        )
        .join("");
      const title = group.entityId
        ? `Entity ${escapeHtml(group.entityId)} - Step-by-Step Trace`
        : "Step-by-Step Trace";

      return `
        <div class="section" id="trace-${toAnchorId(group.entityId ?? `general-${index + 1}`)}">
          <h2> ${title}</h2>
          ${group.entityId ? `<p style="color:#6b7280;margin-bottom:12px;">Primary task: ${escapeHtml(group.taskLabel)} | Steps ${group.stepStart}${group.stepEnd !== group.stepStart ? `-${group.stepEnd}` : ""}</p>` : ""}
          ${renderJudgeVerdictCard({ trace, entityId: group.entityId, stepStart: group.stepStart, stepEnd: group.stepEnd })}
          ${renderEntitySnapshots(trace, group, snapshotsById, promptByStep, snapshotIdByStep)}
          <div class="step-timeline">
            ${stepsHtml}
          </div>
        </div>
      `;
    })
    .join("");
}

/**
 * Conversation trace format
 */
function generateWebEvidenceAppendix(trace: ConversationTrace): string {

  // De-duplicate web evidence records by sourceType+url+via, preferring non-cache and newer entries.
  const rawEntries = trace.webEvidence ?? [];

  const byKey = new Map<string, typeof rawEntries[number]>();

  for (const entry of rawEntries) {
    const key = `${entry.sourceType}|${entry.url}|${entry.via ?? ""}`;

    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, entry);
      continue;
    }

    // Prefer non-cache over cache, otherwise keep the newer one.
    const prevIsCached = !!prev.fromCache;
    const nextIsCached = !!entry.fromCache;

    if (prevIsCached && !nextIsCached) {
      byKey.set(key, entry);
      continue;
    }

    if (prevIsCached === nextIsCached) {
      if ((entry.fetchedAt ?? "") > (prev.fetchedAt ?? "")) {
        byKey.set(key, entry);
      }
    }
  }

  const entries = Array.from(byKey.values());

  if (entries.length === 0) {
    return renderAppendixSubsection("Web Evidence", `<p style="color: #6b7280;">No web evidence was recorded for this run.</p>`);
  }

  const itemsHtml = entries
    .map(
      (e, index) => {
        const appendixText = e.reducedText?.trim() ? e.reducedText : e.text;
        const appendixChars = appendixText.length;

        return `
      <div class="appendix-item">
        <h3>Source ${index + 1}</h3>
        <div class="appendix-meta">
          <div><strong>Step:</strong> ${e.step}</div>
          <div><strong>Type:</strong> ${escapeHtml(e.sourceType)}</div>
          <div><strong>Status:</strong> ${e.ok ? "OK" : "ERROR"}</div>
          <div><strong>Via:</strong> ${escapeHtml(e.via ?? "unknown")}</div>
          <div><strong>Chars:</strong> ${appendixChars}</div>
          ${e.reducedText?.trim() ? `<div><strong>Original chars:</strong> ${e.chars}</div>` : ""}
          <div><strong>Fetched:</strong> ${escapeHtml(new Date(e.fetchedAt).toLocaleString())}</div>
          ${e.fromCache ? `<div><strong>Cache:</strong> ${escapeHtml(e.fromCache)}</div>` : ""}
        </div>
        ${e.title ? `<div style="margin-bottom: 8px;"><strong>Title:</strong> ${escapeHtml(e.title)}</div>` : ""}
        <div style="margin-bottom: 8px;"><strong>URL:</strong> ${escapeHtml(e.url)}</div>
        ${e.query ? `<div style="margin-bottom: 8px;"><strong>Query:</strong> ${escapeHtml(e.query)}</div>` : ""}
        ${e.error ? `<div style="margin-bottom: 8px; color: #b91c1c;"><strong>Error:</strong> ${escapeHtml(e.error)}</div>` : ""}
        <div class="appendix-text">${escapeHtml(appendixText)}</div>
      </div>
    `
          }
    )
    .join("");

  return renderAppendixSubsection("Web Evidence", `
      <p style="color: #4b5563; margin-bottom: 16px;">
        The following regulatory/web evidence was retrieved during the inspection and injected into the VLM context.
      </p>
      ${itemsHtml}
    `);
}

function formatShortCameraPose(actionState: NavigationAction["beforeState"] | NavigationAction["afterState"] | undefined): string {
  const pose = actionState?.cameraPose;
  if (!pose) return "N/A";
  const eye = `${pose.eye.x.toFixed(2)}, ${pose.eye.y.toFixed(2)}, ${pose.eye.z.toFixed(2)}`;
  const target = `${pose.target.x.toFixed(2)}, ${pose.target.y.toFixed(2)}, ${pose.target.z.toFixed(2)}`;
  return `eye(${eye}) -> target(${target})`;
}

function formatShortPlanCut(actionState: NavigationAction["beforeState"] | NavigationAction["afterState"] | undefined): string {
  const planCut = actionState?.planCut;
  if (!planCut?.enabled) return "off";
  const bits = [
    planCut.storeyId ? `storey ${planCut.storeyId}` : null,
    typeof planCut.absoluteHeight === "number" ? `abs ${planCut.absoluteHeight.toFixed(2)}` : null,
    typeof planCut.height === "number" ? `rel ${planCut.height.toFixed(2)}` : null,
    planCut.mode ?? null,
  ].filter(Boolean);
  return bits.length ? bits.join(" | ") : "on";
}

function formatNavigationMetrics(action: NavigationAction): string {
  const metrics = action.navigationMetrics;
  if (!metrics) return "N/A";
  const parts = [
    typeof metrics.targetAreaRatio === "number" ? `area ${metrics.targetAreaRatio.toFixed(3)}` : null,
    typeof metrics.occlusionRatio === "number" ? `occ ${metrics.occlusionRatio.toFixed(3)}` : null,
    metrics.zoomExhausted ? "zoom exhausted" : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" | ") : "Recorded";
}

function getScoreFillColor(score: number, mode: "novelty" | "progress" | "recurrence"): string {
  if (mode === "recurrence") {
    if (score >= 0.65) return "#f59e0b";
    if (score >= 0.4) return "#fbbf24";
    return "#94a3b8";
  }
  if (score >= 0.7) return "#22c55e";
  if (score >= 0.35) return "#3b82f6";
  return "#94a3b8";
}

function renderNoveltyBadges(action: NavigationAction): string {
  const novelty = action.snapshotNoveltyBeforeAction;
  const semantic = action.semanticEvidenceProgress;
  const badges: string[] = [];

  if (novelty?.redundancyWarning) {
    badges.push(`<span class="novelty-badge warn">visual redundant</span>`);
  }
  if (semantic?.semanticStagnationWarning) {
    badges.push(`<span class="novelty-badge alert">semantic stagnation</span>`);
  }
  if (semantic?.sameEntityRecurrenceWarning) {
    badges.push(`<span class="novelty-badge warn">same-entity recurrence</span>`);
  }
  if (action.suppressedFollowUp) {
    badges.push(`<span class="novelty-badge alert">suppressed ${escapeHtml(action.suppressedFollowUp.request)}</span>`);
  }

  return badges.length ? `<div class="novelty-meta">${badges.join("")}</div>` : "";
}

function renderNavigationNoveltyScores(action: NavigationAction): string {
  const novelty = action.snapshotNoveltyBeforeAction;
  const semantic = action.semanticEvidenceProgress;
  const visualScore = novelty?.approximateNoveltyScore;
  const semanticScore = semantic?.semanticProgressScore;
  const recurrenceScore = semantic?.sameEntityRecurrenceScore;

  const cards = [
    typeof visualScore === "number"
      ? `
        <div class="novelty-card">
          <div class="novelty-card-header">
            <span class="novelty-card-title">Visual Novelty</span>
            <span class="novelty-card-score">${visualScore.toFixed(2)}</span>
          </div>
          <div class="novelty-bar"><div class="novelty-bar-fill" style="width:${(visualScore * 100).toFixed(0)}%;background:${getScoreFillColor(visualScore, "novelty")};"></div></div>
          <div class="novelty-meta">
            ${novelty?.comparedToSnapshotId ? `<span class="novelty-badge">vs ${escapeHtml(novelty.comparedToSnapshotId)}</span>` : ""}
            ${novelty?.sameEntityAsPrevious ? `<span class="novelty-badge">same entity</span>` : `<span class="novelty-badge">cross-step baseline</span>`}
            ${novelty?.redundancyWarning ? `<span class="novelty-badge warn">redundancy warning</span>` : ""}
          </div>
        </div>
      `
      : "",
    typeof semanticScore === "number"
      ? `
        <div class="novelty-card">
          <div class="novelty-card-header">
            <span class="novelty-card-title">Semantic Progress</span>
            <span class="novelty-card-score">${semanticScore.toFixed(2)}</span>
          </div>
          <div class="novelty-bar"><div class="novelty-bar-fill" style="width:${(semanticScore * 100).toFixed(0)}%;background:${getScoreFillColor(semanticScore, "progress")};"></div></div>
          <div class="novelty-meta">
            <span class="novelty-badge">resolved ${semantic?.resolvedGapCount ?? 0}</span>
            <span class="novelty-badge">unchanged ${semantic?.unchangedGapCount ?? 0}</span>
            <span class="novelty-badge">new ${semantic?.newGapCount ?? 0}</span>
            ${semantic?.semanticStagnationWarning ? `<span class="novelty-badge alert">stagnation</span>` : ""}
          </div>
        </div>
      `
      : "",
    typeof recurrenceScore === "number"
      ? `
        <div class="novelty-card">
          <div class="novelty-card-header">
            <span class="novelty-card-title">Same-Entity Recurrence</span>
            <span class="novelty-card-score">${recurrenceScore.toFixed(2)}</span>
          </div>
          <div class="novelty-bar"><div class="novelty-bar-fill" style="width:${(recurrenceScore * 100).toFixed(0)}%;background:${getScoreFillColor(recurrenceScore, "recurrence")};"></div></div>
          <div class="novelty-meta">
            ${semantic?.sameEntityRecurrenceComparedSnapshotId ? `<span class="novelty-badge">vs ${escapeHtml(semantic.sameEntityRecurrenceComparedSnapshotId)}</span>` : ""}
            ${typeof semantic?.sameEntityRecurrenceStepDelta === "number" ? `<span class="novelty-badge">Δstep ${semantic.sameEntityRecurrenceStepDelta}</span>` : ""}
            ${typeof semantic?.sameEntityRecurrenceDecayWeight === "number" ? `<span class="novelty-badge">decay ${semantic.sameEntityRecurrenceDecayWeight.toFixed(2)}</span>` : ""}
            ${typeof semantic?.sameEntityRecurrenceViewSimilarity === "number" ? `<span class="novelty-badge">view sim ${semantic.sameEntityRecurrenceViewSimilarity.toFixed(2)}</span>` : ""}
            ${typeof semantic?.sameEntityRecurrenceFailureWeight === "number" ? `<span class="novelty-badge">failure ${semantic.sameEntityRecurrenceFailureWeight.toFixed(2)}</span>` : ""}
            ${semantic?.sameEntityRecurrenceWarning ? `<span class="novelty-badge warn">warning</span>` : ""}
          </div>
        </div>
      `
      : "",
  ].filter(Boolean);

  if (!cards.length) return "N/A";
  return `<div class="novelty-stack">${cards.join("")}${renderNoveltyBadges(action)}</div>`;
}

function getNavigationResultClass(action: NavigationAction): "success" | "no-op" | "suppressed" {
  if (action.suppressedFollowUp) return "suppressed";
  return action.success ? "success" : "no-op";
}

function getNavigationResultLabel(action: NavigationAction): string {
  if (action.suppressedFollowUp) return "suppressed";
  return action.success ? "success" : "no-op";
}

function renderNavigationActionDetails(action: NavigationAction): string {
  return `
    <details class="nav-log-details">
      <summary>Technical View State</summary>
      <div class="nav-log-details-grid">
        <div class="nav-log-detail-card">
          <span class="nav-log-detail-title">Camera Before / After</span>
          ${escapeHtml(formatShortCameraPose(action.beforeState))}<br>
          ${escapeHtml(formatShortCameraPose(action.afterState))}
        </div>
        <div class="nav-log-detail-card">
          <span class="nav-log-detail-title">Highlights Before / After</span>
          ${escapeHtml((action.beforeState?.highlightedIds ?? []).join(", ") || "none")}<br>
          ${escapeHtml((action.afterState?.highlightedIds ?? []).join(", ") || "none")}
        </div>
        <div class="nav-log-detail-card">
          <span class="nav-log-detail-title">Plan Cut Before / After</span>
          ${escapeHtml(formatShortPlanCut(action.beforeState))}<br>
          ${escapeHtml(formatShortPlanCut(action.afterState))}
        </div>
      </div>
    </details>
  `;
}

function generateNavigationAppendix(trace: ConversationTrace): string {
  const actions = trace.navigationActions ?? [];
  if (!actions.length) {
    return renderAppendixSubsection(
      "Navigation Action Evaluation Log",
      `<p style="color: #6b7280;">No deterministic navigation follow-up evaluations were recorded for this run.</p>`
    );
  }

  const cards = actions
    .map(
      (action) => `
        <div class="nav-log-card">
          <div class="nav-log-card-header">
            <div>
              <div class="nav-log-step">Step ${action.step}</div>
              <div class="nav-log-entity">${escapeHtml(action.activeEntityId ?? "No active entity")}</div>
              <div class="nav-log-storey">${escapeHtml(action.activeStoreyId ?? "No scoped storey")}</div>
            </div>
            <span class="nav-log-result ${getNavigationResultClass(action)}">${escapeHtml(getNavigationResultLabel(action))}</span>
          </div>
          <div class="nav-log-summary">
            <span class="nav-log-chip">Requested ${escapeHtml(action.requestedAction ?? action.action)}</span>
            <span class="nav-log-chip">Executed ${escapeHtml(action.action)}</span>
            <span class="nav-log-chip">${escapeHtml(formatNavigationMetrics(action))}</span>
            ${action.actionFamily ? `<span class="nav-log-chip">family ${escapeHtml(action.actionFamily)}</span>` : ""}
            ${action.suppressedFollowUp ? `<span class="nav-log-chip">suppressed ${escapeHtml(action.suppressedFollowUp.request)}</span>` : ""}
          </div>
          <div class="nav-log-grid">
            <div>${renderNavigationNoveltyScores(action)}</div>
            <div class="nav-log-text">
              ${escapeHtml(action.evaluationSummary ?? action.reason ?? "N/A")}
              <div class="nav-log-meta">
                ${action.decisionSource ? `<div><strong>Decision source:</strong> ${escapeHtml(action.decisionSource)}</div>` : ""}
                ${action.decisionReason ? `<div><strong>Decision reason:</strong> ${escapeHtml(action.decisionReason)}</div>` : ""}
                ${action.noOpReason && !action.suppressedFollowUp ? `<div><strong>No-op reason:</strong> ${escapeHtml(action.noOpReason)}</div>` : ""}
              </div>
            </div>
          </div>
          ${renderNavigationActionDetails(action)}
        </div>
      `
    )
    .join("");

  return renderAppendixSubsection(
    "Navigation Action Evaluation Log",
    `
      <p style="color: #4b5563; margin-bottom: 16px;">
        Deterministic, paper-inspired navigation evaluations recorded after each executed VLM follow-up action, including local visual novelty, semantic evidence progress, and same-entity recurrence risk.
      </p>
      <div class="nav-log-list">${cards}</div>
    `
  );
}

function formatSettingValue(value: unknown): string {
  if (value == null) return "N/A";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return String(value);
  return JSON.stringify(value, null, 2);
}

function renderSettingsTable(settings: object): string {
  return `
    <div class="settings-grid">
      ${Object.entries(settings)
        .map(
          ([key, value]) => `
        <div class="settings-entry">
          <span class="settings-key">${escapeHtml(key)}</span>
          <span class="settings-value">${escapeHtml(formatSettingValue(value))}</span>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

function generatePrototypeSettingsAppendix(): string {
  const runtimeSettings = getPrototypeRuntimeSettings();

  return renderAppendixSubsection("Prototype Settings Values", `
    <div class="appendix-item">
      <h3>Runtime Settings</h3>
      ${renderSettingsTable(runtimeSettings)}
    </div>
    <div class="appendix-item">
      <h3>Default Runtime Settings</h3>
      ${renderSettingsTable(DEFAULT_PROTOTYPE_RUNTIME_SETTINGS)}
    </div>
    <div class="appendix-item">
      <h3>Static Prototype Constants</h3>
      ${renderSettingsTable({
        DEFAULT_MAX_COMPLIANCE_STEPS,
        REPEATED_FOLLOW_UPS_BEFORE_ESCALATION,
        ENTITY_UNCERTAIN_TERMINATION_STEPS,
        ENTITY_UNCERTAIN_TERMINATION_CONFIDENCE,
        ENTITY_REPEATED_WORKFLOW_TERMINATION_STEPS,
        DEFAULT_MAX_SNAPSHOTS_PER_REQUEST,
        DEFAULT_TAVILY_MAX_CHARS,
        DEFAULT_REDUCED_TAVILY_MAX_CHARS,
        HIGHLIGHT_TARGET_AREA_RATIO,
        ZOOM_IN_EXHAUSTION_AREA_FACTOR,
        TOP_VIEW_TARGET_AREA_RATIO,
        MAX_ORBIT_FOLLOW_UPS_PER_ENTITY,
        MAX_ORBIT_DEGREES_PER_AXIS,
        ORBIT_MAX_HIGHLIGHT_OCCLUSION_RATIO,
        SEMANTIC_FOLLOW_UP_FAMILY_BUDGETS,
      })}
    </div>
    <div class="appendix-item">
      <h3>Navigation and Visual Defaults</h3>
      ${renderSettingsTable({
        HIGHLIGHT_ANNOTATION_DEFAULTS,
        HIGHLIGHT_NAVIGATION_DEFAULTS,
        RAMP_NAVIGATION_DEFAULTS,
        DOOR_CLEARANCE_DEFAULTS,
      })}
    </div>
  `);
}

function generateAppendixSection(trace: ConversationTrace, embedImages: boolean): string {
  return `
    <div class="section" id="appendix">
      <h2> Appendix</h2>
      ${renderAppendixSubsection("All Snapshots", renderSnapshotsGrid(trace, embedImages))}
      ${generateNavigationAppendix(trace)}
      ${generateJudgeAppendixSection(trace)}
      ${generateWebEvidenceAppendix(trace)}
      ${generatePrototypeSettingsAppendix()}
    </div>
  `;
}

/**
 * Generate a standalone HTML report from a conversation trace
 */
export function generateHtmlReport(trace: ConversationTrace, options: ReportOptions = {}): string {
  const { embedImages = true, title } = options;

  const reportTitle = title ?? `Compliance Report: ${trace.rule.title} with ${getFriendlyVlmName(trace)}`;
  const generatedAt = new Date().toISOString();
  const reportNavigation = buildReportNavigation(trace);
  const reportActions = buildReportActions();

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(reportTitle)}</title>
  <style>${generateCss()}</style>
</head>
<body>
  <div class="page-layout">
    ${reportNavigation}
    <div class="container">
      <div class="header" id="report-top">
        <h1>${escapeHtml(reportTitle)}</h1>
        <div class="meta">
          Generated: ${new Date(generatedAt).toLocaleString()} | 
          Run ID: ${trace.runId.slice(0, 8)} | 
          Duration: ${trace.startedAt && trace.completedAt ? formatDuration(new Date(trace.completedAt).getTime() - new Date(trace.startedAt).getTime()) : "N/A"}
        </div>
      </div>

      ${generateRuleSection(trace)}
      ${generateSummarySection(trace)}
      ${generateMetricsSection(trace.metrics)}
      ${generateEntitySummarySection(trace)}
      ${generateTraceSection(trace)}
      ${generateAppendixSection(trace, embedImages)}

      <div class="footer">
        <p>IFC/BIM Visual Compliance Checker | Report Version 1.0.0</p>
        <p>This report was automatically generated by the VLM-based compliance checking system.</p>
      </div>
    </div>
    ${reportActions}
  </div>
</body>
</html>
  `.trim();
}

/**
 * Download HTML report as a file
 */
export function downloadHtmlReport(trace: ConversationTrace, options: ReportOptions = {}): void {
  const html = generateHtmlReport(trace, options);
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `compliance_report_${trace.rule.id}_${new Date().toISOString().slice(0, 10)}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
