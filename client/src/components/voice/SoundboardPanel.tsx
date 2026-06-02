import { useState, useEffect, useRef, useCallback } from "react";
import type { LocalParticipant, LocalTrackPublication } from "livekit-client";
import { Track } from "livekit-client";
import {
  listSoundboardLibrary,
  uploadSoundboardClip,
  deleteSoundboardClip,
  updateSoundboardClip,
  searchSoundLibrary,
  importLibrarySound,
  type SoundboardClip,
  type LibrarySound,
  type LibrarySortOption,
} from "../../api/concord";
import { useAuthStore } from "../../stores/auth";
import { useServerStore } from "../../stores/server";
import { useSettingsStore } from "../../stores/settings";
import { Slider } from "../ui/Slider";

interface SoundboardPanelProps {
  serverId: string;
  localParticipant?: LocalParticipant;
}

interface ActivePlayback {
  source: AudioBufferSourceNode;
  track?: MediaStreamTrack;
  publication?: LocalTrackPublication;
}

export function SoundboardPanel({
  serverId,
  localParticipant,
}: SoundboardPanelProps) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const userId = useAuthStore((s) => s.userId);
  const servers = useServerStore((s) => s.servers);
  const isOwner = servers.find((s) => s.id === serverId)?.owner_id === userId;
  const [clips, setClips] = useState<SoundboardClip[]>([]);
  const [loading, setLoading] = useState(true);
  const [playingId, setPlayingId] = useState<number | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [showVolume, setShowVolume] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editingClipId, setEditingClipId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editKeybind, setEditKeybind] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const activePlaybackRef = useRef<ActivePlayback | null>(null);
  // Use ref for localParticipant so cleanup effect doesn't re-run on participant changes
  const participantRef = useRef(localParticipant);
  participantRef.current = localParticipant;

  // INS-073: load from the instance-wide library, not a per-server slice.
  // Every clip uploaded on this instance, by any user on any server, is
  // visible here. The dual-mode browse UI further down switches between
  // this local pool and the online Freesound discovery feed.
  const loadClips = useCallback(async () => {
    if (!accessToken) return;
    try {
      const data = await listSoundboardLibrary(accessToken);
      setClips(data);
    } catch (err) {
      console.error("Failed to load clips:", err);
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    loadClips();
  }, [loadClips]);

  // Cleanup on unmount only (no deps — uses refs for mutable state)
  useEffect(() => {
    return () => {
      const playback = activePlaybackRef.current;
      if (playback) {
        try { playback.source.stop(); } catch { /* already stopped */ }
        if (playback.track) playback.track.stop();
        if (playback.publication && participantRef.current) {
          try { participantRef.current.unpublishTrack(playback.track!); } catch { /* best effort */ }
        }
        activePlaybackRef.current = null;
      }
      if (audioCtxRef.current) {
        audioCtxRef.current.close();
        audioCtxRef.current = null;
      }
    };
  }, []);

  const playClip = useCallback(
    async (clip: SoundboardClip) => {
      if (playingId) return; // prevent overlapping playback
      setPlayingId(clip.id);

      try {
        const token = useAuthStore.getState().accessToken;
        const resp = await fetch(clip.url, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!resp.ok) throw new Error(`Failed to fetch clip: ${resp.status}`);
        const arrayBuffer = await resp.arrayBuffer();

        if (!audioCtxRef.current) {
          audioCtxRef.current = new AudioContext();
        }
        const ctx = audioCtxRef.current;
        if (ctx.state === "suspended") await ctx.resume();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;

        // Read current settings for normalization + volume
        const settings = useSettingsStore.getState();
        const sbVolume = settings.soundboardVolume;

        // Build audio chain: source → compressor → gain → volume → output
        const compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = settings.compressorThreshold;
        compressor.knee.value = settings.compressorKnee;
        compressor.ratio.value = settings.compressorRatio;
        compressor.attack.value = settings.compressorAttack;
        compressor.release.value = settings.compressorRelease;

        const makeupGainNode = ctx.createGain();
        makeupGainNode.gain.value = settings.makeupGain;

        const volumeNode = ctx.createGain();
        volumeNode.gain.value = sbVolume;

        // Chain: source → compressor → makeup → volume
        source.connect(compressor);
        compressor.connect(makeupGainNode);
        makeupGainNode.connect(volumeNode);

        const participant = participantRef.current;

        if (participant) {
          // Inject into LiveKit: route audio through MediaStream for remote users
          const dest = ctx.createMediaStreamDestination();
          volumeNode.connect(dest);
          volumeNode.connect(ctx.destination); // also play locally

          const track = dest.stream.getAudioTracks()[0];
          const publication = await participant.publishTrack(track, {
            name: "soundboard",
            source: Track.Source.Unknown,
          });

          activePlaybackRef.current = { source, track, publication };

          source.onended = () => {
            setPlayingId(null);
            activePlaybackRef.current = null;
            // Clean up: unpublish after a short delay to let the audio drain
            setTimeout(() => {
              if (publication) {
                participant.unpublishTrack(track);
              }
              track.stop();
            }, 200);
          };
        } else {
          // No voice connection — just play locally
          volumeNode.connect(ctx.destination);
          activePlaybackRef.current = { source };
          source.onended = () => {
            setPlayingId(null);
            activePlaybackRef.current = null;
          };
        }

        source.start();
      } catch (err) {
        console.error("Failed to play clip:", err);
        setPlayingId(null);
        activePlaybackRef.current = null;
      }
    },
    [playingId],
  );

  const stopClip = useCallback(() => {
    const playback = activePlaybackRef.current;
    if (!playback) return;
    try { playback.source.stop(); } catch { /* already stopped */ }
    // onended handler will clean up state, unpublish track, etc.
  }, []);

  // Soundboard hotkey listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger hotkeys when typing in inputs
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const parts: string[] = [];
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      if (!["Control", "Alt", "Shift", "Meta"].includes(e.key)) {
        parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
      }
      if (parts.length === 0) return;

      const combo = parts.join("+");
      const match = clips.find((c) => c.keybind === combo);
      if (match) {
        e.preventDefault();
        if (playingId === match.id) {
          stopClip();
        } else if (!playingId) {
          playClip(match);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [clips, playingId, playClip, stopClip]);

  const handleDelete = async (clipId: number) => {
    if (!accessToken) return;
    try {
      await deleteSoundboardClip(clipId, accessToken);
      setClips((prev) => prev.filter((c) => c.id !== clipId));
    } catch (err) {
      console.error("Failed to delete clip:", err);
    }
    setConfirmDeleteId(null);
  };

  const handleUpdateClip = async (clipId: number, updates: { name?: string; keybind?: string }) => {
    if (!accessToken) return;
    try {
      const result = await updateSoundboardClip(clipId, updates, accessToken);
      setClips((prev) => prev.map((c) => c.id === clipId ? { ...c, name: result.name, keybind: result.keybind } : c));
    } catch (err) {
      console.error("Failed to update clip:", err);
    }
    setEditingClipId(null);
  };

  const soundboardVolume = useSettingsStore((s) => s.soundboardVolume);
  const setSoundboardVolume = useSettingsStore((s) => s.setSoundboardVolume);

  if (loading) {
    return (
      <div className="p-3 text-on-surface-variant text-sm">Loading soundboard...</div>
    );
  }

  return (
    <div className={`border-t border-outline-variant/15 ${showLibrary ? "flex-1 shrink flex flex-col min-h-0 max-h-[60%]" : "shrink-0 max-h-[50%] overflow-y-auto"}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-surface-container">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-on-surface-variant uppercase tracking-wider">
            Soundboard
          </span>
          <button
            onClick={() => setShowVolume(!showVolume)}
            className={`text-xs transition-colors ${showVolume ? "text-primary" : "text-on-surface-variant hover:text-on-surface"}`}
            title="Soundboard volume"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
            </svg>
          </button>
        </div>
        <div className="flex items-center gap-2">
          {(isOwner || clips.some((c) => c.uploaded_by === userId)) && (
            <button
              onClick={() => { setEditMode(!editMode); setEditingClipId(null); setConfirmDeleteId(null); }}
              className={`text-xs transition-colors ${editMode ? "text-primary" : "text-on-surface-variant hover:text-on-surface"}`}
            >
              {editMode ? "Done" : "Edit"}
            </button>
          )}
          <button
            onClick={() => { setShowLibrary(!showLibrary); if (!showLibrary) setShowUpload(false); }}
            className={`text-xs transition-colors ${showLibrary ? "text-primary" : "text-on-surface-variant hover:text-on-surface"}`}
          >
            {showLibrary ? "Close" : "Browse"}
          </button>
          <button
            onClick={() => { setShowUpload(!showUpload); if (!showUpload) setShowLibrary(false); }}
            className="text-xs text-on-surface-variant hover:text-on-surface transition-colors"
          >
            {showUpload ? "Cancel" : "+ Upload"}
          </button>
        </div>
      </div>

      {/* Soundboard volume slider (toggled) */}
      {showVolume && (
        <div className="px-4 py-2">
          <Slider
            label="Soundboard Volume"
            value={soundboardVolume}
            min={0}
            max={2}
            step={0.01}
            onChange={setSoundboardVolume}
            formatValue={(v) => `${Math.round(v * 100)}%`}
          />
        </div>
      )}

      {/* Upload form */}
      {showUpload && (
        <UploadForm
          serverId={serverId}
          onUploaded={(clip) => {
            setClips((prev) => [...prev, clip]);
            setShowUpload(false);
          }}
        />
      )}

      {/* INS-073: dual-mode library browser — Local (instance-wide pool) +
          Discover (Freesound). The Local tab lets the user pick any clip
          already in the instance library to play directly; the Discover
          tab is the existing Freesound search/import flow. */}
      {showLibrary && (
        <LibraryBrowser
          serverId={serverId}
          existingClips={clips}
          onImported={(clip) => {
            setClips((prev) => [...prev, clip]);
          }}
          onPlayLocal={(clip) => {
            if (playingId) return;
            playClip(clip);
          }}
          isPlaying={(clipId) => playingId === clipId}
        />
      )}

      {/* Clip grid — scales down as clip count grows */}
      {clips.length === 0 ? (
        <div className="px-4 py-6 text-on-surface-variant text-xs text-center">
          <div className="text-2xl mb-1">🔊</div>
          No clips yet. Upload one or browse the library.
        </div>
      ) : (
        <div className="p-2 max-h-48 overflow-y-auto">
          <div className={`flex flex-wrap gap-1`}>
            {clips.map((clip) => {
              const canDelete = isOwner || clip.uploaded_by === userId;
              // Scale button size based on total clip count
              const sizeClass =
                clips.length <= 6
                  ? "px-2.5 py-2 text-xs"
                  : clips.length <= 12
                    ? "px-2 py-1.5 text-[11px]"
                    : clips.length <= 24
                      ? "px-1.5 py-1 text-[10px]"
                      : "px-1 py-0.5 text-[9px]";

              return (
                <div key={clip.id} className="group relative">
                  <button
                    onClick={() => playingId === clip.id ? stopClip() : playClip(clip)}
                    disabled={playingId !== null && playingId !== clip.id}
                    className={`rounded-md font-medium transition-all truncate ${sizeClass} ${
                      playingId === clip.id
                        ? "bg-secondary-container text-on-surface animate-pulse cursor-pointer"
                        : "bg-surface-container text-on-surface hover:bg-surface-container-highest hover:text-on-surface disabled:opacity-50"
                    }`}
                    title={playingId === clip.id ? "Click to stop" : clip.keybind ? `${clip.name} [${clip.keybind}]` : clip.name}
                  >
                    {clip.name}
                  </button>
                  {/* Edit mode overlay */}
                  {editMode && canDelete && (
                    editingClipId === clip.id ? (
                      <div className="absolute inset-0 bg-surface/95 rounded-md flex items-center justify-center gap-1 p-1 z-10">
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleUpdateClip(clip.id, { name: editName.trim() || undefined, keybind: editKeybind });
                            if (e.key === "Escape") setEditingClipId(null);
                          }}
                          className="flex-1 min-w-0 bg-surface-container text-on-surface text-[10px] px-1.5 py-0.5 rounded border border-outline-variant focus:outline-none focus:ring-1 focus:ring-primary/30"
                          placeholder="Name"
                          autoFocus
                        />
                        <input
                          type="text"
                          value={editKeybind}
                          onChange={(e) => setEditKeybind(e.target.value)}
                          onKeyDown={(e) => {
                            // Capture key combo (e.g. Alt+1)
                            if (e.key === "Escape") { setEditingClipId(null); return; }
                            if (e.key === "Enter") { handleUpdateClip(clip.id, { name: editName.trim() || undefined, keybind: editKeybind }); return; }
                            if (e.key === "Backspace" && !editKeybind) return;
                            if (e.key === "Backspace") { e.preventDefault(); setEditKeybind(""); return; }
                            const parts: string[] = [];
                            if (e.ctrlKey) parts.push("Ctrl");
                            if (e.altKey) parts.push("Alt");
                            if (e.shiftKey) parts.push("Shift");
                            if (!["Control", "Alt", "Shift", "Meta"].includes(e.key)) {
                              parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
                            }
                            if (parts.length > 0 && !["Control", "Alt", "Shift", "Meta"].includes(e.key)) {
                              e.preventDefault();
                              setEditKeybind(parts.join("+"));
                            }
                          }}
                          className="w-16 shrink-0 bg-surface-container text-on-surface text-[10px] px-1.5 py-0.5 rounded border border-outline-variant focus:outline-none focus:ring-1 focus:ring-primary/30"
                          placeholder="Hotkey"
                          readOnly={false}
                        />
                        <button
                          onClick={() => handleUpdateClip(clip.id, { name: editName.trim() || undefined, keybind: editKeybind })}
                          className="text-secondary hover:text-secondary text-[10px] shrink-0"
                          title="Save"
                        >
                          OK
                        </button>
                        {confirmDeleteId === clip.id ? (
                          <button
                            onClick={() => handleDelete(clip.id)}
                            onMouseLeave={() => setConfirmDeleteId(null)}
                            className="text-error hover:text-on-error-container text-[10px] shrink-0 animate-pulse"
                            title="Click to confirm delete"
                          >
                            Del?
                          </button>
                        ) : (
                          <button
                            onClick={() => setConfirmDeleteId(clip.id)}
                            className="text-on-surface-variant hover:text-error text-[10px] shrink-0"
                            title="Delete clip"
                          >
                            Del
                          </button>
                        )}
                      </div>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingClipId(clip.id);
                          setEditName(clip.name);
                          setEditKeybind(clip.keybind ?? "");
                          setConfirmDeleteId(null);
                        }}
                        className="absolute inset-0 bg-surface/70 rounded-md flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <span className="text-[10px] text-on-surface">{clip.keybind ? `[${clip.keybind}]` : "Edit"}</span>
                      </button>
                    )
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function UploadForm({
  serverId,
  onUploaded,
}: {
  serverId: string;
  onUploaded: (clip: SoundboardClip) => void;
}) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !file || !accessToken) return;

    setUploading(true);
    setError(null);
    try {
      const clip = await uploadSoundboardClip(serverId, name.trim(), file, accessToken);
      onUploaded(clip);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="px-4 py-3 bg-surface-container/30 border-b border-outline-variant/15 space-y-2"
    >
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Clip name"
        className="w-full px-3 py-1.5 bg-surface-container border border-outline-variant rounded text-sm text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
      />
      <input
        type="file"
        accept=".mp3,.wav,.ogg,.webm,.m4a"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="w-full text-xs text-on-surface-variant file:mr-2 file:px-3 file:py-1 file:bg-surface-container-highest file:border-0 file:rounded file:text-xs file:text-on-surface file:cursor-pointer"
      />
      {error && <p className="text-xs text-error">{error}</p>}
      <button
        type="submit"
        disabled={!name.trim() || !file || uploading}
        className="w-full px-3 py-1.5 primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface text-sm rounded transition-colors"
      >
        {uploading ? "Uploading..." : "Upload Clip"}
      </button>
    </form>
  );
}

/**
 * INS-073: dual-mode browser. "Local" lists every clip in the
 * instance-wide library (with a name filter); "Discover" runs Freesound
 * searches and imports into the same instance-wide library. The two
 * modes share a header but otherwise render independent panels.
 */
function LibraryBrowser({
  serverId,
  existingClips,
  onImported,
  onPlayLocal,
  isPlaying,
}: {
  serverId: string;
  existingClips: SoundboardClip[];
  onImported: (clip: SoundboardClip) => void;
  onPlayLocal: (clip: SoundboardClip) => void;
  isPlaying: (clipId: number) => boolean;
}) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const [mode, setMode] = useState<"local" | "discover">("local");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<LibrarySortOption>("relevance");
  const [results, setResults] = useState<LibrarySound[]>([]);
  const [searching, setSearching] = useState(false);
  const [previewingId, setPreviewingId] = useState<number | null>(null);
  const [importingId, setImportingId] = useState<number | null>(null);
  const [trimmingSound, setTrimmingSound] = useState<LibrarySound | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastQueryRef = useRef("");

  // Local-mode filter: case-insensitive substring match on the existing
  // (already-loaded) instance-wide library. We deliberately filter on the
  // client rather than calling /api/soundboard/library?q=... again — the
  // parent already has the full list cached, so re-fetching wastes a
  // round-trip and risks a flicker.
  const localMatches = (() => {
    if (mode !== "local") return existingClips;
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return existingClips;
    return existingClips.filter((c) => c.name.toLowerCase().includes(trimmed));
  })();

  const doSearch = useCallback(async (q: string, s: LibrarySortOption) => {
    if (!q.trim() || !accessToken) return;
    setSearching(true);
    setError(null);
    lastQueryRef.current = q;
    try {
      const data = await searchSoundLibrary(q.trim(), accessToken, 1, s);
      setResults(data);
      if (data.length === 0) setError("No results found");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setSearching(false);
    }
  }, [accessToken]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    doSearch(query, sort);
  };

  const handleSortChange = (newSort: LibrarySortOption) => {
    setSort(newSort);
    if (lastQueryRef.current) {
      doSearch(lastQueryRef.current, newSort);
    }
  };

  const handlePreview = (sound: LibrarySound) => {
    // Stop current preview
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (previewingId === sound.id) {
      setPreviewingId(null);
      return;
    }
    const audio = new Audio(sound.preview_url);
    audio.volume = 0.5;
    audio.onended = () => setPreviewingId(null);
    audio.play().catch(() => {});
    audioRef.current = audio;
    setPreviewingId(sound.id);
  };

  const handleImport = async (sound: LibrarySound) => {
    if (!accessToken || importingId) return;
    setImportingId(sound.id);
    try {
      // Clean up the name: remove extension, truncate
      const cleanName = sound.name
        .replace(/\.[^.]+$/, "")
        .replace(/[-_]/g, " ")
        .slice(0, 50)
        .trim();
      // INS-073: forward license + attribution. We capture exactly what
      // the user saw in the search row so the persisted record matches
      // the consent the user gave by clicking Add. The server backfills
      // sentinels if any field is missing.
      const clip = await importLibrarySound(
        serverId,
        sound.id,
        cleanName || sound.name,
        sound.preview_url,
        accessToken,
        {
          license: sound.license ?? null,
          license_url: sound.license_url ?? null,
          attribution: sound.username ?? null,
        },
      );
      onImported(clip);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImportingId(null);
    }
  };

  // Cleanup audio on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  if (trimmingSound) {
    return (
      <TrimEditor
        sound={trimmingSound}
        serverId={serverId}
        onDone={(clip) => {
          onImported(clip);
          setTrimmingSound(null);
        }}
        onCancel={() => setTrimmingSound(null)}
      />
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 px-3 py-3 bg-surface-container/30 border-b border-outline-variant/15 gap-2">
      {/* INS-073: dual-mode tab switcher. Local = instance library,
          Discover = Freesound search/import. Resetting query on switch
          would surprise users who toggle to compare results, so we
          deliberately keep the query box across modes. */}
      <div className="flex gap-1 flex-shrink-0" role="tablist" aria-label="Soundboard browse mode">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "local"}
          onClick={() => setMode("local")}
          className={`flex-1 px-3 py-1 text-xs rounded transition-colors ${
            mode === "local"
              ? "bg-primary text-on-surface"
              : "bg-surface-container-high text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest"
          }`}
        >
          Local
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "discover"}
          onClick={() => setMode("discover")}
          className={`flex-1 px-3 py-1 text-xs rounded transition-colors ${
            mode === "discover"
              ? "bg-primary text-on-surface"
              : "bg-surface-container-high text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest"
          }`}
        >
          Discover
        </button>
      </div>

      <form
        onSubmit={mode === "discover" ? handleSearch : (e) => e.preventDefault()}
        className="flex gap-2 flex-shrink-0"
      >
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={mode === "local" ? "Filter library..." : "Search sound effects..."}
          className="flex-1 px-3 py-1.5 bg-surface-container border border-outline-variant rounded text-sm text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
        />
        {mode === "discover" && (
          <button
            type="submit"
            disabled={!query.trim() || searching}
            className="px-3 py-1.5 primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface text-xs rounded transition-colors"
          >
            {searching ? "..." : "Search"}
          </button>
        )}
      </form>

      {/* INS-073: Local mode — render the instance-wide library list,
          filtered by `query`. Clicking a row plays the clip directly. */}
      {mode === "local" && (
        <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
          {localMatches.length === 0 ? (
            <p className="text-xs text-on-surface-variant text-center py-4">
              {existingClips.length === 0
                ? "No clips in the library yet. Use Discover to find some, or upload your own."
                : "No matches. Clear the filter to see everything."}
            </p>
          ) : (
            localMatches.map((clip) => (
              <div
                key={clip.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded bg-surface-container hover:bg-surface-container-high"
              >
                <button
                  onClick={() => onPlayLocal(clip)}
                  className={`w-6 h-6 flex-shrink-0 flex items-center justify-center rounded transition-colors ${
                    isPlaying(clip.id)
                      ? "bg-primary text-on-surface"
                      : "bg-surface-container-highest text-on-surface-variant hover:text-on-surface"
                  }`}
                  title={isPlaying(clip.id) ? "Playing" : "Play"}
                >
                  {isPlaying(clip.id) ? (
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                      <rect x="6" y="4" width="4" height="16" />
                      <rect x="14" y="4" width="4" height="16" />
                    </svg>
                  ) : (
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  )}
                </button>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-on-surface truncate">{clip.name}</p>
                  {/* INS-073: surface attribution for Freesound clips so the
                      CC license obligation is visible at the point of use. */}
                  {clip.source === "freesound" && (
                    <p className="text-[9px] text-on-surface-variant truncate">
                      {clip.attribution ? `by ${clip.attribution} · ` : ""}
                      {clip.license_url ? (
                        <a
                          href={clip.license_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-on-surface underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {clip.license || "view license"}
                        </a>
                      ) : (
                        <span>{clip.license || "freesound.org"}</span>
                      )}
                    </p>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Sort options — shown after first search */}
      {mode === "discover" && (results.length > 0 || lastQueryRef.current) && (
        <div className="flex gap-1 flex-shrink-0 flex-wrap">
          {(["relevance", "popular", "rating", "newest", "shortest", "longest"] as LibrarySortOption[]).map((opt) => (
            <button
              key={opt}
              onClick={() => handleSortChange(opt)}
              className={`px-2 py-0.5 text-[10px] rounded transition-colors capitalize ${
                sort === opt
                  ? "bg-primary text-on-surface"
                  : "bg-surface-container-high text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest"
              }`}
            >
              {opt}
            </button>
          ))}
        </div>
      )}

      {error && <p className="text-xs text-error flex-shrink-0">{error}</p>}

      {mode === "discover" && results.length > 0 && (
        <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
          {results.map((sound) => (
            <div
              key={sound.id}
              className="flex items-center gap-2 px-2 py-1.5 rounded bg-surface-container hover:bg-surface-container-high"
            >
              {/* Preview button */}
              <button
                onClick={() => handlePreview(sound)}
                className={`w-6 h-6 flex-shrink-0 flex items-center justify-center rounded transition-colors ${
                  previewingId === sound.id
                    ? "bg-primary text-on-surface"
                    : "bg-surface-container-highest text-on-surface-variant hover:text-on-surface"
                }`}
                title="Preview"
              >
                {previewingId === sound.id ? (
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                    <rect x="6" y="4" width="4" height="16" />
                    <rect x="14" y="4" width="4" height="16" />
                  </svg>
                ) : (
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>

              {/* Name + duration + license preview */}
              <div className="flex-1 min-w-0">
                <p className="text-xs text-on-surface truncate">{sound.name}</p>
                <p className="text-[10px] text-on-surface-variant truncate">
                  {sound.duration.toFixed(1)}s
                  {sound.username && (
                    <span className="ml-1.5">· by {sound.username}</span>
                  )}
                  {sound.license && (
                    // INS-073: show the CC license inline so the user sees
                    // the obligation BEFORE clicking Add.
                    <span className="ml-1.5">·{" "}
                      {sound.license_url ? (
                        <a
                          href={sound.license_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-on-surface underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          license
                        </a>
                      ) : (
                        "licensed"
                      )}
                    </span>
                  )}
                </p>
              </div>

              {/* Trim button */}
              <button
                onClick={() => { if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; setPreviewingId(null); } setTrimmingSound(sound); }}
                className="w-6 h-6 flex-shrink-0 flex items-center justify-center rounded bg-surface-container-highest text-on-surface-variant hover:text-on-surface hover:bg-surface-bright transition-colors"
                title="Trim & add"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm0-5.758a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z" />
                </svg>
              </button>

              {/* Import button */}
              <button
                onClick={() => handleImport(sound)}
                disabled={importingId !== null}
                className={`px-2 py-1 text-[10px] rounded transition-colors flex-shrink-0 ${
                  importingId === sound.id
                    ? "bg-secondary-container text-on-surface animate-pulse"
                    : "bg-surface-container-highest text-on-surface hover:bg-primary hover:text-on-surface disabled:opacity-50"
                }`}
              >
                {importingId === sound.id ? "Adding..." : "+ Add"}
              </button>
            </div>
          ))}
        </div>
      )}

      {mode === "discover" && (
        <p className="text-[10px] text-on-surface-variant/50 text-center flex-shrink-0">
          Powered by Freesound.org
        </p>
      )}
    </div>
  );
}


/** Encode an AudioBuffer as a WAV file blob. */
function encodeWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const length = buffer.length * numChannels * 2;
  const arrayBuffer = new ArrayBuffer(44 + length);
  const view = new DataView(arrayBuffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + length, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true);
  view.setUint16(32, numChannels * 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, length, true);

  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      view.setInt16(offset, sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
}


function TrimEditor({
  sound,
  serverId,
  onDone,
  onCancel,
}: {
  sound: LibrarySound;
  serverId: string;
  onDone: (clip: SoundboardClip) => void;
  onCancel: () => void;
}) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [regionStart, setRegionStart] = useState(0);
  const [regionEnd, setRegionEnd] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [name, setName] = useState(
    sound.name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ").slice(0, 50).trim()
  );
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const dragRef = useRef<"start" | "end" | "move" | null>(null);
  const dragStartXRef = useRef(0);
  const dragOrigStartRef = useRef(0);
  const dragOrigEndRef = useRef(0);

  // Fetch and decode audio
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(sound.preview_url);
        if (!resp.ok) throw new Error("Failed to fetch");
        const ab = await resp.arrayBuffer();
        const ctx = new AudioContext();
        audioCtxRef.current = ctx;
        const decoded = await ctx.decodeAudioData(ab);
        if (cancelled) return;
        setAudioBuffer(decoded);
        setRegionEnd(decoded.duration);
      } catch {
        if (!cancelled) setLoadError("Failed to load audio");
      }
    })();
    return () => {
      cancelled = true;
      if (sourceRef.current) try { sourceRef.current.stop(); } catch { /* */ }
      if (audioCtxRef.current) audioCtxRef.current.close();
    };
  }, [sound.preview_url]);

  // Draw waveform
  useEffect(() => {
    if (!audioBuffer || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const data = audioBuffer.getChannelData(0);
    const duration = audioBuffer.duration;
    const startPx = (regionStart / duration) * w;
    const endPx = (regionEnd / duration) * w;

    // Background
    ctx.fillStyle = "#18181b";
    ctx.fillRect(0, 0, w, h);

    // Selected region highlight
    ctx.fillStyle = "rgba(99, 102, 241, 0.15)";
    ctx.fillRect(startPx, 0, endPx - startPx, h);

    // Waveform
    const step = Math.ceil(data.length / w);
    const mid = h / 2;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const idx = Math.floor((x / w) * data.length);
      let min = 0, max = 0;
      for (let j = 0; j < step; j++) {
        const val = data[idx + j] || 0;
        if (val < min) min = val;
        if (val > max) max = val;
      }
      const isSelected = x >= startPx && x <= endPx;
      ctx.fillStyle = isSelected ? "#818cf8" : "#52525b";
      ctx.fillRect(x, mid + min * mid, 1, (max - min) * mid || 1);
    }

    // Region handles
    ctx.fillStyle = "#a5b4fc";
    ctx.fillRect(startPx - 1, 0, 2, h);
    ctx.fillRect(endPx - 1, 0, 2, h);

    // Handle grab areas (small triangles at top)
    for (const px of [startPx, endPx]) {
      ctx.fillStyle = "#a5b4fc";
      ctx.beginPath();
      ctx.moveTo(px - 4, 0);
      ctx.lineTo(px + 4, 0);
      ctx.lineTo(px, 6);
      ctx.closePath();
      ctx.fill();
    }
  }, [audioBuffer, regionStart, regionEnd]);

  // Mouse handlers for region selection
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!audioBuffer || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const w = rect.width;
    const duration = audioBuffer.duration;
    const startPx = (regionStart / duration) * w;
    const endPx = (regionEnd / duration) * w;

    const grabThreshold = 8;
    if (Math.abs(x - startPx) < grabThreshold) {
      dragRef.current = "start";
    } else if (Math.abs(x - endPx) < grabThreshold) {
      dragRef.current = "end";
    } else if (x > startPx && x < endPx) {
      dragRef.current = "move";
      dragStartXRef.current = x;
      dragOrigStartRef.current = regionStart;
      dragOrigEndRef.current = regionEnd;
    } else {
      // Click outside region: set new start point
      const t = (x / w) * duration;
      setRegionStart(Math.max(0, t));
      if (t >= regionEnd) setRegionEnd(Math.min(duration, t + 0.5));
      dragRef.current = "end";
    }
  }, [audioBuffer, regionStart, regionEnd]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragRef.current || !audioBuffer || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const duration = audioBuffer.duration;
    const time = (x / rect.width) * duration;

    if (dragRef.current === "start") {
      setRegionStart(Math.max(0, Math.min(time, regionEnd - 0.05)));
    } else if (dragRef.current === "end") {
      setRegionEnd(Math.min(duration, Math.max(time, regionStart + 0.05)));
    } else if (dragRef.current === "move") {
      const dx = x - dragStartXRef.current;
      const dt = (dx / rect.width) * duration;
      const len = dragOrigEndRef.current - dragOrigStartRef.current;
      let newStart = dragOrigStartRef.current + dt;
      let newEnd = dragOrigEndRef.current + dt;
      if (newStart < 0) { newStart = 0; newEnd = len; }
      if (newEnd > duration) { newEnd = duration; newStart = duration - len; }
      setRegionStart(newStart);
      setRegionEnd(newEnd);
    }
  }, [audioBuffer, regionStart, regionEnd]);

  const handleMouseUp = useCallback(() => { dragRef.current = null; }, []);

  // Preview selected region
  const previewRegion = useCallback(() => {
    if (!audioBuffer || !audioCtxRef.current) return;
    if (playing && sourceRef.current) {
      sourceRef.current.stop();
      setPlaying(false);
      return;
    }
    const ctx = audioCtxRef.current;
    if (ctx.state === "suspended") ctx.resume();
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    source.onended = () => setPlaying(false);
    source.start(0, regionStart, regionEnd - regionStart);
    sourceRef.current = source;
    setPlaying(true);
  }, [audioBuffer, playing, regionStart, regionEnd]);

  // Trim and upload
  const handleTrimAndAdd = useCallback(async () => {
    if (!audioBuffer || !accessToken) return;
    setUploading(true);
    try {
      const sampleRate = audioBuffer.sampleRate;
      const startSample = Math.floor(regionStart * sampleRate);
      const endSample = Math.floor(regionEnd * sampleRate);
      const length = endSample - startSample;
      const numChannels = audioBuffer.numberOfChannels;

      const offlineCtx = new OfflineAudioContext(numChannels, length, sampleRate);
      const source = offlineCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(offlineCtx.destination);
      source.start(0, regionStart, regionEnd - regionStart);
      const rendered = await offlineCtx.startRendering();

      const wavBlob = encodeWav(rendered);
      const file = new File([wavBlob], `${name || "trimmed"}.wav`, { type: "audio/wav" });
      const clip = await uploadSoundboardClip(serverId, name || sound.name, file, accessToken);
      onDone(clip);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Trim failed");
    } finally {
      setUploading(false);
    }
  }, [audioBuffer, accessToken, regionStart, regionEnd, name, serverId, sound.name, onDone]);

  const selectedDuration = regionEnd - regionStart;

  return (
    <div className="flex-1 flex flex-col min-h-0 px-3 py-3 bg-surface-container/30 border-b border-outline-variant/15 gap-2">
      {/* Header */}
      <div className="flex items-center justify-between flex-shrink-0">
        <p className="text-xs text-on-surface font-medium truncate flex-1">{sound.name}</p>
        <button
          onClick={onCancel}
          className="text-xs text-on-surface-variant hover:text-on-surface ml-2"
        >
          Back
        </button>
      </div>

      {loadError && <p className="text-xs text-error">{loadError}</p>}

      {!audioBuffer && !loadError && (
        <p className="text-xs text-on-surface-variant">Loading audio...</p>
      )}

      {audioBuffer && (
        <>
          {/* Waveform canvas */}
          <canvas
            ref={canvasRef}
            className="w-full h-16 rounded cursor-col-resize flex-shrink-0"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          />

          {/* Time info */}
          <div className="flex items-center justify-between text-[10px] text-on-surface-variant flex-shrink-0">
            <span>{regionStart.toFixed(2)}s</span>
            <span className="text-on-surface-variant">{selectedDuration.toFixed(2)}s selected</span>
            <span>{regionEnd.toFixed(2)}s</span>
          </div>

          {/* Preview button */}
          <button
            onClick={previewRegion}
            className={`w-full py-1.5 text-xs rounded transition-colors flex-shrink-0 ${
              playing
                ? "bg-primary text-on-surface"
                : "bg-surface-container-highest text-on-surface hover:bg-surface-bright"
            }`}
          >
            {playing ? "Stop Preview" : "Preview Selection"}
          </button>

          {/* Name input */}
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Clip name"
            className="w-full px-3 py-1.5 bg-surface-container border border-outline-variant rounded text-sm text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30 flex-shrink-0"
          />

          {/* Trim & Add button */}
          <button
            onClick={handleTrimAndAdd}
            disabled={uploading || !name.trim() || selectedDuration < 0.05}
            className="w-full py-1.5 primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface text-xs rounded transition-colors flex-shrink-0"
          >
            {uploading ? "Trimming & uploading..." : "Trim & Add"}
          </button>
        </>
      )}
    </div>
  );
}
