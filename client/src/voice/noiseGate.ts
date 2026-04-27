import type { AudioCaptureOptions } from "livekit-client";
import { Track } from "livekit-client";
import type { AudioProcessorOptions, TrackProcessor } from "livekit-client";

export const INPUT_NOISE_GATE_DB_MIN = -72;
export const INPUT_NOISE_GATE_DB_MAX = -18;
export const INPUT_NOISE_GATE_DB_DEFAULT = -42;
export const INPUT_NOISE_GATE_HYSTERESIS_DB = 6;
export const INPUT_NOISE_GATE_HOLD_MS = 220;
export const INPUT_NOISE_GATE_ATTACK_SECONDS = 0.015;
export const INPUT_NOISE_GATE_RELEASE_SECONDS = 0.14;
export const INPUT_SIGNAL_METER_FLOOR_DB = -72;
export const INPUT_SIGNAL_METER_CEIL_DB = -6;
const SILENCE_FLOOR_DB = -100;
type VoiceIsolationConstraints = MediaTrackConstraints & {
  voiceIsolation?: ConstrainBoolean;
};
type VoiceIsolationSupportedConstraints = MediaTrackSupportedConstraints & {
  voiceIsolation?: boolean;
};

export interface VoiceInputSettings {
  masterInputVolume: number;
  preferredInputDeviceId: string | null;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  inputNoiseGateEnabled: boolean;
  inputNoiseGateThresholdDb: number;
  voiceClarityEnabled?: boolean;
  voiceClarityStrength?: number;
}

export function computeSignalLevelDb(samples: ArrayLike<number>): number {
  const count = samples.length;
  if (!count) return SILENCE_FLOOR_DB;
  let sumSquares = 0;
  for (let i = 0; i < count; i += 1) {
    const value = Number(samples[i]) || 0;
    sumSquares += value * value;
  }
  const rms = Math.sqrt(sumSquares / count);
  if (!Number.isFinite(rms) || rms <= 0) return SILENCE_FLOOR_DB;
  return Math.max(SILENCE_FLOOR_DB, 20 * Math.log10(rms));
}

export function normalizeSignalLevelDbToMeter(
  levelDb: number,
  floorDb = INPUT_SIGNAL_METER_FLOOR_DB,
  ceilDb = INPUT_SIGNAL_METER_CEIL_DB,
): number {
  if (!Number.isFinite(levelDb)) return 0;
  if (levelDb <= floorDb) return 0;
  if (levelDb >= ceilDb) return 1;
  return (levelDb - floorDb) / (ceilDb - floorDb);
}

export function resolveNoiseGateOpenState({
  levelDb,
  thresholdDb,
  wasOpen,
  nowMs,
  heldUntilMs,
  hysteresisDb = INPUT_NOISE_GATE_HYSTERESIS_DB,
}: {
  levelDb: number;
  thresholdDb: number;
  wasOpen: boolean;
  nowMs: number;
  heldUntilMs: number;
  hysteresisDb?: number;
}): boolean {
  if (levelDb >= thresholdDb) return true;
  if (wasOpen && levelDb >= thresholdDb - hysteresisDb) return true;
  return nowMs < heldUntilMs;
}

export function buildMicTrackConstraints(
  settings: VoiceInputSettings,
): MediaTrackConstraints {
  const constraints: VoiceIsolationConstraints = {
    echoCancellation: settings.echoCancellation,
    noiseSuppression: settings.noiseSuppression,
    autoGainControl: settings.autoGainControl,
    ...(settings.preferredInputDeviceId
      ? { deviceId: { ideal: settings.preferredInputDeviceId } }
      : {}),
  };

  const supported =
    typeof navigator !== "undefined" &&
    navigator.mediaDevices?.getSupportedConstraints
      ? (navigator.mediaDevices.getSupportedConstraints() as VoiceIsolationSupportedConstraints)
      : null;

  if (supported?.voiceIsolation && settings.noiseSuppression) {
    constraints.voiceIsolation = true;
  }

  return constraints;
}

class ConcordNoiseGateProcessor
  implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>
{
  public readonly name = "concord-noise-gate";
  public processedTrack?: MediaStreamTrack;

