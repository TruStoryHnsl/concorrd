import { describe, expect, it } from "vitest";
import {
  isDiscordVoiceBridgeParticipant,
  splitDiscordVoiceBridgeParticipants,
} from "../discordVoiceBridge";

describe("discord voice bridge participant helpers", () => {
  it("identifies the sidecar participant by identity prefix", () => {
    expect(
      isDiscordVoiceBridgeParticipant({
        identity: "discord-voice:123:456",
        name: "Discord Voice",
      }),
    ).toBe(true);
  });

  it("filters the sidecar out of interactive participant lists", () => {
    const result = splitDiscordVoiceBridgeParticipants([
      { identity: "@alice:concorrd.com", name: "alice" },
      { identity: "discord-voice:123:456", name: "Discord Voice" },
      { identity: "@bob:concorrd.com", name: "bob" },
    ]);

    expect(result.bridgeConnected).toBe(true);
    expect(result.visibleParticipants).toEqual([
      { identity: "@alice:concorrd.com", name: "alice" },
      { identity: "@bob:concorrd.com", name: "bob" },
    ]);
  });
});
