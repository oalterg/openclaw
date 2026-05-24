import { Type } from "typebox";
import type { ChannelAgentTool } from "openclaw/plugin-sdk/channel-contract";
import { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";

const TELEGRAM_BOT_TOKEN_RE = /^\d{8,15}:[A-Za-z0-9_-]{30,50}$/;
const TELEGRAM_API_BASE = "https://api.telegram.org/bot";

async function validateBotToken(token: string): Promise<
  | { ok: true; botName: string; botUsername: string }
  | { ok: false; message: string }
> {
  try {
    const res = await fetch(`${TELEGRAM_API_BASE}${token}/getMe`, {
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json()) as {
      ok?: boolean;
      description?: string;
      result?: { first_name?: string; username?: string };
    };
    if (!res.ok || !json?.ok) {
      return {
        ok: false,
        message: json?.description ?? `Telegram API returned ${res.status}`,
      };
    }
    return {
      ok: true,
      botName: json.result?.first_name ?? "Unknown",
      botUsername: json.result?.username ?? "unknown",
    };
  } catch (err) {
    return {
      ok: false,
      message: `Failed to reach Telegram API: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function isTokenConfigured(): { configured: boolean; botUsername?: string } {
  const cfg = getRuntimeConfig();
  const telegram = (cfg as Record<string, unknown>)?.channels as
    | Record<string, unknown>
    | undefined;
  const tgCfg = telegram?.telegram as Record<string, unknown> | undefined;
  if (!tgCfg) {
    return { configured: false };
  }
  const botToken =
    typeof tgCfg.botToken === "string" && tgCfg.botToken.trim()
      ? tgCfg.botToken.trim()
      : undefined;
  return { configured: Boolean(botToken) };
}

export function createTelegramLoginTool(): ChannelAgentTool {
  return {
    label: "Telegram Login",
    name: "telegram_login",
    ownerOnly: true,
    description: `Set up or check Telegram bot linking.

ACTIONS:
- guide: Show step-by-step instructions for creating a Telegram bot and getting the token. No params.
- set_token: Validate and save a bot token. Args: { token: "<bot_token>" }.
- status: Check if Telegram is already configured. No params.

FLOW: Call guide first to explain the process, then set_token once the user provides their token.`,
    parameters: Type.Object({
      action: Type.Unsafe<"guide" | "set_token" | "status">({
        type: "string",
        enum: ["guide", "set_token", "status"],
      }),
      token: Type.Optional(Type.String()),
      accountId: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, rawArgs) => {
      const args = (rawArgs ?? {}) as {
        action?: string;
        token?: string;
        accountId?: string;
      };
      const action = args.action ?? "status";

      if (action === "guide") {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                "To link Telegram, you need a bot token from BotFather:",
                "",
                "1. Open Telegram and search for @BotFather",
                "2. Send /newbot and follow the prompts to name your bot",
                "3. BotFather will give you a token like: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
                "4. Copy that token and give it to me",
                "",
                "Once you have the token, tell me and I'll configure it.",
              ].join("\n"),
            },
          ],
          details: { guide: true },
        };
      }

      if (action === "status") {
        const state = isTokenConfigured();
        if (state.configured) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Telegram is already configured with a bot token. To reconfigure, use set_token with a new token.",
              },
            ],
            details: { configured: true },
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: "Telegram is not yet configured. Use the guide action to see setup instructions, then set_token to save the bot token.",
            },
          ],
          details: { configured: false },
        };
      }

      if (action === "set_token") {
        const token = args.token?.trim();
        if (!token) {
          return {
            content: [
              { type: "text" as const, text: "Missing token. Provide the bot token from BotFather: { token: \"<your_token>\" }" },
            ],
            details: { error: "missing_token" },
          };
        }

        if (!TELEGRAM_BOT_TOKEN_RE.test(token)) {
          return {
            content: [
              {
                type: "text" as const,
                text: "That doesn't look like a valid Telegram bot token. It should be in the format: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
              },
            ],
            details: { error: "invalid_format" },
          };
        }

        const validation = await validateBotToken(token);
        if (!validation.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Token validation failed: ${validation.message}. Double-check the token and try again.`,
              },
            ],
            details: { error: "validation_failed" },
          };
        }

        await mutateConfigFile({
          base: "runtime",
          afterWrite: { mode: "auto" },
          mutate: (draft) => {
            const cfg = draft as unknown as Record<string, unknown>;
            const channels = (cfg.channels ?? {}) as Record<string, Record<string, unknown>>;
            const telegram = channels.telegram ?? {};
            telegram.botToken = token;
            telegram.enabled = true;
            channels.telegram = telegram;
            cfg.channels = channels;

            const plugins = (cfg.plugins ?? {}) as {
              entries?: Record<string, { enabled?: boolean }>;
            };
            const entries = plugins.entries ?? {};
            if (!entries.telegram) {
              entries.telegram = { enabled: true };
            }
            plugins.entries = entries;
            cfg.plugins = plugins;
          },
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Telegram bot linked successfully!\n\nBot: ${validation.botName} (@${validation.botUsername})\n\nThe bot is now active. Users can message @${validation.botUsername} on Telegram to chat. You may want to set a DM policy with the channels tool (e.g. channels set_policy with dmPolicy: "pairing" or "open").`,
            },
          ],
          details: {
            configured: true,
            botName: validation.botName,
            botUsername: validation.botUsername,
          },
        };
      }

      return {
        content: [
          { type: "text" as const, text: `Unknown action: ${String(action)}. Use guide, set_token, or status.` },
        ],
        details: { error: "unknown_action" },
      };
    },
  };
}
