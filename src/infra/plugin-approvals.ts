import type { ExecApprovalDecision } from "./exec-approvals.js";

export type PluginApprovalRequestPayload = {
  pluginId?: string | null;
  title: string;
  description: string;
  severity?: "info" | "warning" | "critical" | null;
  toolName?: string | null;
  toolCallId?: string | null;
  allowedDecisions?: readonly ExecApprovalDecision[] | null;
  agentId?: string | null;
  sessionKey?: string | null;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
};

export type PluginApprovalRequest = {
  id: string;
  request: PluginApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
};

export type PluginApprovalResolved = {
  id: string;
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
  ts: number;
  request?: PluginApprovalRequestPayload;
};

export const DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS = 120_000;
export const MAX_PLUGIN_APPROVAL_TIMEOUT_MS = 600_000;
export const PLUGIN_APPROVAL_TITLE_MAX_LENGTH = 80;
export const PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH = 256;
export const DEFAULT_PLUGIN_APPROVAL_DECISIONS = [
  "allow-once",
  "allow-always",
  "deny",
] as const satisfies readonly ExecApprovalDecision[];

export function approvalDecisionLabel(decision: ExecApprovalDecision): string {
  if (decision === "allow-once") {
    return "allowed once";
  }
  if (decision === "allow-always") {
    return "allowed always";
  }
  return "denied";
}

export function resolvePluginApprovalRequestAllowedDecisions(params?: {
  allowedDecisions?: readonly ExecApprovalDecision[] | readonly string[] | null;
}): readonly ExecApprovalDecision[] {
  const explicit: ExecApprovalDecision[] = [];
  if (Array.isArray(params?.allowedDecisions)) {
    for (const decision of params.allowedDecisions) {
      if (
        (decision === "allow-once" || decision === "allow-always" || decision === "deny") &&
        !explicit.includes(decision)
      ) {
        explicit.push(decision);
      }
    }
  }
  return explicit.length > 0 ? explicit : DEFAULT_PLUGIN_APPROVAL_DECISIONS;
}

export function buildPluginApprovalRequestMessage(
  request: PluginApprovalRequest,
  nowMsValue: number,
): string {
  const lines: string[] = [];
  const severity = request.request.severity ?? "warning";
  const icon = severity === "critical" ? "🚨" : severity === "info" ? "ℹ️" : "🛡️";
  lines.push(`${icon} Plugin approval required`);
  lines.push(`Title: ${request.request.title}`);
  lines.push(`Description: ${request.request.description}`);
  if (request.request.toolName) {
    lines.push(`Tool: ${request.request.toolName}`);
  }
  if (request.request.pluginId) {
    lines.push(`Plugin: ${request.request.pluginId}`);
  }
  if (request.request.agentId) {
    lines.push(`Agent: ${request.request.agentId}`);
  }
  lines.push(`ID: ${request.id}`);
  const expiresIn = Math.max(0, Math.round((request.expiresAtMs - nowMsValue) / 1000));
  lines.push(`Expires in: ${expiresIn}s`);
  // The reply parser also accepts a bare `/approve <decision>` (no id)
  // when there is exactly one pending approval — better UX on phones than
  // pasting a uuid. The id above is for the unambiguous form when multiple
  // approvals are queued. Decisions list is dynamic per upstream support
  // for `request.allowedDecisions` (defaults to all three).
  lines.push(
    `Reply with: ${resolvePluginApprovalRequestAllowedDecisions(request.request)
      .map((d) => `/approve ${d}`)
      .join("   |   ")}`,
  );
  return lines.join("\n");
}

export function buildPluginApprovalResolvedMessage(resolved: PluginApprovalResolved): string {
  const base = `✅ Plugin approval ${approvalDecisionLabel(resolved.decision)}.`;
  const by = resolved.resolvedBy ? ` Resolved by ${resolved.resolvedBy}.` : "";
  return `${base}${by} ID: ${resolved.id}`;
}

export function buildPluginApprovalExpiredMessage(request: PluginApprovalRequest): string {
  return `⏱️ Plugin approval expired. ID: ${request.id}`;
}
