/**
 * Self-config agent tool: lets the agent introspect and configure its own
 * harness — install channel plugins, add channel skeletons, set DM/group
 * policies — directly from a chat turn.
 *
 * Design goals:
 * - Single owner-only tool named "channels" with action-based dispatch, to
 *   match the cron/gateway/nodes pattern OpenClaw maintainers already use.
 * - Catalog-only plugin install by default (official-external channel catalog).
 *   Arbitrary npm/git specs are intentionally out of scope here; admins who
 *   want them can still use the CLI.
 * - No secrets in tool params. Channel adapters that need a credential
 *   (botToken, accessToken) are expected to register their own per-channel
 *   login tool — this tool only installs the plugin and writes the skeleton,
 *   so the per-channel login tool becomes available on the next agent turn.
 * - Reuses the existing per-channel agent-tool surface (e.g. `whatsapp_login`)
 *   for the actual link flow. That keeps QR rendering, polling, and channel-
 *   specific UX exactly where it already lives.
 */

import { Type } from "typebox";
import { listLoadedChannelPlugins } from "../../channels/plugins/registry-loaded.js";
import { mutateConfigFile, readConfigFileSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { installPluginFromClawHub } from "../../plugins/clawhub.js";
import {
  getOfficialExternalPluginCatalogEntry,
  listOfficialExternalChannelCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
} from "../../plugins/official-external-plugin-catalog.js";
import { stringEnum } from "../schema/typebox.js";
import { jsonResult, ToolInputError, type AnyAgentTool } from "./common.js";
import { isOpenClawOwnerOnlyCoreToolName } from "./owner-only-tools.js";

export const CHANNELS_TOOL_NAME = "channels";

const CHANNELS_ACTIONS = [
  "status",
  "catalog",
  "add",
  "remove",
  "set_policy",
  "pairing_list",
  "pairing_approve",
] as const;

type ChannelsAction = (typeof CHANNELS_ACTIONS)[number];

const CHANNELS_TOOL_DESCRIPTION = `Manage OpenClaw channels (messengers) directly from the agent.

ACTIONS:
- status: List configured channels and whether their plugin is loaded. No params.
- catalog: List channels available to install from the official-external catalog. No params.
- add: Install the channel plugin (catalog-only) and add a disabled config skeleton.
       Args: { channel: "<id>" } e.g. { channel: "whatsapp" }.
       After add succeeds, the per-channel login tool (e.g. whatsapp_login) becomes
       available on the next agent turn — call that to render the QR / take the
       credential. This tool intentionally does not handle secrets.
- remove: Disable + delete a channel config. Args: { channel: "<id>" }.
- set_policy: Set DM/group access policy for a configured channel.
       Args: { channel: "<id>", dmPolicy?: "open"|"allowlist"|"pairing"|"disabled",
               allowFrom?: ["<id>", ...], groupPolicy?: "open"|"allowlist"|"disabled",
               groupAllowFrom?: ["<id>", ...] }.
- pairing_list: List pending DM pairing codes for a channel. Args: { channel: "<id>" }.
- pairing_approve: Approve a pending DM pairing code. Args: { channel: "<id>", code: "<CODE>" }.

DESIGN NOTES (for the agent):
- Linking flows live in per-channel tools (e.g. whatsapp_login, telegram_login).
  Use this tool to make those tools available, then call them in a follow-up turn.
- Plugin install is restricted to entries in the official-external channel catalog.
  If a user asks to install something not in the catalog, refuse and suggest the CLI.`;

const POLICY_VALUES = ["open", "allowlist", "pairing", "disabled"] as const;
const GROUP_POLICY_VALUES = ["open", "allowlist", "disabled"] as const;

const CHANNELS_TOOL_PARAMETERS = Type.Object({
  action: stringEnum(CHANNELS_ACTIONS),
  channel: Type.Optional(Type.String()),
  accountId: Type.Optional(Type.String()),
  dmPolicy: Type.Optional(stringEnum(POLICY_VALUES)),
  allowFrom: Type.Optional(Type.Array(Type.String())),
  groupPolicy: Type.Optional(stringEnum(GROUP_POLICY_VALUES)),
  groupAllowFrom: Type.Optional(Type.Array(Type.String())),
  code: Type.Optional(Type.String()),
});

type ChannelsToolParams = {
  action?: ChannelsAction;
  channel?: string;
  accountId?: string;
  dmPolicy?: (typeof POLICY_VALUES)[number];
  allowFrom?: string[];
  groupPolicy?: (typeof GROUP_POLICY_VALUES)[number];
  groupAllowFrom?: string[];
  code?: string;
};

function readParams(raw: unknown): ChannelsToolParams {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  return raw as ChannelsToolParams;
}

function readChannelId(params: ChannelsToolParams): string {
  const value = params.channel?.trim();
  if (!value) {
    throw new ToolInputError("channel is required");
  }
  return value;
}

async function readConfig(): Promise<OpenClawConfig> {
  const snap = await readConfigFileSnapshot();
  return (snap.sourceConfig ?? snap.config) as OpenClawConfig;
}

async function handleStatus(): Promise<unknown> {
  const cfg = await readConfig();
  const channels = (cfg.channels ?? {}) as Record<string, Record<string, unknown>>;
  const loaded = new Set(listLoadedChannelPlugins().map((p) => p.id));

  const rows = Object.keys(channels).map((id) => {
    const entry = channels[id] ?? {};
    return {
      channel: id,
      enabled: entry.enabled === true,
      pluginLoaded: loaded.has(id),
      dmPolicy: entry.dmPolicy ?? null,
      groupPolicy: entry.groupPolicy ?? null,
      allowFromCount: Array.isArray(entry.allowFrom) ? entry.allowFrom.length : 0,
    };
  });

  return {
    configured: rows,
    loadedPlugins: [...loaded].toSorted(),
  };
}

async function handleCatalog(): Promise<unknown> {
  const entries = listOfficialExternalChannelCatalogEntries().map((entry) => ({
    id: resolveOfficialExternalPluginId(entry) ?? entry.name ?? "unknown",
    name: entry.name ?? null,
    description: entry.description ?? null,
    install: resolveOfficialExternalPluginInstall(entry) ?? null,
  }));
  return { catalog: entries };
}

async function handleAdd(params: ChannelsToolParams): Promise<unknown> {
  const channel = readChannelId(params);
  const catalogEntry = getOfficialExternalPluginCatalogEntry(channel);
  if (!catalogEntry) {
    throw new ToolInputError(
      `Channel "${channel}" is not in the official-external catalog. ` +
        `Use the 'catalog' action to see available channels, or install via CLI for arbitrary plugins.`,
    );
  }
  const installSpec = resolveOfficialExternalPluginInstall(catalogEntry);
  const clawhubSpec = installSpec?.clawhubSpec;
  if (!clawhubSpec) {
    throw new ToolInputError(
      `Catalog entry for "${channel}" has no ClawHub install spec — cannot proceed via this tool.`,
    );
  }

  let installResult: { ok: true } | { ok: false; message: string };
  try {
    const expectedPluginId = resolveOfficialExternalPluginId(catalogEntry);
    const result = await installPluginFromClawHub({
      spec: clawhubSpec,
      ...(expectedPluginId ? { expectedPluginId } : {}),
    });
    if (result.ok) {
      installResult = { ok: true };
    } else {
      const raw = (result as { message?: unknown }).message;
      const message = typeof raw === "string" && raw.length > 0 ? raw : "install failed";
      installResult = { ok: false, message };
    }
  } catch (err) {
    installResult = { ok: false, message: formatErrorMessage(err) };
  }

  if (!installResult.ok) {
    return {
      ok: false,
      stage: "install",
      message: installResult.message,
    };
  }

  // Write a minimal disabled skeleton. Each channel has its own schema; we
  // write only what's universal across the messenger channels we target
  // (whatsapp/telegram/signal/matrix/nextcloud-talk). Channel-specific fields
  // get added by the per-channel login tool or by a follow-up set_policy call.
  await mutateConfigFile({
    base: "runtime",
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      const next = draft as unknown as Record<string, unknown>;
      const channels = (next.channels ?? {}) as Record<string, Record<string, unknown>>;
      if (!channels[channel]) {
        channels[channel] = { enabled: false };
      }
      next.channels = channels;
      const plugins = (next.plugins ?? {}) as { entries?: Record<string, { enabled?: boolean }> };
      const entries = plugins.entries ?? {};
      if (!entries[channel]) {
        entries[channel] = { enabled: true };
      }
      plugins.entries = entries;
      next.plugins = plugins;
    },
  });

  return {
    ok: true,
    channel,
    pluginInstalled: true,
    nextStep:
      `Plugin installed and config skeleton written. ` +
      `On the next agent turn, the per-channel login tool (e.g. "${channel}_login") will be available — call it to start the link flow. ` +
      `The channel stays disabled until you call set_policy with a non-disabled dmPolicy or the login flow enables it.`,
  };
}

