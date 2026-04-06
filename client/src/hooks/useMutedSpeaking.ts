import { useEffect, useRef, useState } from "react";

/**
 * Monitors the local microphone while the user is muted in LiveKit.
 * Returns true when the user is speaking into a muted mic — used to
 * show a "you're muted" visual reminder on their own tile.
 *
 * Opens a separate getUserMedia stream (LiveKit's track produces silence
 * when disabled, so we can't re-use it for level analysis).
 */
export function useMutedSpeaking(
  isMicEnabled: boolean,
  preferredDeviceId?: string,
): boolean {
  const [speaking, setSpeaking] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (isMicEnabled) {
      setSpeaking(false);
      cleanupRef.current?.();
      cleanupRef.current = null;
      return;
    }

    let cancelled = false;

    async function start() {
      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: preferredDeviceId
            ? { deviceId: { ideal: preferredDeviceId } }
            : true,
        });

        // Bail-out checkpoint #1: cleanup may have run while getUserMedia
        // was in flight. Release the freshly-acquired stream and exit.
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        const ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.5;
        source.connect(analyser);

        const data = new Uint8Array(analyser.frequencyBinCount);
        const THRESHOLD = 15;

        const interval = setInterval(() => {
          analyser.getByteFrequencyData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) sum += data[i];
          const avg = sum / data.length;
          setSpeaking(avg > THRESHOLD);
        }, 100);

        const fullCleanup = () => {
          clearInterval(interval);
          try { source.disconnect(); } catch {}
          ctx.close().catch(() => {});
          stream?.getTracks().forEach((t) => t.stop());
          setSpeaking(false);
        };

        // Bail-out checkpoint #2: between acquiring the stream and
        // assigning cleanupRef, the outer cleanup may have run with a
        // null cleanupRef and then walked away. The race window is small
        // but real (cleanup runs after `cancelled = true` but before we
        // got here). Detect it and immediately tear down everything we
        // just built — otherwise the stream would leak indefinitely
        // because nothing else holds a reference to it.
        if (cancelled) {
          fullCleanup();
          return;
        }

        cleanupRef.current = fullCleanup;
      } catch {
        // Mic not available — no monitoring. Defensive: release the
        // stream if it was acquired before the catch fired.
        stream?.getTracks().forEach((t) => t.stop());
      }
    }

    start();

    return () => {
      cancelled = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [isMicEnabled, preferredDeviceId]);

  return speaking;
}