  private settings: VoiceInputSettings;
  private audioContext?: AudioContext;
  private sourceNode?: MediaStreamAudioSourceNode;
  private highpassFilter?: BiquadFilterNode;
  // Voice-clarity chain. Inserted between the highpass and the
  // outputGain when ``voiceClarityEnabled`` is true. The chain is built
  // unconditionally so live toggles can route around it without
  // tearing down the whole graph; ``voiceClarityBypassed`` controls the
  // active path.
  private clarityNotch?: BiquadFilterNode;        // 60 Hz notch (mains hum)
  private clarityPresence?: BiquadFilterNode;     // ~3 kHz peak boost
  private claritySibilance?: BiquadFilterNode;    // ~7 kHz peak cut
  private clarityCompressor?: DynamicsCompressorNode;
  private clarityMakeupGain?: GainNode;
  private clarityBypassed = true;
  private analyserNode?: AnalyserNode;
  private outputGainNode?: GainNode;
  private gateGainNode?: GainNode;
  private destinationNode?: MediaStreamAudioDestinationNode;
  private monitorTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private gateOpen = false;
  private heldUntilMs = 0;
  private ownsProcessedTrack = false;

  constructor(settings: VoiceInputSettings) {
    this.settings = { ...settings };
  }

  updateSettings(settings: VoiceInputSettings): void {
    const prev = this.settings;
    this.settings = { ...settings };
    if (this.outputGainNode) {
      this.outputGainNode.gain.value = settings.masterInputVolume;
    }
    if (this.gateGainNode && !settings.inputNoiseGateEnabled) {
      this.gateOpen = true;
      this.heldUntilMs = 0;
      this.rampGate(true);
    }
    // Live re-route when voice-clarity is toggled. Strength changes
    // tune the existing nodes in place; on/off changes flip the
    // active connection between the dry path and the clarity chain.
    const clarityNowOn =
      settings.voiceClarityEnabled !== false; // default ON when undefined
    const clarityWasOn = prev.voiceClarityEnabled !== false;
    if (clarityNowOn) {
      this.tuneClarityNodes(settings.voiceClarityStrength ?? 0.5);
    }
    if (clarityNowOn !== clarityWasOn) {
      this.routeClarity(clarityNowOn);
    }
  }

  async init(opts: AudioProcessorOptions): Promise<void> {
    await this.restart(opts);
  }

  async restart(opts: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    this.audioContext = opts.audioContext;
    this.gateOpen = !this.settings.inputNoiseGateEnabled;
    this.heldUntilMs = 0;

    try {
      const sourceStream = new MediaStream([opts.track]);
      this.sourceNode = opts.audioContext.createMediaStreamSource(sourceStream);

      this.highpassFilter = opts.audioContext.createBiquadFilter();
      this.highpassFilter.type = "highpass";
      this.highpassFilter.frequency.value = 115;
      this.highpassFilter.Q.value = 0.7;

      // Voice-clarity nodes: notch → presence boost → sibilance cut →
      // compressor → makeup gain. All built unconditionally; the
      // ``routeClarity`` call below decides whether the dry highpass
      // path or this chain feeds outputGain.
      this.clarityNotch = opts.audioContext.createBiquadFilter();
      this.clarityNotch.type = "notch";
      this.clarityNotch.frequency.value = 60;
      this.clarityNotch.Q.value = 8;

      this.clarityPresence = opts.audioContext.createBiquadFilter();
      this.clarityPresence.type = "peaking";
      this.clarityPresence.frequency.value = 3000;
      this.clarityPresence.Q.value = 1.0;

      this.claritySibilance = opts.audioContext.createBiquadFilter();
      this.claritySibilance.type = "peaking";
      this.claritySibilance.frequency.value = 7000;
      this.claritySibilance.Q.value = 1.2;

      // Gentle compressor with makeup gain — expands perceived dynamic
      // range of speech. Quiet syllables come up, loud peaks stay
      // controlled. Strength scales the ratio + makeup, so a single
      // slider drives intensity.
      this.clarityCompressor = opts.audioContext.createDynamicsCompressor();
      this.clarityCompressor.attack.value = 0.005;
      this.clarityCompressor.release.value = 0.18;
      this.clarityCompressor.knee.value = 12;

      this.clarityMakeupGain = opts.audioContext.createGain();

      this.tuneClarityNodes(this.settings.voiceClarityStrength ?? 0.5);

      this.analyserNode = opts.audioContext.createAnalyser();
      this.analyserNode.fftSize = 1024;
      this.analyserNode.smoothingTimeConstant = 0.18;

      this.outputGainNode = opts.audioContext.createGain();
      this.outputGainNode.gain.value = this.settings.masterInputVolume;

      this.gateGainNode = opts.audioContext.createGain();
      this.gateGainNode.gain.value = this.gateOpen ? 1 : 0;

      this.destinationNode = opts.audioContext.createMediaStreamDestination();

      // Static wiring: source → highpass → analyser, and the clarity
      // chain links itself end-to-end. ``routeClarity`` connects EITHER
      // the dry highpass OR the clarity tail to outputGain depending on
      // the setting.
      this.sourceNode.connect(this.highpassFilter);
      this.highpassFilter.connect(this.analyserNode);

      this.clarityNotch.connect(this.clarityPresence);
      this.clarityPresence.connect(this.claritySibilance);
      this.claritySibilance.connect(this.clarityCompressor);
      this.clarityCompressor.connect(this.clarityMakeupGain);

      this.outputGainNode.connect(this.gateGainNode);
      this.gateGainNode.connect(this.destinationNode);

      this.routeClarity(this.settings.voiceClarityEnabled !== false);

      const outputTrack = this.destinationNode.stream.getAudioTracks()[0];
      if (outputTrack) {
        this.processedTrack = outputTrack;
        this.ownsProcessedTrack = true;
      } else {
        this.processedTrack = opts.track;
        this.ownsProcessedTrack = false;
      }

      this.startMonitoring();
    } catch {
      this.processedTrack = opts.track;
      this.ownsProcessedTrack = false;
    }
  }

