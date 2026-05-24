import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config/config.js", () => ({
  mutateConfigFile: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
}));

vi.mock("../../channels/plugins/registry-loaded.js", () => ({
  listLoadedChannelPlugins: vi.fn(),
}));

vi.mock("../../plugins/clawhub.js", () => ({
  installPluginFromClawHub: vi.fn(),
}));

vi.mock("../../plugins/official-external-plugin-catalog.js", () => ({
  getOfficialExternalPluginCatalogEntry: vi.fn(),
  listOfficialExternalChannelCatalogEntries: vi.fn(),
  resolveOfficialExternalPluginId: vi.fn(),
  resolveOfficialExternalPluginInstall: vi.fn(),
}));

import { listLoadedChannelPlugins } from "../../channels/plugins/registry-loaded.js";
import { mutateConfigFile, readConfigFileSnapshot } from "../../config/config.js";
import { installPluginFromClawHub } from "../../plugins/clawhub.js";
import {
  getOfficialExternalPluginCatalogEntry,
  listOfficialExternalChannelCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
} from "../../plugins/official-external-plugin-catalog.js";
import { ToolInputError } from "./common.js";
import { CHANNELS_TOOL_NAME, createChannelsSelfConfigTool } from "./self-config-tool.js";

// vi.mocked() preserves the strict module signatures, which forces test
// fixtures into types like ConfigFileSnapshot / ClawHubInstallSuccess. The
// per-action behavior here only needs the shape the tool reads, so we erase
// the signatures via unknown casts and let each test supply minimal shapes.
type AnyAsyncMock = ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;
type AnySyncMock = ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>;

const mutateConfigFileMock = mutateConfigFile as unknown as AnyAsyncMock;
const readConfigFileSnapshotMock = readConfigFileSnapshot as unknown as AnyAsyncMock;
const listLoadedChannelPluginsMock = listLoadedChannelPlugins as unknown as AnySyncMock;
const installPluginFromClawHubMock = installPluginFromClawHub as unknown as AnyAsyncMock;
const getCatalogEntryMock = getOfficialExternalPluginCatalogEntry as unknown as AnySyncMock;
const listCatalogEntriesMock = listOfficialExternalChannelCatalogEntries as unknown as AnySyncMock;
const resolveIdMock = resolveOfficialExternalPluginId as unknown as AnySyncMock;
const resolveInstallMock = resolveOfficialExternalPluginInstall as unknown as AnySyncMock;

function parseJsonContent(result: { content: ReadonlyArray<{ type: string }> }): unknown {
  const first = result.content[0];
  expect(first?.type).toBe("text");
  const text = first && "text" in first ? (first as { text: string }).text : "";
  return JSON.parse(text);
}

async function runMutate(
  baseConfig: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  expect(mutateConfigFileMock).toHaveBeenCalledOnce();
  const call = mutateConfigFileMock.mock.calls[0]?.[0] as
    | { mutate: (draft: unknown, ctx: unknown) => void | Promise<void> }
    | undefined;
  if (!call) {
    throw new Error("mutateConfigFile was not called");
  }
  const draft = structuredClone(baseConfig);
  await call.mutate(draft, {});
  return draft;
}