async function handleRemove(params: ChannelsToolParams): Promise<unknown> {
  const channel = readChannelId(params);
  await mutateConfigFile({
    base: "runtime",
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      const next = draft as unknown as Record<string, unknown>;
      const channels = (next.channels ?? {}) as Record<string, unknown>;
      delete channels[channel];
      next.channels = channels;
      const plugins = (next.plugins ?? {}) as { entries?: Record<string, unknown> };
      if (plugins.entries) {
        delete plugins.entries[channel];
      }
      next.plugins = plugins;
    },
  });
  return { ok: true, channel, removed: true };
}

async function handleSetPolicy(params: ChannelsToolParams): Promise<unknown> {
  const channel = readChannelId(params);
  const hasAny =
    params.dmPolicy !== undefined ||
    params.allowFrom !== undefined ||
    params.groupPolicy !== undefined ||
    params.groupAllowFrom !== undefined;
  if (!hasAny) {
    throw new ToolInputError(
      "set_policy requires at least one of dmPolicy, allowFrom, groupPolicy, groupAllowFrom.",
    );
  }
  await mutateConfigFile({
    base: "runtime",
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      const next = draft as unknown as Record<string, unknown>;
      const channels = (next.channels ?? {}) as Record<string, Record<string, unknown>>;
      const entry = channels[channel] ?? {};
      if (params.dmPolicy !== undefined) {
        entry.dmPolicy = params.dmPolicy;
      }
      if (params.allowFrom !== undefined) {
        entry.allowFrom = params.allowFrom;
      }
      if (params.groupPolicy !== undefined) {
        entry.groupPolicy = params.groupPolicy;
      }
      if (params.groupAllowFrom !== undefined) {
        entry.groupAllowFrom = params.groupAllowFrom;
      }
      if (entry.dmPolicy && entry.dmPolicy !== "disabled") {
        entry.enabled = true;
      }
      channels[channel] = entry;
      next.channels = channels;
    },
  });
  return { ok: true, channel, policyUpdated: true };
}

