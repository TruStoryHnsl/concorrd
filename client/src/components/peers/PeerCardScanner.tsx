/**
 * PeerCardScanner (Phase 5 — peer pairing).
 *
 * "Add a peer" UI with three input paths:
 *   1. Camera scan (Tauri-only). Uses `jsQR` against
 *      `getUserMedia({ video: true })` to decode QR codes. Hidden in
 *      web builds because a web concord client has no peer-store to
 *      add into.
 *   2. Paste a `concord://peer/...` URL.
 *   3. Pick from peer cards observed in joined Matrix rooms (via
 *      `useMatrixPeerCards`).
 *
 * On a successful decode + add, the dialog closes via the `onClose`
 * callback. All three paths funnel through `handleAdd()` so the
 * source-tagging stays in one place.
 */

import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { usePeerStore } from "../../stores/peerStore";
import { useToastStore } from "../../stores/toast";
import { isTauri } from "../../api/servitude";
import {
  decodeFromDeeplink,
  decodeFromQrPayload,
  type PeerCard,
} from "../../lib/peerCard";
import type { PeerSource } from "../../api/peerStore";
import {
  useMatrixPeerCards,
  type RecentPeerCard,
} from "../../hooks/useMatrixPeerCards";

type Tab = "camera" | "paste" | "matrix";

export function PeerCardScanner({ onClose }: { onClose: () => void }) {
  const addFromCard = usePeerStore((s) => s.addFromCard);
  const addToast = useToastStore((s) => s.addToast);

  // Default tab: prefer camera in Tauri (most common case), paste on web.
  const [tab, setTab] = useState<Tab>(isTauri() ? "camera" : "paste");
  const [pasteValue, setPasteValue] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const handleAdd = async (card: PeerCard, source: PeerSource) => {
    const added = await addFromCard(card, source);
    if (added) {
      addToast(`Paired with ${card.peerId.slice(0, 12)}…`, "success");
      onClose();
    } else {
      // The store has set its `error` field; surface a friendly toast.
      addToast("Couldn't add peer — see Profile tab for details");
    }
  };

  const handlePasteSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const result = decodeFromDeeplink(pasteValue.trim());
    if (!result.ok) {
      setPasteError(result.error);
      return;
    }
    setPasteError(null);
    void handleAdd(result.card, "deeplink");
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add a peer"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-surface-container rounded-lg p-6 max-w-md w-full mx-4 space-y-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-on-surface">Add a peer</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-on-surface-variant hover:text-on-surface"
            aria-label="Close"
          >
            <span
              className="material-symbols-outlined text-base"
              style={{
                fontVariationSettings:
                  '"FILL" 0, "wght" 500, "GRAD" 0, "opsz" 24',
              }}
            >
              close
            </span>
          </button>
        </div>

        {/* Tab strip */}
        <div className="flex gap-1 border-b border-outline-variant/20">
          {isTauri() && (
            <TabButton
              active={tab === "camera"}
              onClick={() => setTab("camera")}
              label="Scan"
            />
          )}
          <TabButton
            active={tab === "paste"}
            onClick={() => setTab("paste")}
            label="Paste link"
          />
          <TabButton
            active={tab === "matrix"}
            onClick={() => setTab("matrix")}
            label="From rooms"
          />
        </div>

        {/* Tab content */}
        {tab === "camera" && isTauri() && (
          <CameraScan
            onDecoded={(card) => handleAdd(card, "qr")}
            error={cameraError}
            setError={setCameraError}
          />
        )}
        {tab === "paste" && (
          <form onSubmit={handlePasteSubmit} className="space-y-2">
            <input
              type="text"
              value={pasteValue}
              onChange={(e) => {
                setPasteValue(e.target.value);
                if (pasteError) setPasteError(null);
              }}
              placeholder="concord://peer/…"
              className="w-full px-3 py-2 bg-surface-container-high border border-outline-variant rounded text-sm text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30 font-mono"
              autoFocus
            />
            {pasteError && (
              <p className="text-xs text-error">{pasteError}</p>
            )}
            <button
              type="submit"
              disabled={pasteValue.trim().length === 0}
              className="px-4 py-2 primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface text-sm rounded-md transition-colors"
            >
              Add peer
            </button>
          </form>
        )}
        {tab === "matrix" && (
          <MatrixRoomList onPick={(card) => handleAdd(card, "matrix_room")} />
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "px-3 py-2 text-sm font-medium transition-colors border-b-2 -mb-px " +
        (active
          ? "text-on-surface border-primary"
          : "text-on-surface-variant border-transparent hover:text-on-surface")
      }
    >
      {label}
    </button>
  );
}

