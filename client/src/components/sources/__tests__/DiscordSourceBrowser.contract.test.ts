import { describe, expect, it } from "vitest";
import source from "../DiscordSourceBrowser.tsx?raw";

describe("DiscordSourceBrowser contracts", () => {
  it("persists voice mappings per user so disconnected bridges still show up in the menu", () => {
    expect(source).toContain("concord_discord_voice_mappings:");
    expect(source).toContain("concord_discord_voice_channels:");
    expect(source).toContain("readCachedVoiceMappings");
    expect(source).toContain("writeCachedVoiceMappings");
    expect(source).toContain("readCachedVoiceChannels");
    expect(source).toContain("writeCachedVoiceChannels");
    expect(source).toContain("useState<DiscordVoiceBridgeRoom[]>(");
    expect(source).not.toContain("if (!mapping.enabled) continue;");
  });

  it("opens bridged voice entries as voice channels on the Discord guild server", () => {
    expect(source).toContain('channelType: channel.kind === "voice" ? "voice" : "text"');
    expect(source).toContain('preferBridgeServer: channel.kind === "voice"');
  });

  it("offers a direct bridge reload action from the discord source browser", () => {
    expect(source).toContain("discordVoiceBridgeHttpRestart");
    expect(source).toContain("Reload bridge");
    expect(source).toContain("handleReloadBridge");
  });
});
