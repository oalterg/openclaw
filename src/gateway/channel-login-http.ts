/**
 * Minimal HTTP endpoint for channel login flows (WhatsApp QR, etc.).
 *
 * Called by HomeBrain's dashboard — not by the agent. Returns raw QR data
 * URLs so the dashboard can render them in a plain <img> tag without any
 * LLM, MEDIA: directive, or reverse-proxy auth dependency.
 *
 * Auth: gateway bearer token (same as chat API). HomeBrain's Flask backend
 * holds the self-MCP bearer token and proxies through its own session auth.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, sendMethodNotAllowed, sendText } from "./http-common.js";
import {
  authorizeGatewayHttpRequestOrReply,
  resolveOpenAiCompatibleHttpSenderIsOwner,
} from "./http-utils.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";

const CHANNEL_LOGIN_PREFIX = "/api/channels/login/";

let whatsappLoginModule: Promise<typeof import("../extensions/whatsapp/login-qr-api.js")> | null =
  null;

function loadWhatsAppLogin() {
  // Lazy-load so the gateway doesn't fail at startup if WhatsApp isn't installed.
  // The import path resolves at runtime via the plugin-sdk module resolution.
  whatsappLoginModule ??= import("@openclaw/whatsapp/login-qr-api.js").catch(() => null) as Promise<
    typeof import("../extensions/whatsapp/login-qr-api.js") | null
  >;
  return whatsappLoginModule;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

export function isChannelLoginPath(pathname: string): boolean {
  return pathname.startsWith(CHANNEL_LOGIN_PREFIX);
}

export async function handleChannelLoginHttpRequest(
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
  if (!requestUrl.pathname.startsWith(CHANNEL_LOGIN_PREFIX)) {
    return false;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
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
  if (!resolveOpenAiCompatibleHttpSenderIsOwner(req, requestAuth)) {
    sendJson(res, 403, { ok: false, error: "owner access required" });
    return true;
  }

  const action = requestUrl.pathname.slice(CHANNEL_LOGIN_PREFIX.length);

  if (action === "whatsapp/start" || action === "whatsapp/wait") {
    const mod = await loadWhatsAppLogin();
    if (!mod) {
      sendJson(res, 404, {
        ok: false,
        error: "WhatsApp plugin is not installed",
      });
      return true;
    }

    const body = await readJsonBody(req);

    try {
      if (action === "whatsapp/start") {
        const result = await mod.startWebLoginWithQr({
          force: body.force === true,
          timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : 30_000,
        });
        sendJson(res, 200, result);
      } else {
        const result = await mod.waitForWebLogin({
          timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : 120_000,
          currentQrDataUrl:
            typeof body.currentQrDataUrl === "string" ? body.currentQrDataUrl : undefined,
        });
        sendJson(res, 200, result);
      }
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  }

  sendText(res, 404, "unknown channel login action");
  return true;
}
