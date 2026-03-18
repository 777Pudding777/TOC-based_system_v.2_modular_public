/**
 * src/reporting/reportGenerator.ts
 * Generates standalone HTML reports for compliance inspection results.
 * Reports include rule info, snapshots, step-by-step trace, findings, and metrics.
 *
 * @module reportGenerator
 */

import type { ConversationTrace, StressedFinding, InspectionMetrics, WebEvidenceRecord } from "../types/trace.types";
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
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
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
      height: 600px;
      object-fit: cover;
      background: #111827;
    }

    .step-snapshot-placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 600px;
      background: #1f2937;
      color: #9ca3af;
      font-size: 12px;
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

    @media print {
      body {
        background: #fff;
        padding: 0;
      }
      .container {
        box-shadow: none;
      }
      .snapshot-card img {
        height: auto;
        max-height: 200px;
      }
    }
  `;
}

/**
 * Generate summary section
 */
function generateSummarySection(trace: ConversationTrace): string {
  const verdictColor = getVerdictColor(trace.finalVerdict ?? "UNCERTAIN");
  // Severity color used in rule section, not summary
  void getSeverityColor(trace.rule.severity);

  return `
    <div class="section">
      <h2> Inspection Summary</h2>
      <div style="display: flex; align-items: center; gap: 24px; margin-bottom: 16px;">
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
            ${trace.finalConfidence ? formatConfidence(trace.finalConfidence) : "N/A"}
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
      ${trace.finalRationale ? `<p style="color: #374151;">${escapeHtml(trace.finalRationale)}</p>` : ""}
    </div>
  `;
}

/**
 * Generate rule info section
 */
function generateRuleSection(trace: ConversationTrace): string {
  const severityColor = getSeverityColor(trace.rule.severity);

  return `
    <div class="section">
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
    <div class="section">
      <h2> Evaluation Metrics</h2>
      <div class="metrics-grid">
        <div class="metric-card">
          <div class="value">${metrics.totalSnapshots}</div>
          <div class="label">Snapshots</div>
        </div>
        <div class="metric-card">
          <div class="value">${metrics.totalVlmCalls}</div>
          <div class="label">VLM Calls</div>
        </div>
        <div class="metric-card">
          <div class="value">${metrics.totalNavigationSteps}</div>
          <div class="label">Navigation Steps</div>
        </div>
        <div class="metric-card">
          <div class="value">${formatDuration(metrics.totalDurationMs)}</div>
          <div class="label">Total Duration</div>
        </div>
        <div class="metric-card">
          <div class="value">${formatDuration(metrics.avgVlmResponseTimeMs)}</div>
          <div class="label">Avg Response Time</div>
        </div>
        <div class="metric-card">
          <div class="value">${formatConfidence(metrics.avgConfidence)}</div>
          <div class="label">Avg Confidence</div>
        </div>
        <div class="metric-card">
          <div class="value">${metrics.uncertainSteps}</div>
          <div class="label">Uncertain Steps</div>
        </div>
      </div>
    </div>
  `;
}

/**
 * Generate findings section
 */
function generateFindingsSection(findings: StressedFinding[]): string {
  if (findings.length === 0) {
    return `
      <div class="section">
        <h2> Stressed Findings</h2>
        <p style="color: #6b7280;">No specific findings recorded.</p>
      </div>
    `;
  }

  const findingsHtml = findings
    .map(
      (f) => `
      <div class="finding-card ${f.type.toLowerCase()}">
        <div class="message">
          <span class="badge" style="background: ${getVerdictColor(f.type === "WARNING" ? "UNCERTAIN" : f.type)}; color: #fff; margin-right: 8px;">
            ${f.type}
          </span>
          ${escapeHtml(f.message)}
        </div>
        <div class="details">${escapeHtml(f.details)}</div>
        <div style="margin-top: 8px; font-size: 12px; color: #6b7280;">
          Confidence: ${formatConfidence(f.confidence)} | Step ${f.step}
        </div>
      </div>
    `
    )
    .join("");

  return `
    <div class="section">
      <h2> Stressed Findings</h2>
      ${findingsHtml}
    </div>
  `;
}

/**
 * Generate snapshots section
 */
function generateSnapshotsSection(trace: ConversationTrace, embedImages: boolean): string {
  if (trace.snapshots.length === 0) {
    return `
      <div class="section">
        <h2> Snapshots</h2>
        <p style="color: #6b7280;">No snapshots captured.</p>
      </div>
    `;
  }

  const snapshotsHtml = trace.snapshots
    .map(
      (s) => `
      <div class="snapshot-card">
        ${embedImages && s.imageBase64 ? `<img src="data:image/png;base64,${s.imageBase64}" alt="Snapshot ${s.snapshotId}" />` : `<div style="height: 200px; background: #1f2937; display: flex; align-items: center; justify-content: center; color: #6b7280;">Image not embedded</div>`}
        <div class="info">
          <div class="reason">${escapeHtml(s.reason)}</div>
          <div class="time">${new Date(s.timestamp).toLocaleString()}</div>
        </div>
      </div>
    `
    )
    .join("");

  return `
    <div class="section">
      <h2> Snapshots (${trace.snapshots.length})</h2>
      <div class="snapshot-grid">
        ${snapshotsHtml}
      </div>
    </div>
  `;
}

/**
 * Generate step-by-step trace section
 */
function generateTraceSection(trace: ConversationTrace): string {
  if (trace.responses.length === 0) {
    return `
      <div class="section">
        <h2> Step-by-Step Trace</h2>
        <p style="color: #6b7280;">No steps recorded.</p>
      </div>
    `;
  }

  const snapshotsById = new Map(trace.snapshots.map((snapshot) => [snapshot.snapshotId, snapshot]));
  const promptByStep = new Map(trace.prompts.map((prompt) => [prompt.step, prompt]));

  const stepsHtml = trace.responses
    .map(
      (r) => {
        const prompt = promptByStep.get(r.step);
        const evidenceSnapshots = (prompt?.snapshotIds ?? [])
          .map((snapshotId) => snapshotsById.get(snapshotId))
          .filter((snapshot): snapshot is NonNullable<typeof snapshot> => !!snapshot);

        const snapshotsHtml = evidenceSnapshots.length
          ? `
          <div class="step-snapshots">
            <div class="step-snapshots-title">Visual evidence</div>
            <div class="step-snapshots-grid">
              ${evidenceSnapshots
                .map(
                  (snapshot) => `
                <figure class="step-snapshot-card">
                  ${snapshot.imageBase64
                    ? `<img src="data:image/png;base64,${snapshot.imageBase64}" alt="Snapshot ${snapshot.snapshotId}" />`
                    : `<div class="step-snapshot-placeholder">Image not embedded</div>`}
                  <figcaption>
                    <span class="snapshot-id">${escapeHtml(snapshot.snapshotId)}</span>
                    <span>${escapeHtml(snapshot.reason)}</span>
                  </figcaption>
                </figure>
              `
                )
                .join("")}
            </div>
          </div>
        `
          : "";

        return `
      <div class="step-item ${r.decision.verdict.toLowerCase()}">
        <div class="step-header">
          <span class="step-number">Step ${r.step}</span>
          <span class="badge" style="background: ${getVerdictColor(r.decision.verdict)}; color: #fff;">
            ${r.decision.verdict}
          </span>
          <span style="color: #6b7280; font-size: 12px;">
            ${formatConfidence(r.decision.confidence)} confidence
          </span>
        </div>
        <div class="step-content">
          <div class="rationale">${escapeHtml(r.decision.rationale)}</div>
          ${snapshotsHtml}
          <div class="meta">
            Response time: ${formatDuration(r.responseTimeMs)} | 
            ${new Date(r.timestamp).toLocaleString()}
            ${r.decision.followUp ? ` | Next: ${r.decision.followUp.request}` : ""}
          </div>
        </div>
      </div>
    `;
      }
    )
    .join("");

  return `
    <div class="section">
      <h2> Step-by-Step Trace</h2>
      <div class="step-timeline">
        ${stepsHtml}
      </div>
    </div>
  `;
}

/**
 * Generate model info section
 */
function generateModelSection(trace: ConversationTrace): string {
  return `
    <div class="section">
      <h2> Model Information</h2>
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px;">
        <div>
          <span style="color: #6b7280; font-size: 12px;">Provider</span>
          <div style="font-weight: 500;">${escapeHtml(trace.model.provider)}</div>
        </div>
        <div>
          <span style="color: #6b7280; font-size: 12px;">Model</span>
          <div style="font-weight: 500;">${escapeHtml(trace.model.name)}</div>
        </div>
        <div>
          <span style="color: #6b7280; font-size: 12px;">Model ID</span>
          <div style="font-weight: 500;">${escapeHtml(trace.model.id)}</div>
        </div>
      </div>
    </div>
  `;
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
    return `
      <div class="section">
        <h2> Appendix: Regulatory / Web Evidence</h2>
        <p style="color: #6b7280;">No web evidence was recorded for this run.</p>
      </div>
    `;
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

  return `
    <div class="section">
      <h2> Appendix: Regulatory / Web Evidence</h2>
      <p style="color: #4b5563; margin-bottom: 16px;">
        The following regulatory/web evidence was retrieved during the inspection and injected into the VLM context.
      </p>
      ${itemsHtml}
    </div>
  `;
}

/**
 * Generate a standalone HTML report from a conversation trace
 */
export function generateHtmlReport(trace: ConversationTrace, options: ReportOptions = {}): string {
  const { embedImages = true, title } = options;

  const reportTitle = title ?? `Compliance Report: ${trace.rule.title}`;
  const generatedAt = new Date().toISOString();

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
  <div class="container">
    <div class="header">
      <h1>${escapeHtml(reportTitle)}</h1>
      <div class="meta">
        Generated: ${new Date(generatedAt).toLocaleString()} | 
        Run ID: ${trace.runId.slice(0, 8)} | 
        Duration: ${trace.startedAt && trace.completedAt ? formatDuration(new Date(trace.completedAt).getTime() - new Date(trace.startedAt).getTime()) : "N/A"}
      </div>
    </div>

    ${generateSummarySection(trace)}
    ${generateRuleSection(trace)}
    ${generateMetricsSection(trace.metrics)}
    ${generateFindingsSection(trace.stressedFindings)}
    ${generateSnapshotsSection(trace, embedImages)}
    ${generateTraceSection(trace)}
    ${generateModelSection(trace)}
    ${generateWebEvidenceAppendix(trace)}

    <div class="footer">
      <p>IFC/BIM Visual Compliance Checker | Report Version 1.0.0</p>
      <p>This report was automatically generated by the VLM-based compliance checking system.</p>
    </div>
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
