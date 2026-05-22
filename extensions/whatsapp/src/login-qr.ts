import { randomUUID } from "node:crypto";
import { logInfo } from "openclaw/plugin-sdk/logging-core";
import {
  AGENT_TOOL_MEDIA_SUBDIR,
  formatAgentToolMediaUrl,
  saveMediaBuffer,
} from "openclaw/plugin-sdk/media-store";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { danger, info, success } from "openclaw/plugin-sdk/runtime-env";
import { defaultRuntime, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { resolveWhatsAppAccount } from "./accounts.js";
import {
  closeWaSocket,
  waitForWhatsAppLoginResult,
  WHATSAPP_LOGGED_OUT_QR_MESSAGE,
} from "./connection-controller.js";
import { renderQrPngBase64 } from "./qr-image.js";

type QrAssets = {
  /**
   * Path URL into the gateway media endpoint. Short and faithful — the chat
   * agent emits this. Small/quantized local models cannot reliably re-emit a
   * multi-KB `data:image/png;base64,…` URL verbatim; they preserve the header
   * bytes and then drift into hallucinated tokens.
   */
  qrUrl: string;
  /**
   * Inline data URL form. The operator CLI/setup surface still wants this
   * (e.g. for `writeQrDataUrlToTempFile`). Kept alongside `qrUrl` so we
   * render once and pay only one extra in-memory string.
   */
  qrDataUrl: string;
};

const QR_PNG_DATA_URL_PREFIX = "data:image/png;base64,";

/**
 * Render the QR string into a PNG, persist the bytes through the shared media
 * store, and return both forms: the chat-display `/api/media/agent-output/<id>`
 * URL plus the legacy `data:image/png;base64,…` data URL for the CLI path.
 */
async function renderAndStoreQrAssets(qr: string): Promise<QrAssets> {
  const base64 = await renderQrPngBase64(qr);
  const buffer = Buffer.from(base64, "base64");
  const saved = await saveMediaBuffer(buffer, "image/png", AGENT_TOOL_MEDIA_SUBDIR);
  return {
    qrUrl: formatAgentToolMediaUrl(saved.id),
    qrDataUrl: `${QR_PNG_DATA_URL_PREFIX}${base64}`,
  };
}
import {
  createWaSocket,
  readWebAuthExistsForDecision,
  readWebSelfId,
  WHATSAPP_AUTH_UNSTABLE_CODE,
} from "./session.js";
import { resolveWhatsAppSocketTiming, type WhatsAppSocketTimingOptions } from "./socket-timing.js";

type WaSocket = Awaited<ReturnType<typeof createWaSocket>>;
export type StartWebLoginWithQrResult = {
  qrUrl?: string;
  qrDataUrl?: string;
  message: string;
  connected?: boolean;
  code?: typeof WHATSAPP_AUTH_UNSTABLE_CODE;
};

type ActiveLogin = {
  accountId: string;
  authDir: string;
  isLegacyAuthDir: boolean;
  id: string;
  sock: WaSocket;
  startedAt: number;
  qr?: string;
  qrUrl?: string;
  qrDataUrl?: string;
  qrUrlVersion?: number;
  qrVersion: number;
  connected: boolean;
  error?: string;
  errorStatus?: number;
  waitPromise: Promise<void>;
  qrUpdatePromise: Promise<void>;
  resolveQrUpdate: (() => void) | null;
  qrRenderPromise: Promise<QrAssets> | null;
  verbose: boolean;
  runtime: RuntimeEnv;
  socketTiming: WhatsAppSocketTimingOptions;
};

type LoginQrRaceResult =
  | { outcome: "qr"; qr: string }
  | { outcome: "connected" }
  | { outcome: "failed"; message: string };

function waitForNextTask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const ACTIVE_LOGIN_TTL_MS = 3 * 60_000;
const MAX_QR_RENDER_CHASES = 10;
const activeLogins = new Map<string, ActiveLogin>();

function closeSocket(sock: WaSocket) {
  closeWaSocket(sock);
}

async function resetActiveLogin(accountId: string, reason?: string) {
  const login = activeLogins.get(accountId);
  if (login) {
    closeSocket(login.sock);
    activeLogins.delete(accountId);
  }
  if (reason) {
    logInfo(reason);
  }
}

function isLoginFresh(login: ActiveLogin) {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}

function resetQrUpdateSignal(login: ActiveLogin) {
  login.qrUpdatePromise = new Promise((resolve) => {
    login.resolveQrUpdate = resolve;
  });
}

function notifyQrUpdate(login: ActiveLogin) {
  const resolve = login.resolveQrUpdate;
  resetQrUpdateSignal(login);
  resolve?.();
}

function updateLoginQrState(login: ActiveLogin, qr: string): number {
  login.qr = qr;
  login.qrVersion += 1;
  return login.qrVersion;
}

async function ensureQrAssets(params: {
  accountId: string;
  loginId: string;
  qr: string;
  qrVersion: number;
}): Promise<QrAssets> {
  const current = activeLogins.get(params.accountId);
  if (
    current?.id !== params.loginId ||
    current.qrVersion !== params.qrVersion ||
    current.qr !== params.qr
  ) {
    return await renderAndStoreQrAssets(params.qr);
  }

  if (current.qrUrl && current.qrDataUrl && current.qrUrlVersion === params.qrVersion) {
    return { qrUrl: current.qrUrl, qrDataUrl: current.qrDataUrl };
  }

  if (current.qrRenderPromise) {
    return await current.qrRenderPromise;
  }

  const renderPromise = (async () => {
    for (let attempt = 0; attempt < MAX_QR_RENDER_CHASES; attempt += 1) {
      const latest = activeLogins.get(params.accountId);
      if (!latest || latest.id !== params.loginId || !latest.qr) {
        throw new Error("WhatsApp QR is no longer active.");
      }
      if (latest.qrUrl && latest.qrDataUrl && latest.qrUrlVersion === latest.qrVersion) {
        return { qrUrl: latest.qrUrl, qrDataUrl: latest.qrDataUrl };
      }

      const qr = latest.qr;
      const qrVersion = latest.qrVersion;
      const assets = await renderAndStoreQrAssets(qr);
      const refreshed = activeLogins.get(params.accountId);
      if (!refreshed || refreshed.id !== params.loginId) {
        return assets;
      }
      if (refreshed.qrVersion === qrVersion && refreshed.qr === qr) {
        refreshed.qrUrl = assets.qrUrl;
        refreshed.qrDataUrl = assets.qrDataUrl;
        refreshed.qrUrlVersion = qrVersion;
        notifyQrUpdate(refreshed);
        return assets;
      }
    }

    throw new Error("WhatsApp QR kept refreshing before the latest image could render.");
  })();

  current.qrRenderPromise = renderPromise;
  try {
    return await renderPromise;
  } finally {
    const latest = activeLogins.get(params.accountId);
    if (latest?.id === params.loginId && latest.qrRenderPromise === renderPromise) {
      latest.qrRenderPromise = null;
    }
  }
}

function renderLatestQrAssetsInBackground(params: {
  accountId: string;
  loginId: string;
  qr: string;
  qrVersion: number;
}) {
  void ensureQrAssets(params).catch(() => {
    // Ignore background QR render failures; the caller can still retry or surface
    // the login state without clobbering the active session.
  });
}

function attachLoginWaiter(accountId: string, login: ActiveLogin) {
  login.waitPromise = waitForWhatsAppLoginResult({
    sock: login.sock,
    authDir: login.authDir,
    isLegacyAuthDir: login.isLegacyAuthDir,
    verbose: login.verbose,
    runtime: login.runtime,
    socketTiming: login.socketTiming,
    onQr: (qr) => {
      const current = activeLogins.get(accountId);
      if (!current || current.id !== login.id) {
        return;
      }
      const qrVersion = updateLoginQrState(current, qr);
      renderLatestQrAssetsInBackground({
        accountId,
        loginId: login.id,
        qr,
        qrVersion,
      });
    },
    onSocketReplaced: (sock) => {
      const current = activeLogins.get(accountId);
      if (current?.id === login.id) {
        current.sock = sock;
        current.connected = false;
        current.error = undefined;
        current.errorStatus = undefined;
      }
    },
  })
    .then((result) => {
      const current = activeLogins.get(accountId);
      if (current?.id !== login.id) {
        return;
      }
      if (result.outcome === "connected") {
        current.sock = result.sock;
        current.connected = true;
        return;
      }
      current.error = result.message;
      current.errorStatus = result.statusCode;
    })
    .catch((err) => {
      const current = activeLogins.get(accountId);
      if (current?.id !== login.id) {
        return;
      }
      current.error = err instanceof Error ? err.message : String(err);
      current.errorStatus = undefined;
    });
}

async function waitForQrOrRecoveredLogin(params: {
  accountId: string;
  login: ActiveLogin;
  qrPromise: Promise<string>;
}): Promise<LoginQrRaceResult> {
  const qrResult = params.qrPromise.then(
    (qr) => ({ outcome: "qr", qr }) as const,
    (err) =>
      ({
        outcome: "failed",
        message: `Failed to get QR: ${String(err)}`,
      }) as const,
  );
  const loginResult = params.login.waitPromise.then(async () => {
    const current = activeLogins.get(params.accountId);
    if (current?.id !== params.login.id) {
      return {
        outcome: "failed",
        message: "WhatsApp login was replaced by a newer request.",
      } as const;
    }

    // A QR may already be queued for the next task even if the login waiter won first.
    await waitForNextTask();
    const latest = activeLogins.get(params.accountId);
    if (latest?.id !== params.login.id) {
      return {
        outcome: "failed",
        message: "WhatsApp login was replaced by a newer request.",
      } as const;
    }
    if (latest.qr) {
      return { outcome: "qr", qr: latest.qr } as const;
    }
    if (latest.connected) {
      return { outcome: "connected" } as const;
    }
    return {
      outcome: "failed",
      message: latest.error ? `WhatsApp login failed: ${latest.error}` : "WhatsApp login failed.",
    } as const;
  });

  return await Promise.race([qrResult, loginResult]);
}

export async function startWebLoginWithQr(
  opts: {
    verbose?: boolean;
    timeoutMs?: number;
    force?: boolean;
    accountId?: string;
    runtime?: RuntimeEnv;
  } = {},
): Promise<StartWebLoginWithQrResult> {
  const runtime = opts.runtime ?? defaultRuntime;
  const cfg = getRuntimeConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId: opts.accountId });
  const socketTiming = resolveWhatsAppSocketTiming(cfg);
  const authState = await readWebAuthExistsForDecision(account.authDir);
  if (authState.outcome === "unstable") {
    return {
      code: WHATSAPP_AUTH_UNSTABLE_CODE,
      message: "WhatsApp auth state is still stabilizing. Retry login in a moment.",
    };
  }
  if (authState.exists && !opts.force) {
    const selfId = readWebSelfId(account.authDir);
    const who = selfId.e164 ?? selfId.jid ?? "unknown";
    return {
      message: `WhatsApp is already linked (${who}). Say “relink” if you want a fresh QR.`,
    };
  }

  const existing = activeLogins.get(account.accountId);
  if (existing && isLoginFresh(existing) && existing.qrUrl) {
    return {
      qrUrl: existing.qrUrl,
      qrDataUrl: existing.qrDataUrl,
      message: "QR already active. Scan it in WhatsApp → Linked Devices.",
    };
  }

  await resetActiveLogin(account.accountId);

  let resolveQr: ((qr: string) => void) | null = null;
  let rejectQr: ((err: Error) => void) | null = null;
  const qrPromise = new Promise<string>((resolve, reject) => {
    resolveQr = resolve;
    rejectQr = reject;
  });

  const qrTimer = setTimeout(
    () => {
      rejectQr?.(new Error("Timed out waiting for WhatsApp QR"));
    },
    Math.max(opts.timeoutMs ?? 30_000, 5000),
  );

  let sock: WaSocket;
  let pendingQr: string | null = null;
  const loginId = randomUUID();
  try {
    sock = await createWaSocket(false, Boolean(opts.verbose), {
      authDir: account.authDir,
      ...socketTiming,
      onQr: (qr: string) => {
        pendingQr = qr;
        const current = activeLogins.get(account.accountId);
        if (current && current.id === loginId) {
          const qrVersion = updateLoginQrState(current, qr);
          renderLatestQrAssetsInBackground({
            accountId: account.accountId,
            loginId,
            qr,
            qrVersion,
          });
        }
        if (resolveQr) {
          clearTimeout(qrTimer);
          resolveQr(qr);
          resolveQr = null;
          rejectQr = null;
        }
        runtime.log(info("WhatsApp QR received."));
      },
    });
  } catch (err) {
    clearTimeout(qrTimer);
    await resetActiveLogin(account.accountId);
    return {
      message: `Failed to start WhatsApp login: ${String(err)}`,
    };
  }
  const login: ActiveLogin = {
    accountId: account.accountId,
    authDir: account.authDir,
    isLegacyAuthDir: account.isLegacyAuthDir,
    id: loginId,
    sock,
    startedAt: Date.now(),
    connected: false,
    waitPromise: Promise.resolve(),
    qrVersion: 0,
    qrUpdatePromise: Promise.resolve(),
    resolveQrUpdate: null,
    qrRenderPromise: null,
    verbose: Boolean(opts.verbose),
    runtime,
    socketTiming,
  };
  resetQrUpdateSignal(login);
  activeLogins.set(account.accountId, login);
  if (pendingQr) {
    const qrVersion = updateLoginQrState(login, pendingQr);
    renderLatestQrAssetsInBackground({
      accountId: account.accountId,
      loginId: login.id,
      qr: pendingQr,
      qrVersion,
    });
  }
  attachLoginWaiter(account.accountId, login);

  const loginStartResult = await waitForQrOrRecoveredLogin({
    accountId: account.accountId,
    login,
    qrPromise,
  });
  clearTimeout(qrTimer);

  if (loginStartResult.outcome === "connected") {
    const selfId = readWebSelfId(account.authDir);
    const who = selfId.e164 ?? selfId.jid ?? "unknown";
    await resetActiveLogin(account.accountId);
    return {
      message: `WhatsApp recovered the existing linked session (${who}).`,
      connected: true,
    };
  }

  if (loginStartResult.outcome === "failed") {
    await resetActiveLogin(account.accountId);
    return {
      message: loginStartResult.message,
    };
  }

  const qr = login.qr ?? loginStartResult.qr;
  const qrVersion = login.qrVersion;
  if (qrVersion === 0) {
    await resetActiveLogin(account.accountId);
    return {
      message: "Failed to capture the active WhatsApp QR. Ask me to generate a new one.",
    };
  }

  let assets: QrAssets;
  try {
    assets = await ensureQrAssets({
      accountId: account.accountId,
      loginId: login.id,
      qr,
      qrVersion,
    });
  } catch (err) {
    const message =
      err instanceof Error ? `Failed to render the WhatsApp QR: ${err.message}` : String(err);
    await resetActiveLogin(account.accountId, message);
    return { message };
  }
  return {
    qrUrl: assets.qrUrl,
    qrDataUrl: assets.qrDataUrl,
    message: "Scan this QR in WhatsApp → Linked Devices.",
  };
}