/**
 * Camera-based QR scanner. Wires `getUserMedia` to a hidden canvas via
 * a `<video>` element, decodes each animation-frame with `jsQR`, and
 * fires `onDecoded` on the first successful decode + valid card.
 *
 * The decode loop self-cancels when the component unmounts (cleanup
 * fires on `cancelled = true`), and we explicitly stop all media tracks
 * — leaving the camera light on after the dialog closes would be a
 * visible bug.
 */
function CameraScan({
  onDecoded,
  error,
  setError,
}: {
  onDecoded: (card: PeerCard) => void;
  error: string | null;
  setError: (err: string | null) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    let rafId: number | null = null;

    const start = async () => {
      try {
        // Prefer the rear camera on devices that have one; falls back to
        // any video device elsewhere.
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        setActive(true);

        const scan = () => {
          if (cancelled) return;
          const v = videoRef.current;
          const canvas = canvasRef.current;
          if (!v || !canvas || v.readyState !== v.HAVE_ENOUGH_DATA) {
            rafId = requestAnimationFrame(scan);
            return;
          }
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx) {
            rafId = requestAnimationFrame(scan);
            return;
          }
          canvas.width = v.videoWidth;
          canvas.height = v.videoHeight;
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const result = jsQR(image.data, image.width, image.height, {
            inversionAttempts: "dontInvert",
          });
          if (result && result.data) {
            const decoded = decodeFromQrPayload(result.data);
            if (decoded.ok) {
              // Stop scanning before invoking the callback so the camera
              // light goes off immediately, even if the consumer's
              // handler takes a few ms to close the dialog.
              cancelled = true;
              if (stream) stream.getTracks().forEach((t) => t.stop());
              onDecoded(decoded.card);
              return;
            }
            // Decoded a QR but it wasn't a valid peer card — keep
            // scanning rather than spamming an error toast.
          }
          rafId = requestAnimationFrame(scan);
        };
        rafId = requestAnimationFrame(scan);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Couldn't open the camera",
          );
        }
      }
    };

    void start();

    return () => {
      cancelled = true;
      setActive(false);
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, [onDecoded, setError]);

  return (
    <div className="space-y-2">
      <div className="relative rounded-md overflow-hidden bg-black aspect-video">
        <video
          ref={videoRef}
          className="w-full h-full object-cover"
          playsInline
          muted
        />
        {!active && !error && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-on-surface-variant">
            Opening camera…
          </div>
        )}
      </div>
      <canvas ref={canvasRef} className="hidden" />
      {error && <p className="text-xs text-error">{error}</p>}
      <p className="text-xs text-on-surface-variant">
        Point at another Concord install's peer-card QR code.
      </p>
    </div>
  );
}

/**
 * Matrix-rooms tab content. Lists peer cards observed in any joined
 * room, newest first, with a click-to-pair affordance.
 */
function MatrixRoomList({
  onPick,
}: {
  onPick: (card: PeerCard) => void;
}) {
  const cards = useMatrixPeerCards();

  if (cards.length === 0) {
    return (
      <p className="text-xs text-on-surface-variant italic">
        No peer cards in your rooms yet. Ask the other person to post their
        card.
      </p>
    );
  }

  return (
    <ul className="space-y-1 max-h-60 overflow-y-auto">
      {cards.map((c) => (
        <li key={`${c.roomId}:${c.peerId}`}>
          <MatrixRoomCardRow card={c} onPick={onPick} />
        </li>
      ))}
    </ul>
  );
}

function MatrixRoomCardRow({
  card,
  onPick,
}: {
  card: RecentPeerCard;
  onPick: (card: PeerCard) => void;
}) {
  return (
    <button
      type="button"
      onClick={() =>
        onPick({
          peerId: card.peerId,
          publicKeyHex: card.publicKeyHex,
          multiaddrs: card.multiaddrs,
        })
      }
      className="w-full text-left p-2 rounded hover:bg-surface-container-high transition-colors"
    >
      <div className="flex flex-col gap-0.5">
        <span className="text-sm text-on-surface font-mono truncate">
          {card.peerId.slice(0, 12)}…
        </span>
        <span className="text-xs text-on-surface-variant truncate">
          from {card.roomName ?? card.roomId} · {card.sender}
        </span>
      </div>
    </button>
  );
}
