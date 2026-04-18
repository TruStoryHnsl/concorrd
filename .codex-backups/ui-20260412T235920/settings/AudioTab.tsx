import { useState, useEffect } from "react";
import { useSettingsStore } from "../../stores/settings";
import { Slider } from "../ui/Slider";

export function AudioTab() {
  const masterOutputVolume = useSettingsStore((s) => s.masterOutputVolume);
  const setMasterOutputVolume = useSettingsStore(
    (s) => s.setMasterOutputVolume,
  );
  const preferredOutputDeviceId = useSettingsStore(
    (s) => s.preferredOutputDeviceId,
  );
  const setPreferredOutputDeviceId = useSettingsStore(
    (s) => s.setPreferredOutputDeviceId,
  );
  const normalizationEnabled = useSettingsStore((s) => s.normalizationEnabled);
  const setNormalizationEnabled = useSettingsStore(
    (s) => s.setNormalizationEnabled,
  );
  const compressorThreshold = useSettingsStore((s) => s.compressorThreshold);
  const compressorKnee = useSettingsStore((s) => s.compressorKnee);
  const compressorRatio = useSettingsStore((s) => s.compressorRatio);
  const compressorAttack = useSettingsStore((s) => s.compressorAttack);
  const compressorRelease = useSettingsStore((s) => s.compressorRelease);
  const makeupGain = useSettingsStore((s) => s.makeupGain);
  const setCompressorParam = useSettingsStore((s) => s.setCompressorParam);

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices().then((devices) => {
      setOutputDevices(devices.filter((d) => d.kind === "audiooutput"));
    });
  }, []);

  return (
    <div className="space-y-6">
      <h3 className="text-xl font-semibold text-on-surface">Audio</h3>

      {/* Output Volume */}
      <Slider
        label="Output Volume"
        value={masterOutputVolume}
        min={0}
        max={2}
        step={0.01}
        onChange={setMasterOutputVolume}
        formatValue={(v) => `${Math.round(v * 100)}%`}
      />

      {/* Output Device */}
      {outputDevices.length > 0 && (
        <div>
          <label className="block text-sm text-on-surface mb-1.5">
            Output Device
          </label>
          <select
            value={preferredOutputDeviceId ?? ""}
            onChange={(e) =>
              setPreferredOutputDeviceId(e.target.value || null)
            }
            className="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded-md text-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-primary/30 cursor-pointer"
          >
            <option value="">Default</option>
            {outputDevices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Speaker ${d.deviceId.slice(0, 8)}`}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Normalization */}
      <div className="border-t border-outline-variant/15 pt-6">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h4 className="text-sm font-medium text-on-surface">
              Audio Normalization
            </h4>
            <p className="text-xs text-on-surface-variant mt-0.5">
              Compresses dynamic range so loud and quiet speakers sound more
              even
            </p>
          </div>
          <button
            role="switch"
            aria-checked={normalizationEnabled}
            onClick={() => setNormalizationEnabled(!normalizationEnabled)}
            className={`relative w-10 h-5 rounded-full transition-colors ${
              normalizationEnabled ? "bg-primary" : "bg-surface-bright"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                normalizationEnabled ? "translate-x-5" : ""
              }`}
            />
          </button>
        </div>

        {/* Advanced compressor params */}
        {normalizationEnabled && (
          <div>
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="text-xs text-on-surface-variant hover:text-on-surface transition-colors"
            >
              {showAdvanced ? "Hide" : "Show"} Advanced
            </button>

            {showAdvanced && (
              <div className="mt-3 space-y-3 pl-1">
                <Slider
                  label="Threshold"
                  value={compressorThreshold}
                  min={-60}
                  max={0}
                  step={1}
                  onChange={(v) =>
                    setCompressorParam("compressorThreshold", v)
                  }
                  formatValue={(v) => `${v} dB`}
                />
                <Slider
                  label="Knee"
                  value={compressorKnee}
                  min={0}
                  max={40}
                  step={1}
                  onChange={(v) => setCompressorParam("compressorKnee", v)}
                  formatValue={(v) => `${v} dB`}
                />
                <Slider
                  label="Ratio"
                  value={compressorRatio}
                  min={1}
                  max={20}
                  step={0.5}
                  onChange={(v) => setCompressorParam("compressorRatio", v)}
                  formatValue={(v) => `${v}:1`}
                />
                <Slider
                  label="Attack"
                  value={compressorAttack}
                  min={0}
                  max={0.1}
                  step={0.001}
                  onChange={(v) =>
                    setCompressorParam("compressorAttack", v)
                  }
                  formatValue={(v) => `${(v * 1000).toFixed(0)} ms`}
                />
                <Slider
                  label="Release"
                  value={compressorRelease}
                  min={0.01}
                  max={1}
                  step={0.01}
                  onChange={(v) =>
                    setCompressorParam("compressorRelease", v)
                  }
                  formatValue={(v) => `${(v * 1000).toFixed(0)} ms`}
                />
                <Slider
                  label="Makeup Gain"
                  value={makeupGain}
                  min={0.5}
                  max={4}
                  step={0.1}
                  onChange={(v) => setCompressorParam("makeupGain", v)}
                  formatValue={(v) => `${v.toFixed(1)}x`}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
