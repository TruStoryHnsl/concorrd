import { memo, useState } from "react";
import { Avatar } from "../ui/Avatar";
import { BringingUpSplash } from "../BringingUpSplash";

interface Participant {
  userId: string;
  isSpeaking: boolean;
  isMuted: boolean;
  hasVideo: boolean;
}

interface PlaceVoiceBannerProps {
  participants: Participant[];
  onLeave: () => void;
  onMute: () => void;
  onToggleCamera: () => void;
  onVideoClick: (userId: string) => void;
  onDismiss: () => void;
}

export const PlaceVoiceBanner = memo(function PlaceVoiceBanner({
  participants,
  onLeave,
  onMute,
  onToggleCamera,
  onVideoClick,
  onDismiss,
}: PlaceVoiceBannerProps) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const hasVideo = participants.some((p) => p.hasVideo);

  return (
    <div
      className={`flex-shrink-0 border-b border-outline-variant/20 bg-surface-container-low flex items-${hasVideo ? "stretch" : "center"} gap-2 px-3 ${hasVideo ? "pt-1.5" : "pt-1.5"} pb-3`}
      // Bottom padding has two jobs:
      //   1. Normal browsers — give the mic/cam/leave controls a comfortable
      //      gap to the bottom edge (the banner used to slam controls flush
      //      against the chat layout's bottom border).
      //   2. Mobile / installed-PWA / Tauri iOS — respect
      //      `env(safe-area-inset-bottom)` so the iOS home indicator does
      //      not overlap the controls. `max()` floors at 0.75rem so the
      //      desktop padding never collapses below the Tailwind `pb-3`.
      style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      {/* Participant pills */}
      <div className="flex-1 flex gap-2 overflow-x-auto min-w-0 py-1">
        {participants.map((p) => (
          <PlacePill key={p.userId} participant={p} onVideoClick={onVideoClick} />
        ))}
        {participants.length === 0 && (
          <span className="inline-flex items-center gap-1.5 text-xs text-on-surface-variant/60 font-label">
            <BringingUpSplash size="inline" />
            Connecting…
          </span>
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center gap-1 flex-shrink-0">
        <div className="relative">
          <button
            type="button"
            onClick={() => setOverflowOpen((v) => !v)}
            className="btn-press w-7 h-7 flex items-center justify-center rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors text-base leading-none"
            title="Voice options"
          >
            ⋯
          </button>
          {overflowOpen && (
            <div className="absolute right-0 bottom-full mb-1 glass-panel rounded-xl p-1 shadow-xl z-50 min-w-[140px]">
              <button
                type="button"
                onClick={() => { onMute(); setOverflowOpen(false); }}
                className="w-full px-3 py-2 text-left text-sm text-on-surface hover:bg-surface-container-high rounded-lg transition-colors"
              >
                Mute mic
              </button>
              <button
                type="button"
                onClick={() => { onToggleCamera(); setOverflowOpen(false); }}
                className="w-full px-3 py-2 text-left text-sm text-on-surface hover:bg-surface-container-high rounded-lg transition-colors"
              >
                Toggle camera
              </button>
              <button
                type="button"
                onClick={() => { onLeave(); setOverflowOpen(false); }}
                className="w-full px-3 py-2 text-left text-sm text-error hover:bg-error/10 rounded-lg transition-colors"
              >
                Leave
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="btn-press w-7 h-7 flex items-center justify-center rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors"
          title="Collapse banner"
        >
          <span className="material-symbols-outlined text-sm">expand_less</span>
        </button>
      </div>
    </div>
  );
});

function PlacePill({
  participant,
  onVideoClick,
}: {
  participant: Participant;
  onVideoClick: (userId: string) => void;
}) {
  if (participant.hasVideo) {
    return (
      <button
        type="button"
        onClick={() => onVideoClick(participant.userId)}
        className="btn-press flex-none flex flex-col rounded-xl overflow-hidden bg-surface-container-high cursor-pointer"
        style={{ width: "120px" }}
      >
        <div
          className="w-full flex items-center justify-center bg-surface-container"
          style={{ aspectRatio: "1/1", position: "relative" }}
        >
          <Avatar userId={participant.userId} size="lg" />
          <span
            className="absolute top-1 right-1 material-symbols-outlined text-white/70 bg-black/40 rounded"
            style={{ fontSize: "12px", padding: "2px" }}
          >
            open_in_full
          </span>
        </div>
        <div className="flex items-center justify-between px-1.5 py-0.5">
          <ParticipantLocalPart userId={participant.userId} />
          <span className="text-[9px] text-error">● cam</span>
        </div>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-surface-container-high flex-none max-w-[140px]">
      <Avatar userId={participant.userId} size="sm" />
      <ParticipantLocalPart userId={participant.userId} truncate />
      {participant.isSpeaking ? (
        <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse ml-auto flex-shrink-0" />
      ) : participant.isMuted ? (
        <span className="material-symbols-outlined text-on-surface-variant flex-shrink-0" style={{ fontSize: "10px" }}>
          mic_off
        </span>
      ) : null}
    </div>
  );
}

function ParticipantLocalPart({ userId, truncate = false }: { userId: string; truncate?: boolean }) {
  const localPart = userId.split(":")[0]?.replace("@", "") ?? userId;
  return (
    <span className={`text-[10px] text-on-surface-variant font-label ${truncate ? "truncate max-w-[70px]" : ""}`}>
      {localPart}
    </span>
  );
}