  async destroy(): Promise<void> {
    if (this.monitorTimer !== null) {
      globalThis.clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    const safeDisconnect = (node: AudioNode | undefined) => {
      try {
        node?.disconnect();
      } catch {}
    };
    safeDisconnect(this.sourceNode);
    safeDisconnect(this.highpassFilter);
    safeDisconnect(this.clarityNotch);
    safeDisconnect(this.clarityPresence);
    safeDisconnect(this.claritySibilance);
    safeDisconnect(this.clarityCompressor);
    safeDisconnect(this.clarityMakeupGain);
    safeDisconnect(this.analyserNode);
    safeDisconnect(this.outputGainNode);
    safeDisconnect(this.gateGainNode);
    safeDisconnect(this.destinationNode);
    if (this.ownsProcessedTrack) {
      this.processedTrack?.stop();
    }
    this.sourceNode = undefined;
    this.highpassFilter = undefined;
    this.clarityNotch = undefined;
    this.clarityPresence = undefined;
    this.claritySibilance = undefined;
    this.clarityCompressor = undefined;
    this.clarityMakeupGain = undefined;
    this.analyserNode = undefined;
    this.outputGainNode = undefined;
    this.gateGainNode = undefined;
    this.destinationNode = undefined;
    this.processedTrack = undefined;
    this.ownsProcessedTrack = false;
    this.clarityBypassed = true;
  }

  /**
   * Scale presence boost, sibilance cut, compressor ratio, and makeup
   * gain by ``strength`` ∈ [0, 1]. At strength=0 every parameter is
   * neutral (flat passthrough); at strength=1 the chain produces a
   * broadcast-style "voice clarity" sound.
   */
  private tuneClarityNodes(strength: number): void {
    const s = Math.max(0, Math.min(1, strength));
    if (this.clarityPresence) this.clarityPresence.gain.value = 4 * s;
    if (this.claritySibilance) this.claritySibilance.gain.value = -3 * s;
    if (this.clarityCompressor) {
      // Threshold drops as strength rises so quiet syllables enter the
      // compressor sooner; ratio rises so dynamic range tightens.
      this.clarityCompressor.threshold.value = -18 - 12 * s;
      this.clarityCompressor.ratio.value = 1 + 4 * s;
    }
    if (this.clarityMakeupGain) {
      // ~+3 dB at strength=0.5, ~+6 dB at strength=1.
      this.clarityMakeupGain.gain.value = Math.pow(10, (6 * s) / 20);
    }
  }

  /**
   * Route the active path between dry highpass → outputGain (bypass)
   * or highpass → clarity chain → outputGain (engaged). Disconnects
   * the previous tail before reconnecting so the live AudioContext
   * doesn't end up with both paths summed.
   */
  private routeClarity(engaged: boolean): void {
    if (
      !this.highpassFilter ||
      !this.outputGainNode ||
      !this.clarityNotch ||
      !this.clarityMakeupGain
    ) {
      return;
    }
    if (engaged === !this.clarityBypassed) return;
    try {
      this.highpassFilter.disconnect(this.outputGainNode);
    } catch {}
    try {
      this.clarityMakeupGain.disconnect(this.outputGainNode);
    } catch {}
    try {
      this.highpassFilter.disconnect(this.clarityNotch);
    } catch {}
    if (engaged) {
      this.highpassFilter.connect(this.clarityNotch);
      this.clarityMakeupGain.connect(this.outputGainNode);
      this.clarityBypassed = false;
    } else {
      this.highpassFilter.connect(this.outputGainNode);
      this.clarityBypassed = true;
    }
  }

  private startMonitoring(): void {
    if (!this.analyserNode || !this.gateGainNode) return;
    const samples = new Float32Array(this.analyserNode.fftSize);
    this.monitorTimer = globalThis.setInterval(() => {
      if (!this.analyserNode) return;
      this.analyserNode.getFloatTimeDomainData(samples);
      if (!this.settings.inputNoiseGateEnabled) {
        if (!this.gateOpen) {
          this.gateOpen = true;
          this.rampGate(true);
        }
        return;
      }

      const levelDb = computeSignalLevelDb(samples);
      const nowMs =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      if (levelDb >= this.settings.inputNoiseGateThresholdDb) {
        this.heldUntilMs = nowMs + INPUT_NOISE_GATE_HOLD_MS;
      }

      const shouldOpen = resolveNoiseGateOpenState({
        levelDb,
        thresholdDb: this.settings.inputNoiseGateThresholdDb,
        wasOpen: this.gateOpen,
        nowMs,
        heldUntilMs: this.heldUntilMs,
      });

      if (shouldOpen !== this.gateOpen) {
        this.gateOpen = shouldOpen;
        this.rampGate(shouldOpen);
      }
    }, 40);
  }

  private rampGate(open: boolean): void {
    if (!this.gateGainNode || !this.audioContext) return;
    const now = this.audioContext.currentTime;
    const gain = this.gateGainNode.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(
      open ? 1 : 0,
      now + (open ? INPUT_NOISE_GATE_ATTACK_SECONDS : INPUT_NOISE_GATE_RELEASE_SECONDS),
    );
  }
}

let sharedProcessor: ConcordNoiseGateProcessor | null = null;

export function getVoiceInputProcessor(
  settings: VoiceInputSettings,
): ConcordNoiseGateProcessor {
  if (!sharedProcessor) {
    sharedProcessor = new ConcordNoiseGateProcessor(settings);
  } else {
    sharedProcessor.updateSettings(settings);
  }
  return sharedProcessor;
}

export function resetVoiceInputProcessorForTests(): void {
  if (sharedProcessor) {
    void sharedProcessor.destroy();
  }
  sharedProcessor = null;
}

export function buildLiveKitAudioCaptureOptions(
  settings: VoiceInputSettings,
): AudioCaptureOptions {
  // IMPORTANT: no ``processor`` key here. Passing one via capture options
  // triggers LiveKit's ``createLocalTracks`` → internal ``setProcessor``
  // call, which requires ``LocalAudioTrack.audioContext`` to be set.
  // But LiveKit's Room only calls ``track.setAudioContext(...)`` AFTER
  // ``createLocalTracks`` returns (see Room.mergedOptionsWithProcessors in
  // livekit-client.esm.mjs), so the context attachment lands too late and
  // the ``setProcessor`` throws
  // ``Audio context needs to be set on LocalAudioTrack``. That cascades
  // into ``onError → voiceDisconnect → "Client initiated disconnect"``
  // — the three-toast pileup the user has reported.
  //
  // The processor is instead attached post-publish by the useEffect in
  // ``VoiceChannel.tsx``, which guards on ``micTrack.audioContext`` and
  // is invoked only once the track has been fully set up inside the
  // room. That guard is the single source of truth for "is it safe to
  // enable processors on this track" — don't add the processor back
  // here without removing the guard there first.
  return buildMicTrackConstraints(settings);
}