export async function waitForWebLogin(
  opts: {
    timeoutMs?: number;
    runtime?: RuntimeEnv;
    accountId?: string;
    /**
     * Last QR ref the chat/agent caller has rendered. Compared against the
     * media-store URL (`/api/media/agent-output/<id>`) we hand back to that
     * caller; differs = the QR rotated and the caller should re-render.
     */
    currentQrUrl?: string;
    /**
     * Last QR data URL the CLI/setup caller has rendered. Compared against the
     * `data:image/png;base64,…` form we hand back to that caller. Kept
     * separate so each caller compares the form it actually sees.
     */
    currentQrDataUrl?: string;
  } = {},
): Promise<{ connected: boolean; message: string; qrUrl?: string; qrDataUrl?: string }> {
  const runtime = opts.runtime ?? defaultRuntime;
  const cfg = getRuntimeConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId: opts.accountId });
  const activeLogin = activeLogins.get(account.accountId);
  if (!activeLogin) {
    return {
      connected: false,
      message: "No active WhatsApp login in progress.",
    };
  }

  const login = activeLogin;
  if (!isLoginFresh(login)) {
    await resetActiveLogin(account.accountId);
    return {
      connected: false,
      message: "The login QR expired. Ask me to generate a new one.",
    };
  }
  const timeoutMs = Math.max(opts.timeoutMs ?? 120_000, 1000);
  const deadline = Date.now() + timeoutMs;
  const currentQrUrl = opts.currentQrUrl;
  const currentQrDataUrl = opts.currentQrDataUrl;

  while (true) {
    if (login.error) {
      if (login.errorStatus === 401) {
        const message = WHATSAPP_LOGGED_OUT_QR_MESSAGE;
        await resetActiveLogin(account.accountId, message);
        runtime.log(danger(message));
        return { connected: false, message };
      }
      const message = `WhatsApp login failed: ${login.error}`;
      await resetActiveLogin(account.accountId, message);
      runtime.log(danger(message));
      return { connected: false, message };
    }

    if (login.connected) {
      const message = "✅ Linked! WhatsApp is ready.";
      runtime.log(success(message));
      await resetActiveLogin(account.accountId);
      return { connected: true, message };
    }

    const urlChanged =
      currentQrUrl !== undefined && login.qrUrl !== undefined && login.qrUrl !== currentQrUrl;
    const dataUrlChanged =
      currentQrDataUrl !== undefined &&
      login.qrDataUrl !== undefined &&
      login.qrDataUrl !== currentQrDataUrl;
    if (urlChanged || dataUrlChanged) {
      return {
        connected: false,
        message: "QR refreshed. Scan the latest code in WhatsApp → Linked Devices.",
        qrUrl: login.qrUrl,
        qrDataUrl: login.qrDataUrl,
      };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        connected: false,
        message: "Still waiting for the QR scan. Let me know when you’ve scanned it.",
      };
    }
    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), remaining),
    );
    const result = await Promise.race([
      login.waitPromise.then(() => "done" as const),
      login.qrUpdatePromise.then(() => "qr-update" as const),
      timeout,
    ]);

    if (result === "timeout") {
      return {
        connected: false,
        message: "Still waiting for the QR scan. Let me know when you’ve scanned it.",
      };
    }

    if (result === "qr-update") {
      continue;
    }

    if (result === "done") {
      if (login.connected || login.error) {
        continue;
      }
      return { connected: false, message: "Login ended without a connection." };
    }

    return { connected: false, message: "Login ended without a connection." };
  }
}
