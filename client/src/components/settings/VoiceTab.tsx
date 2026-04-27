import { useState, useEffect, useRef, useCallback } from "react";
import { useSettingsStore } from "../../stores/settings";
import { Slider } from "../ui/Slider";
import {
  buildMicTrackConstraints,
  computeSignalLevelDb,
  INPUT_NOISE_GATE_DB_MAX,
  INPUT_NOISE_GATE_DB_MIN,
  normalizeSignalLevelDbToMeter,
} from "../../voice/noiseGate";

export function VoiceTab() {
  const masterInputVolume = useSettingsStore((s) => s.masterInputVolume);
  const setMasterInputVolume = useSettingsStore((s) => s.setMasterInputVolume);
  const preferredInputDeviceId = useSettingsStore(
    (s) => s.preferredInputDeviceId,
  );
  const setPreferredInputDeviceId = useSettingsStore(
    (s) => s.setPreferredInputDeviceId,
  );
  const echoCancellation = useSettingsStore((s) => s.echoCancellation);
  const setEchoCancellation = useSettingsStore((s) => s.setEchoCancellation);
  const noiseSuppression = useSettingsStore((s) => s.noiseSuppression);
  const setNoiseSuppression = useSettingsStore((s) => s.setNoiseSuppression);
  const autoGainControl = useSettingsStore((s) => s.autoGainControl);
  const setAutoGainControl = useSettingsStore((s) => s.setAutoGainControl);
  const inputNoiseGateEnabled = useSettingsStore((s) => s.inputNoiseGateEnabled);
  const setInputNoiseGateEnabled = useSettingsStore((s) => s.setInputNoiseGateEnabled);
  const inputNoiseGateThresholdDb = useSettingsStore((s) => s.inputNoiseGateThresholdDb);
  const setInputNoiseGateThresholdDb = useSettingsStore((s) => s.setInputNoiseGateThresholdDb);
  const voiceClarityEnabled = useSettingsStore((s) => s.voiceClarityEnabled);
  const setVoiceClarityEnabled = useSettingsStore((s) => s.setVoiceClarityEnabled);
  const voiceClarityStrength = useSettingsStore((s) => s.voiceClarityStrength);
  const setVoiceClarityStrength = useSettingsStore((s) => s.setVoiceClarityStrength);

  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [micLevel, setMicLevel] = useState(0);
  const [micLevelDb, setMicLevelDb] = useState(-72);
  // Mic test is OFF by default. Privacy: we never open the microphone unless
  // the user explicitly presses "Test microphone" — opening Settings → Voice
  // should not trigger a browser mic-in-use indicator. Auto-stops after 30s
  // as a safety net so a forgotten test session doesn't leak the mic.
  const [metering, setMetering] = useState(false);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number>(0);
  const autoStopRef = useRef<number | null>(null);

  // Centralized cleanup — release the mic stream, audio context, and any
  // pending RAF/timer. Safe to call multiple times.
  const releaseMic = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    if (autoStopRef.current !== null) {
      window.clearTimeout(autoStopRef.current);
      autoStopRef.current = null;
    }
    analyserRef.current = null;
    setMicLevel(0);
  }, []);

  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices().then((devices) => {
      setInputDevices(devices.filter((d) => d.kind === "audioinput"));
    });
  }, []);

  // Open the mic and run the level meter. Only invoked when `metering` is true.
  const startMeter = useCallback(async () => {
    releaseMic();
    try {
      if (!navigator.mediaDevices) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: buildMicTrackConstraints({
          masterInputVolume,
          preferredInputDeviceId,
          echoCancellation,
          noiseSuppression,
          autoGainControl,
          inputNoiseGateEnabled,
          inputNoiseGateThresholdDb,
        }),
      });
      streamRef.current = stream;
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      const data = new Float32Array(analyser.fftSize);
      const tick = () => {
        analyser.getFloatTimeDomainData(data);
        const levelDb = computeSignalLevelDb(data);
        setMicLevelDb(levelDb);
        setMicLevel(normalizeSignalLevelDbToMeter(levelDb));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();

      // Safety net: auto-stop after 30 seconds so a forgotten test never
      // leaks the mic indefinitely.
      autoStopRef.current = window.setTimeout(() => {
        setMetering(false);
      }, 30_000);
    } catch {
      setMetering(false);
    }
  }, [
    masterInputVolume,
    preferredInputDeviceId,
    echoCancellation,
    noiseSuppression,
    autoGainControl,
    inputNoiseGateEnabled,
    inputNoiseGateThresholdDb,
    releaseMic,
  ]);

  // Drive the mic stream off the `metering` flag. When metering flips on,
  // open the mic; when it flips off (user toggle, auto-stop, unmount,
  // device/settings change while running), release immediately.
  useEffect(() => {
    if (metering) {
      startMeter();
    } else {
      releaseMic();
    }
    return releaseMic;
  }, [metering, startMeter, releaseMic]);

  // Belt-and-suspenders: stop metering when the page is hidden. Prevents the
  // mic from staying open if the user backgrounds the tab mid-test.
  useEffect(() => {
    if (!metering) return;
    const onVisibility = () => {
      if (document.hidden) setMetering(false);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [metering]);

  return (
    <div className="space-y-6">
      <h3 className="text-xl font-semibold text-on-surface">Voice</h3>

      {/* Input Volume */}
      <Slider
        label="Input Volume"
        value={masterInputVolume}
        min={0}
        max={2}
        step={0.01}
        onChange={setMasterInputVolume}
        formatValue={(v) => `${Math.round(v * 100)}%`}
      />

      {/* Input Device */}
      {inputDevices.length > 0 && (
        <div>
          <label className="block text-sm text-on-surface mb-1.5">
            Input Device
          </label>
          <select
            value={preferredInputDeviceId ?? ""}
            onChange={(e) =>
              setPreferredInputDeviceId(e.target.value || null)
            }
            className="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded-md text-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-primary/30 cursor-pointer"
          >
            <option value="">Default</option>
            {inputDevices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Mic ${d.deviceId.slice(0, 8)}`}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Mic level meter — gated behind an explicit Test button so opening
          this tab does not trigger a browser mic-in-use indicator. */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="block text-sm text-on-surface">Mic Level</label>
          <button
            type="button"
            onClick={() => setMetering((m) => !m)}
            className={`text-xs font-label px-3 py-1 rounded-full transition-colors min-h-[32px] ${
              metering
                ? "bg-primary text-on-primary"
                : "bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest"
            }`}
            aria-pressed={metering}
          >
            {metering ? "Stop test" : "Test microphone"}
          </button>
        </div>
        <div className="relative h-2 bg-surface-container-highest rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-75"
            style={{
              width: metering ? `${micLevel * 100}%` : "0%",
              backgroundColor:
                micLevel > 0.8
                  ? "#ef4444"
                  : micLevel > 0.5
                    ? "#eab308"
                    : "#22c55e",
            }}
          />
          {inputNoiseGateEnabled && (
            <div
              className="absolute top-0 bottom-0 w-px bg-primary/80"
              style={{
                left: `${normalizeSignalLevelDbToMeter(inputNoiseGateThresholdDb) * 100}%`,
              }}
            />
          )}
        </div>
        <p className="text-xs text-on-surface-variant mt-1.5">
          {metering
            ? `Mic is open — ${Math.round(micLevelDb)} dB. Auto-stops after 30 seconds.`
            : "Tap Test microphone to verify your input. Mic stays off otherwise."}
        </p>
      </div>

      {/* Processing toggles */}
      <div className="border-t border-outline-variant/15 pt-6 space-y-4">
        <h4 className="text-sm font-medium text-on-surface">Voice Processing</h4>

        <Toggle
          label="Echo Cancellation"
          description="Prevents your speakers from feeding back into your mic"
          checked={echoCancellation}
          onChange={setEchoCancellation}
        />
        <Toggle
          label="Noise Suppression"
          description="Reduces background noise like fans or keyboard clicks"
          checked={noiseSuppression}
          onChange={setNoiseSuppression}
        />
        <Toggle
          label="Auto Gain Control"
          description="Automatically adjusts mic sensitivity to maintain consistent level"
          checked={autoGainControl}
          onChange={setAutoGainControl}
        />
        <Toggle
          label="Speech Gate"
          description="Suppresses mic audio below the selected dB threshold to reduce speaker bleed and room noise"
          checked={inputNoiseGateEnabled}
          onChange={setInputNoiseGateEnabled}
        />
        <Slider
          label="Speech Gate Threshold"
          value={inputNoiseGateThresholdDb}
          min={INPUT_NOISE_GATE_DB_MIN}
          max={INPUT_NOISE_GATE_DB_MAX}
          step={1}
          onChange={setInputNoiseGateThresholdDb}
          formatValue={(v) => `${Math.round(v)} dB`}
        />
        <p className="text-xs text-on-surface-variant -mt-2">
          Louder thresholds block more speaker bleed. Quieter thresholds let more soft speech through.
        </p>

        <Toggle
          label="Voice Clarity"
          description="Lifts vocal presence (~3 kHz), softens harsh sibilance (~7 kHz), expands the dynamic range of speech so quiet syllables stay audible without loud peaks blowing out"
          checked={voiceClarityEnabled}
          onChange={setVoiceClarityEnabled}
        />
        {voiceClarityEnabled && (
          <Slider
            label="Voice Clarity Strength"
            value={voiceClarityStrength}
            min={0}
            max={1}
            step={0.05}
            onChange={setVoiceClarityStrength}
            formatValue={(v) => `${Math.round(v * 100)}%`}
          />
        )}
      </div>
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm text-on-surface">{label}</p>
        <p className="text-xs text-on-surface-variant">{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ml-4 ${
          checked ? "bg-primary" : "bg-surface-bright"
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
            checked ? "translate-x-5" : ""
          }`}
        />
      </button>
    </div>
  );
}
