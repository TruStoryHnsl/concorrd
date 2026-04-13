export const DISCORD_VOICE_BRIDGE_IDENTITY_PREFIX = "discord-voice:";

export type VoiceParticipantLike = {
  identity: string;
  name?: string | null;
};

export function isDiscordVoiceBridgeParticipant(
  participant: VoiceParticipantLike,
): boolean {
  return (
    participant.identity.startsWith(DISCORD_VOICE_BRIDGE_IDENTITY_PREFIX) ||
    participant.name?.trim().toLowerCase() === "discord voice"
  );
}

export function splitDiscordVoiceBridgeParticipants<T extends VoiceParticipantLike>(
  participants: T[],
): {
  bridgeConnected: boolean;
  visibleParticipants: T[];
} {
  const visibleParticipants = participants.filter(
    (participant) => !isDiscordVoiceBridgeParticipant(participant),
  );
  return {
    bridgeConnected: visibleParticipants.length !== participants.length,
    visibleParticipants,
  };
}
