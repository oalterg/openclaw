import crypto from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import { setPluginToolMeta } from "../plugins/tools.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { isPlainObject } from "../utils.js";
import {
  buildConsentDeniedResult,
  defaultRequestMcpConsentApproval,
  detectMcpConsentEnvelope,
  type RequestMcpConsentApproval,
  scrubModelSuppliedConfirmationToken,
} from "./pi-bundle-mcp-consent.js";
import {
  buildSafeToolName,
  normalizeReservedToolNames,
  TOOL_NAME_SEPARATOR,
} from "./pi-bundle-mcp-names.js";
import type { BundleMcpToolRuntime, SessionMcpRuntime } from "./pi-bundle-mcp-types.js";
import { normalizeToolParameterSchema } from "./pi-tools-parameter-schema.js";
import type { AnyAgentTool } from "./tools/common.js";

function toAgentToolResult(params: {
  serverName: string;
  toolName: string;
  result: CallToolResult;
}): AgentToolResult<unknown> {
  const content = Array.isArray(params.result.content)
    ? (params.result.content as AgentToolResult<unknown>["content"])
    : [];
  const normalizedContent: AgentToolResult<unknown>["content"] =
    content.length > 0
      ? content
      : params.result.structuredContent !== undefined
        ? [
            {
              type: "text",
              text: JSON.stringify(params.result.structuredContent, null, 2),
            },
          ]
        : ([
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: params.result.isError === true ? "error" : "ok",
                  server: params.serverName,
                  tool: params.toolName,
                },
                null,
                2,
              ),
            },
          ] as AgentToolResult<unknown>["content"]);
  const details: Record<string, unknown> = {
    mcpServer: params.serverName,
    mcpTool: params.toolName,
  };
  if (params.result.structuredContent !== undefined) {
    details.structuredContent = params.result.structuredContent;
  }
  if (params.result.isError === true) {
    details.status = "error";
  }
  return {
    content: normalizedContent,
    details,
  };
}

/** Resolve `mcp.approvals` config into the two values the materializer
 *  consumes. Explicit caller overrides (typically from tests) take
 *  precedence over the OpenClaw config. */
export function resolveMcpApprovalsConfig(
  cfg: OpenClawConfig | undefined,
  overrides?: { consentEnabled?: boolean; consentDefaultTimeoutMs?: number },
): { consentEnabled: boolean; consentDefaultTimeoutMs: number | undefined } {
  const cfgFlag = cfg?.mcp?.approvals?.enabled;
  const consentEnabled =
    overrides?.consentEnabled !== undefined ? overrides.consentEnabled : cfgFlag !== false;
  const consentDefaultTimeoutMs =
    overrides?.consentDefaultTimeoutMs ?? cfg?.mcp?.approvals?.defaultTimeoutMs;
  return { consentEnabled, consentDefaultTimeoutMs };
}

/** Run a single MCP tool call through the consent gate.
 *
 *  Pure protocol — no global state. The flow is:
 *
 *    1. Strip any model-supplied `confirmation_token` from input. Only the
 *       consent path is allowed to set it; otherwise the model could
 *       fabricate a token and self-approve.
 *    2. callTool. If the response is an ordinary tool result, return it.
 *    3. Detect an `{ok:false, requires_confirmation:true, action_id, summary}`
 *       envelope. If absent, return the result verbatim.
 *    4. Issue an approval through the gateway plugin-approval pipeline.
 *       Block until the user replies `/approve <id> ...` on the trusted
 *       channel, decision expires, or the system is unavailable.
 *    5. On allow-once / allow-always: call the tool again with
 *       `confirmation_token = action_id`. Return that result.
 *    6. On deny / expired / error: return a synthetic denied result.
 *       The model never sees `action_id`.
 */
