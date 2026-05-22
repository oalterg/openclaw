/**
 * Gateway endpoint that serves media files written by agent tools
 * (QR codes, screenshots, generated charts) for inline display in the chat UI.
 *
 * The agent tool saves bytes via `saveMediaBuffer(buffer, mime, "agent-tool-output")`
 * and emits a `/api/media/agent-output/<id>` URL in its tool result. The model
 * reproduces only the short URL — never the bytes — which fixes the failure
 * mode where small quantized local models corrupt multi-KB random base64 when
 * paraphrasing tool output. See `src/plugin-sdk/media-store.ts` for the
 * shared constants.
 *
 * Trust boundary: owner bearer auth. Whoever holds the gateway bearer can
 * already see everything the agent has produced; matching that scope here.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readMediaBuffer } from "../media/store.js";
import { AGENT_TOOL_MEDIA_SUBDIR, AGENT_TOOL_MEDIA_URL_PREFIX } from "../plugin-sdk/media-store.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  sendJson,
  sendMethodNotAllowed,
  sendMissingScopeForbidden,
  sendText,
} from "./http-common.js";
import {
  authorizeGatewayHttpRequestOrReply,
  resolveOpenAiCompatibleHttpOperatorScopes,
  resolveOpenAiCompatibleHttpSenderIsOwner,
} from "./http-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";

/**
 * Allowed media-id characters: the UUID/extension/sanitized-filename shape
 * that `saveMediaBuffer` produces. Locked down to a conservative set so that
 * paths cannot reach outside the agent-tool-output subdir.
 *
 * Matches: `<uuid>`, `<uuid>.png`, `name---<uuid>.ext`. Rejects: `..`, `/`,
 * `\`, null bytes, whitespace, control chars.
 */
const AGENT_TOOL_MEDIA_ID_RE = /^[A-Za-z0-9._-]{1,256}$/;

/**
 * Tight allowlist of content types this endpoint will serve. Only image
 * formats — the model is meant to display these inline. Anything else means
 * a bug in the tool that wrote the file, and serving it would be surprising.
 */
const SERVED_CONTENT_TYPE_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

function resolveServedContentType(id: string): string | undefined {
  const dot = id.lastIndexOf(".");
  if (dot < 0) {
    return undefined;
  }
  return SERVED_CONTENT_TYPE_BY_EXT[id.slice(dot).toLowerCase()];
}

export function isAgentToolMediaPath(pathname: string): boolean {
  return pathname.startsWith(AGENT_TOOL_MEDIA_URL_PREFIX);
}

export async function handleAgentToolMediaHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const requestUrl = new URL(req.url ?? "/", "http://localhost");
  if (!requestUrl.pathname.startsWith(AGENT_TOOL_MEDIA_URL_PREFIX)) {
    return false;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendMethodNotAllowed(res, "GET, HEAD");
    return true;
  }

  const requestAuth = await authorizeGatewayHttpRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
  if (!requestAuth) {
    return true;
  }

  const requestedScopes = resolveOpenAiCompatibleHttpOperatorScopes(req, requestAuth);
  const scopeAuth = authorizeOperatorScopesForMethod("chat.history", requestedScopes);
  if (!scopeAuth.allowed) {
    sendMissingScopeForbidden(res, scopeAuth.missingScope);
    return true;
  }
  if (!resolveOpenAiCompatibleHttpSenderIsOwner(req, requestAuth)) {
    sendJson(res, 403, {
      ok: false,
      error: { type: "forbidden", message: "owner access required" },
    });
    return true;
  }

  const rawId = requestUrl.pathname.slice(AGENT_TOOL_MEDIA_URL_PREFIX.length);
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    sendText(res, 404, "not found");
    return true;
  }
  if (!AGENT_TOOL_MEDIA_ID_RE.test(id)) {
    sendText(res, 404, "not found");
    return true;
  }
  const contentType = resolveServedContentType(id);
  if (!contentType) {
    sendText(res, 404, "not found");
    return true;
  }

  let result: Awaited<ReturnType<typeof readMediaBuffer>>;
  try {
    result = await readMediaBuffer(id, AGENT_TOOL_MEDIA_SUBDIR);
  } catch {
    sendText(res, 404, "not found");
    return true;
  }

  res.statusCode = 200;
  res.setHeader("content-type", contentType);
  res.setHeader("content-length", String(result.buffer.byteLength));
  // UUID-based ids are immutable: same id → same bytes for the file's lifetime.
  res.setHeader("cache-control", "private, max-age=86400, immutable");
  if (req.method === "HEAD") {
    res.end();
  } else {
    res.end(result.buffer);
  }
  return true;
}