describe("createChannelsSelfConfigTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutateConfigFileMock.mockResolvedValue({});
    readConfigFileSnapshotMock.mockResolvedValue({
      sourceConfig: {},
      config: {},
    });
    listLoadedChannelPluginsMock.mockReturnValue([]);
  });

  it("registers as owner-only with the channels name", () => {
    const tool = createChannelsSelfConfigTool();
    expect(tool.name).toBe(CHANNELS_TOOL_NAME);
    expect(tool.name).toBe("channels");
    expect(tool.ownerOnly).toBe(true);
  });

  it("defaults to status when action is omitted", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      sourceConfig: { channels: { whatsapp: { enabled: true, dmPolicy: "allowlist" } } },
      config: {},
    });
    listLoadedChannelPluginsMock.mockReturnValue([{ id: "whatsapp" }, { id: "telegram" }]);

    const tool = createChannelsSelfConfigTool();
    const result = await tool.execute("call-1", {});

    const payload = parseJsonContent(result) as {
      configured: Array<{ channel: string; enabled: boolean; pluginLoaded: boolean }>;
      loadedPlugins: string[];
    };
    expect(payload.configured).toEqual([
      {
        channel: "whatsapp",
        enabled: true,
        pluginLoaded: true,
        dmPolicy: "allowlist",
        groupPolicy: null,
        allowFromCount: 0,
      },
    ]);
    expect(payload.loadedPlugins).toEqual(["telegram", "whatsapp"]);
  });

  it("returns the catalog action's entries", async () => {
    const entry = { name: "whatsapp", description: "WhatsApp channel" };
    listCatalogEntriesMock.mockReturnValue([entry]);
    resolveIdMock.mockReturnValue("whatsapp");
    resolveInstallMock.mockReturnValue({ clawhubSpec: "clawhub:whatsapp" });

    const tool = createChannelsSelfConfigTool();
    const result = await tool.execute("call-2", { action: "catalog" });

    const payload = parseJsonContent(result) as {
      catalog: Array<{ id: string; install: unknown }>;
    };
    expect(payload.catalog).toEqual([
      {
        id: "whatsapp",
        name: "whatsapp",
        description: "WhatsApp channel",
        install: { clawhubSpec: "clawhub:whatsapp" },
      },
    ]);
  });

  describe("add action", () => {
    it("rejects channels not in the catalog", async () => {
      getCatalogEntryMock.mockReturnValue(undefined);

      const tool = createChannelsSelfConfigTool();
      await expect(
        tool.execute("call-3", { action: "add", channel: "mysteryapp" }),
      ).rejects.toThrow(ToolInputError);
      expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
      expect(mutateConfigFileMock).not.toHaveBeenCalled();
    });

    it("rejects catalog entries without a ClawHub install spec", async () => {
      getCatalogEntryMock.mockReturnValue({ name: "whatsapp" });
      resolveInstallMock.mockReturnValue({ npmSpec: "@openclaw/whatsapp" });

      const tool = createChannelsSelfConfigTool();
      await expect(tool.execute("call-4", { action: "add", channel: "whatsapp" })).rejects.toThrow(
        /ClawHub install spec/,
      );
      expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
      expect(mutateConfigFileMock).not.toHaveBeenCalled();
    });

    it("requires the channel parameter", async () => {
      const tool = createChannelsSelfConfigTool();
      await expect(tool.execute("call-5", { action: "add" })).rejects.toThrow(
        /channel is required/,
      );
    });

    it("returns install failure without writing config", async () => {
      getCatalogEntryMock.mockReturnValue({ name: "whatsapp" });
      resolveIdMock.mockReturnValue("whatsapp");
      resolveInstallMock.mockReturnValue({ clawhubSpec: "clawhub:whatsapp" });
      installPluginFromClawHubMock.mockResolvedValue({ ok: false, message: "registry offline" });

      const tool = createChannelsSelfConfigTool();
      const result = await tool.execute("call-6", { action: "add", channel: "whatsapp" });

      const payload = parseJsonContent(result) as {
        ok: boolean;
        stage: string;
        message: string;
      };
      expect(payload).toEqual({ ok: false, stage: "install", message: "registry offline" });
      expect(mutateConfigFileMock).not.toHaveBeenCalled();
    });

    it("installs the plugin and writes a disabled config skeleton on success", async () => {
      getCatalogEntryMock.mockReturnValue({ name: "whatsapp" });
      resolveIdMock.mockReturnValue("whatsapp");
      resolveInstallMock.mockReturnValue({ clawhubSpec: "clawhub:whatsapp" });
      installPluginFromClawHubMock.mockResolvedValue({ ok: true });

      const tool = createChannelsSelfConfigTool();
      const result = await tool.execute("call-7", { action: "add", channel: "whatsapp" });

      const payload = parseJsonContent(result) as {
        ok: boolean;
        channel: string;
        pluginInstalled: boolean;
        nextStep: string;
      };
      expect(payload.ok).toBe(true);
      expect(payload.channel).toBe("whatsapp");
      expect(payload.pluginInstalled).toBe(true);
      expect(payload.nextStep).toContain("whatsapp_login");

      expect(installPluginFromClawHubMock).toHaveBeenCalledWith({
        spec: "clawhub:whatsapp",
        expectedPluginId: "whatsapp",
      });

      const draft = await runMutate();
      expect(draft.channels).toEqual({ whatsapp: { enabled: false } });
      expect(draft.plugins).toEqual({ entries: { whatsapp: { enabled: true } } });
    });

    it("preserves existing channel config when adding again", async () => {
      getCatalogEntryMock.mockReturnValue({ name: "whatsapp" });
      resolveIdMock.mockReturnValue("whatsapp");
      resolveInstallMock.mockReturnValue({ clawhubSpec: "clawhub:whatsapp" });
      installPluginFromClawHubMock.mockResolvedValue({ ok: true });

      const tool = createChannelsSelfConfigTool();
      await tool.execute("call-8", { action: "add", channel: "whatsapp" });

      const existing = {
        channels: { whatsapp: { enabled: true, dmPolicy: "allowlist" } },
        plugins: { entries: { whatsapp: { enabled: true, config: { keep: 1 } } } },
      };
      const draft = await runMutate(existing);
      expect(draft.channels).toEqual({ whatsapp: { enabled: true, dmPolicy: "allowlist" } });
      expect(draft.plugins).toEqual({
        entries: { whatsapp: { enabled: true, config: { keep: 1 } } },
      });
    });

    it("short-circuits with alreadyInstalled when the plugin is already loaded (no install call)", async () => {
      getCatalogEntryMock.mockReturnValue({ name: "whatsapp" });
      resolveIdMock.mockReturnValue("whatsapp");
      listLoadedChannelPluginsMock.mockReturnValue([{ id: "whatsapp" }, { id: "telegram" }]);

      const tool = createChannelsSelfConfigTool();
      const result = await tool.execute("call-9", { action: "add", channel: "whatsapp" });

      const payload = parseJsonContent(result) as {
        ok: boolean;
        channel: string;
        pluginInstalled: boolean;
        alreadyInstalled: boolean;
        nextStep: string;
      };

      expect(payload.ok).toBe(true);
      expect(payload.channel).toBe("whatsapp");
      expect(payload.pluginInstalled).toBe(true);
      expect(payload.alreadyInstalled).toBe(true);
      expect(payload.nextStep).toContain("whatsapp_login");

      // Critical: install must not be attempted when already loaded
      expect(installPluginFromClawHubMock).not.toHaveBeenCalled();

      // Still ensures skeleton (idempotent mutate)
      const draft = await runMutate();
      expect(draft.channels?.whatsapp).toEqual({ enabled: false });
      expect(draft.plugins?.entries?.whatsapp).toEqual({ enabled: true });
    });
  });

  describe("remove action", () => {
    it("requires a channel parameter", async () => {
      const tool = createChannelsSelfConfigTool();
      await expect(tool.execute("call-9", { action: "remove" })).rejects.toThrow(
        /channel is required/,
      );
    });

    it("deletes channel + plugin entries from config", async () => {
      const tool = createChannelsSelfConfigTool();
      const result = await tool.execute("call-10", { action: "remove", channel: "whatsapp" });

      const payload = parseJsonContent(result) as {
        ok: boolean;
        channel: string;
        removed: boolean;
      };
      expect(payload).toEqual({ ok: true, channel: "whatsapp", removed: true });

      const draft = await runMutate({
        channels: { whatsapp: { enabled: true }, telegram: { enabled: true } },
        plugins: { entries: { whatsapp: { enabled: true }, telegram: { enabled: true } } },
      });
      expect(draft.channels).toEqual({ telegram: { enabled: true } });
      expect(draft.plugins).toEqual({ entries: { telegram: { enabled: true } } });
    });
  });

  describe("set_policy action", () => {
    it("rejects empty policy updates", async () => {
      const tool = createChannelsSelfConfigTool();
      await expect(
        tool.execute("call-11", { action: "set_policy", channel: "whatsapp" }),
      ).rejects.toThrow(/at least one of/);
      expect(mutateConfigFileMock).not.toHaveBeenCalled();
    });

    it("requires a channel parameter", async () => {
      const tool = createChannelsSelfConfigTool();
      await expect(
        tool.execute("call-12", { action: "set_policy", dmPolicy: "allowlist" }),
      ).rejects.toThrow(/channel is required/);
    });

    it("writes dmPolicy + allowFrom and enables when dmPolicy is non-disabled", async () => {
      const tool = createChannelsSelfConfigTool();
      const result = await tool.execute("call-13", {
        action: "set_policy",
        channel: "whatsapp",
        dmPolicy: "allowlist",
        allowFrom: ["+15551234567"],
      });

      const payload = parseJsonContent(result) as {
        ok: boolean;
        channel: string;
        policyUpdated: boolean;
      };
      expect(payload).toEqual({ ok: true, channel: "whatsapp", policyUpdated: true });

      const draft = await runMutate({ channels: { whatsapp: { enabled: false } } });
      expect(draft.channels).toEqual({
        whatsapp: {
          enabled: true,
          dmPolicy: "allowlist",
          allowFrom: ["+15551234567"],
        },
      });
    });

    it("keeps channel disabled when dmPolicy is set to disabled", async () => {
      const tool = createChannelsSelfConfigTool();
      await tool.execute("call-14", {
        action: "set_policy",
        channel: "whatsapp",
        dmPolicy: "disabled",
      });
      const draft = await runMutate({ channels: { whatsapp: { enabled: true } } });
      expect((draft.channels as Record<string, Record<string, unknown>>).whatsapp).toEqual({
        enabled: true,
        dmPolicy: "disabled",
      });
    });

    it("writes group policy fields when provided", async () => {
      const tool = createChannelsSelfConfigTool();
      await tool.execute("call-15", {
        action: "set_policy",
        channel: "telegram",
        groupPolicy: "allowlist",
        groupAllowFrom: ["-100123"],
      });
      const draft = await runMutate();
      expect(draft.channels).toEqual({
        telegram: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["-100123"],
        },
      });
    });
  });

  describe("pairing stubs", () => {
    it("pairing_list returns a not-implemented message", async () => {
      const tool = createChannelsSelfConfigTool();
      const result = await tool.execute("call-16", { action: "pairing_list", channel: "whatsapp" });
      const payload = parseJsonContent(result) as { ok: boolean; message: string };
      expect(payload.ok).toBe(false);
      expect(payload.message).toMatch(/not yet implemented/);
    });

    it("pairing_approve returns a not-implemented message", async () => {
      const tool = createChannelsSelfConfigTool();
      const result = await tool.execute("call-17", {
        action: "pairing_approve",
        channel: "whatsapp",
        code: "ABC123",
      });
      const payload = parseJsonContent(result) as { ok: boolean; message: string };
      expect(payload.ok).toBe(false);
      expect(payload.message).toMatch(/not yet implemented/);
    });
  });
});