export async function callMcpToolWithConsent(params: {
  runtime: SessionMcpRuntime;
  serverName: string;
  toolName: string;
  agentToolName: string;
  toolCallId?: string;
  agentId?: string;
  sessionKey?: string;
  input: unknown;
  requestApproval?: RequestMcpConsentApproval;
  consentEnabled?: boolean;
  consentDefaultTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CallToolResult> {
  if (params.consentEnabled === false) {
    return params.runtime.callTool(params.serverName, params.toolName, params.input);
  }
  const { cleaned, stripped } = scrubModelSuppliedConfirmationToken(params.input);
  if (stripped) {
    logWarn(
      `bundle-mcp consent: stripped model-supplied confirmation_token from ${params.serverName}.${params.toolName}`,
    );
  }
  const firstResult = await params.runtime.callTool(params.serverName, params.toolName, cleaned);
  const envelope = detectMcpConsentEnvelope(firstResult);
  if (!envelope) {
    return firstResult;
  }
  const requestApproval = params.requestApproval ?? defaultRequestMcpConsentApproval;
  let decision;
  try {
    decision = await requestApproval({
      envelope,
      ctx: {
        serverName: params.serverName,
        toolName: params.toolName,
        agentToolName: params.agentToolName,
        toolCallId: params.toolCallId,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      },
      defaultTimeoutMs: params.consentDefaultTimeoutMs,
      signal: params.signal,
    });
  } catch (err) {
    logWarn(`bundle-mcp consent: approval request threw: ${String(err)}`);
    return buildConsentDeniedResult({
      envelope,
      decision: "error",
      serverName: params.serverName,
      toolName: params.toolName,
    });
  }
  if (decision === "unavailable") {
    // Gateway has no approval delivery route for this request (e.g. the
    // user's channel session isn't bound to the gateway). Surface a
    // distinct denied result so the model sees "unavailable" rather than
    // "user denied" — and so we don't waste the full timeout waiting on
    // an already-expired approval id.
    return buildConsentDeniedResult({
      envelope,
      decision: "error",
      serverName: params.serverName,
      toolName: params.toolName,
    });
  }
  if (decision === "expired") {
    // The approval prompt was delivered but no `/approve` reply arrived
    // before the wait window elapsed. Surface a timeout result so audit
    // logs and the model's feedback say "timed out" rather than "user
    // declined" — the latter would falsely attribute an action to the
    // user.
    return buildConsentDeniedResult({
      envelope,
      decision: "expired",
      serverName: params.serverName,
      toolName: params.toolName,
    });
  }
  if (decision === "deny") {
    return buildConsentDeniedResult({
      envelope,
      decision: "deny",
      serverName: params.serverName,
      toolName: params.toolName,
    });
  }
  // allow-once or allow-always: re-call with the confirmation token. The
  // server is responsible for one-shot/TTL enforcement of the action_id.
  const baseInput = isPlainObject(cleaned) ? cleaned : {};
  const confirmedInput: Record<string, unknown> = {
    ...baseInput,
    confirmation_token: envelope.actionId,
  };
  const secondResult = await params.runtime.callTool(
    params.serverName,
    params.toolName,
    confirmedInput,
  );
  // Defensive: if the upstream STILL returns a consent envelope, do not
  // loop. Surface a denied result so the model gets a clear signal and the
  // user isn't stuck in a re-prompt loop.
  if (detectMcpConsentEnvelope(secondResult)) {
    logWarn(
      `bundle-mcp consent: ${params.serverName}.${params.toolName} returned a consent envelope after approval — refusing to recurse`,
    );
    return buildConsentDeniedResult({
      envelope,
      decision: "error",
      serverName: params.serverName,
      toolName: params.toolName,
    });
  }
  return secondResult;
}

export async function materializeBundleMcpToolsForRun(params: {
  runtime: SessionMcpRuntime;
  reservedToolNames?: Iterable<string>;
  disposeRuntime?: () => Promise<void>;
  /** Inject an alternate approval requester. Default uses the gateway
   *  plugin-approval pipeline. Tests pass a stub. */
  requestApproval?: RequestMcpConsentApproval;
  /** Master switch — set false to disable consent gating entirely. Defaults
   *  to true. Even when true, only tools that *return* a consent envelope
   *  are gated; servers that don't speak the protocol are unchanged. */
  consentEnabled?: boolean;
  /** Fallback timeout (ms) when the MCP consent envelope omits its own
   *  TTL. Resolved from `mcp.approvals.defaultTimeoutMs` in the caller;
   *  capped at MAX_CONSENT_TIMEOUT_MS. */
  consentDefaultTimeoutMs?: number;
  /** Agent-side identity passed to plugin.approval.request so the gateway
   *  forwarder can resolve the right delivery channel (WhatsApp, Telegram,
   *  Slack, gateway dashboard, …) for the user who triggered the run.
   *  Without these, the forwarder has no session binding and the prompt
   *  silently auto-cancels — making the boundary a permanent deny gate. */
  agentId?: string;
  sessionKey?: string;
}): Promise<BundleMcpToolRuntime> {
  let disposed = false;
  const releaseLease = params.runtime.acquireLease?.();
  params.runtime.markUsed();
  let catalog;
  try {
    catalog = await params.runtime.getCatalog();
  } catch (error) {
    releaseLease?.();
    throw error;
  }
  const reservedNames = normalizeReservedToolNames(params.reservedToolNames);
  const tools: BundleMcpToolRuntime["tools"] = [];
  const sortedCatalogTools = [...catalog.tools].toSorted((a, b) => {
    const serverOrder = a.safeServerName.localeCompare(b.safeServerName);
    if (serverOrder !== 0) {
      return serverOrder;
    }
    const toolOrder = a.toolName.localeCompare(b.toolName);
    if (toolOrder !== 0) {
      return toolOrder;
    }
    return a.serverName.localeCompare(b.serverName);
  });

  for (const tool of sortedCatalogTools) {
    const originalName = tool.toolName.trim();
    if (!originalName) {
      continue;
    }
    const safeToolName = buildSafeToolName({
      serverName: tool.safeServerName,
      toolName: originalName,
      reservedNames,
    });
    if (safeToolName !== `${tool.safeServerName}${TOOL_NAME_SEPARATOR}${originalName}`) {
      logWarn(
        `bundle-mcp: tool "${tool.toolName}" from server "${tool.serverName}" registered as "${safeToolName}" to keep the tool name provider-safe.`,
      );
    }
    reservedNames.add(normalizeLowercaseStringOrEmpty(safeToolName));
    const agentTool: AnyAgentTool = {
      name: safeToolName,
      label: tool.title ?? tool.toolName,
      description: tool.description || tool.fallbackDescription,
      parameters: normalizeToolParameterSchema(tool.inputSchema),
      execute: async (toolCallId: string, input: unknown, signal?: AbortSignal) => {
        params.runtime.markUsed();
        const result = await callMcpToolWithConsent({
          runtime: params.runtime,
          serverName: tool.serverName,
          toolName: tool.toolName,
          agentToolName: safeToolName,
          toolCallId,
          input,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          requestApproval: params.requestApproval,
          consentEnabled: params.consentEnabled,
          consentDefaultTimeoutMs: params.consentDefaultTimeoutMs,
          signal,
        });
        return toAgentToolResult({
          serverName: tool.serverName,
          toolName: tool.toolName,
          result,
        });
      },
    };
    setPluginToolMeta(agentTool, {
      pluginId: "bundle-mcp",
      optional: false,
    });
    tools.push(agentTool);
  }

  // Sort tools deterministically by name so the tools block in API requests is stable across
  // turns (defensive — listTools() order is usually stable but not guaranteed).
  // Cannot fix name collisions: collision suffixes above are order-dependent.
  tools.sort((a, b) => a.name.localeCompare(b.name));

  return {
    tools,
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      releaseLease?.();
      await params.disposeRuntime?.();
    },
  };
}

export async function createBundleMcpToolRuntime(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  reservedToolNames?: Iterable<string>;
  createRuntime?: (params: {
    sessionId: string;
    workspaceDir: string;
    cfg?: OpenClawConfig;
  }) => SessionMcpRuntime;
  requestApproval?: RequestMcpConsentApproval;
  consentEnabled?: boolean;
  consentDefaultTimeoutMs?: number;
  agentId?: string;
  sessionKey?: string;
}): Promise<BundleMcpToolRuntime> {
  const createRuntime =
    params.createRuntime ?? (await import("./pi-bundle-mcp-runtime.js")).createSessionMcpRuntime;
  const runtime = createRuntime({
    sessionId: `bundle-mcp:${crypto.randomUUID()}`,
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  const resolved = resolveMcpApprovalsConfig(params.cfg, {
    consentEnabled: params.consentEnabled,
    consentDefaultTimeoutMs: params.consentDefaultTimeoutMs,
  });
  const { consentEnabled, consentDefaultTimeoutMs } = resolved;
  const materialized = await materializeBundleMcpToolsForRun({
    runtime,
    reservedToolNames: params.reservedToolNames,
    disposeRuntime: async () => {
      await runtime.dispose();
    },
    requestApproval: params.requestApproval,
    consentEnabled,
    consentDefaultTimeoutMs,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  return materialized;
}
