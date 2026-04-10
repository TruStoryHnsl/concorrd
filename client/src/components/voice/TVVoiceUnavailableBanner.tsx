/**
 * TVVoiceUnavailableBanner — shown at the top of VoiceChannel on
 * Apple TV where WebRTC microphone capture is not available.
 *
 * tvOS WebKit has never shipped full WebRTC. LiveKit ICE negotiation
 * may work in receive-only mode but microphone capture from a Siri
 * Remote is not possible. The tvOS build is view-only for voice.
 */

export function TVVoiceUnavailableBanner() {
  return (
    <div
      className="flex items-center gap-3 rounded-lg bg-zinc-800 border-l-4 border-amber-500 px-4 py-3 mb-4"
      role="alert"
    >
      <span className="material-symbols-outlined text-amber-400 text-2xl">
        info
      </span>
      <div>
        <p className="text-zinc-200 font-medium text-sm">
          Voice channels are view-only on Apple TV
        </p>
        <p className="text-zinc-400 text-xs mt-0.5">
          Use your phone or computer to speak in this channel.
        </p>
      </div>
    </div>
  );
}