async function handlePairingList(_params: ChannelsToolParams): Promise<unknown> {
  // Stub: pairing-store reads live behind channel-specific adapters. Follow-up
  // PR will surface them via a shared listPendingPairings(channel) helper.
  return {
    ok: false,
    message:
      "pairing_list not yet implemented in self-config tool. Use `openclaw pairing list <channel>` from CLI for now.",
  };
}

async function handlePairingApprove(_params: ChannelsToolParams): Promise<unknown> {
  // Stub: same reason as pairing_list.
  return {
    ok: false,
    message:
      "pairing_approve not yet implemented in self-config tool. Use `openclaw pairing approve <channel> <code>` from CLI for now.",
  };
}

export function createChannelsSelfConfigTool(): AnyAgentTool {
  return {
    label: "Channels",
    name: CHANNELS_TOOL_NAME,
    ownerOnly: isOpenClawOwnerOnlyCoreToolName(CHANNELS_TOOL_NAME) || true,
    description: CHANNELS_TOOL_DESCRIPTION,
    parameters: CHANNELS_TOOL_PARAMETERS,
    execute: async (_toolCallId, rawParams) => {
      const params = readParams(rawParams);
      const action: ChannelsAction = params.action ?? "status";
      switch (action) {
        case "status":
          return jsonResult(await handleStatus());
        case "catalog":
          return jsonResult(await handleCatalog());
        case "add":
          return jsonResult(await handleAdd(params));
        case "remove":
          return jsonResult(await handleRemove(params));
        case "set_policy":
          return jsonResult(await handleSetPolicy(params));
        case "pairing_list":
          return jsonResult(await handlePairingList(params));
        case "pairing_approve":
          return jsonResult(await handlePairingApprove(params));
        default:
          throw new ToolInputError(`Unknown action: ${String(action)}`);
      }
    },
  };
}
