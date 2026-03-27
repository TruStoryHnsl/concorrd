//! Audio capture, playback, and Opus codec integration.
//!
//! Uses `cpal` for cross-platform audio I/O and `audiopus` for Opus encoding/decoding.
//! Audio is captured at 48kHz mono (Opus native rate), encoded into frames,
//! and sent to the voice engine for transmission.

use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use tracing::{debug, error, info, warn};

/// Opus frame size in samples at 48kHz (20ms frames).
const OPUS_FRAME_SIZE: usize = 960;
/// Sample rate for Opus encoding.
const SAMPLE_RATE: u32 = 48000;
/// Number of channels (mono).
const CHANNELS: u16 = 1;

/// Errors from audio operations.
#[derive(Debug, thiserror::Error)]
pub enum AudioError {
    #[error("no audio input device available")]
    NoInputDevice,
    #[error("no audio output device available")]
    NoOutputDevice,
    #[error("audio device error: {0}")]
    DeviceError(String),
    #[error("opus encoder error: {0}")]
    OpusEncodeError(String),
    #[error("opus decoder error: {0}")]
    OpusDecodeError(String),
    #[error("stream error: {0}")]
    StreamError(String),
}

/// Encoded audio frame ready for network transmission.
#[derive(Debug, Clone)]
pub struct AudioFrame {
    pub data: Vec<u8>,
    pub timestamp: u64,
    pub sequence: u32,
}

/// Manages audio capture from the microphone.
pub struct AudioCapture {
    stream: Option<cpal::Stream>,
    is_muted: Arc<Mutex<bool>>,
}

impl AudioCapture {
    /// Create a new audio capture that sends encoded Opus frames to the provided channel.
    pub fn new(frame_tx: mpsc::Sender<AudioFrame>) -> Result<Self, AudioError> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or(AudioError::NoInputDevice)?;

        info!(device = device.description().map(|d| d.name().to_string()).unwrap_or_default(), "audio: using input device");

        let config = cpal::StreamConfig {
            channels: CHANNELS,
            sample_rate: SAMPLE_RATE,
            buffer_size: cpal::BufferSize::Default,
        };

        let is_muted = Arc::new(Mutex::new(false));
        let mute_flag = Arc::clone(&is_muted);

        // Opus encoder — 48kHz mono, voice-optimized
        let encoder = audiopus::coder::Encoder::new(
            audiopus::SampleRate::Hz48000,
            audiopus::Channels::Mono,
            audiopus::Application::Voip,
        )
        .map_err(|e| AudioError::OpusEncodeError(e.to_string()))?;

        let encoder = Arc::new(Mutex::new(encoder));
        let sample_buffer = Arc::new(Mutex::new(Vec::<f32>::with_capacity(OPUS_FRAME_SIZE * 2)));
        let sequence = Arc::new(Mutex::new(0u32));

        let enc = Arc::clone(&encoder);
        let buf = Arc::clone(&sample_buffer);
        let seq = Arc::clone(&sequence);

        let stream = device
            .build_input_stream(
                &config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    // Check mute
                    if *mute_flag.lock().unwrap() {
                        return;
                    }

                    let mut buffer = buf.lock().unwrap();
                    buffer.extend_from_slice(data);

                    // Process complete Opus frames
                    while buffer.len() >= OPUS_FRAME_SIZE {
                        let frame_samples: Vec<f32> =
                            buffer.drain(..OPUS_FRAME_SIZE).collect();

                        // Convert f32 samples to i16 for Opus
                        let pcm: Vec<i16> = frame_samples
                            .iter()
                            .map(|&s| (s * 32767.0).clamp(-32768.0, 32767.0) as i16)
                            .collect();

                        // Encode with Opus
                        let mut output = vec![0u8; 4000]; // max Opus frame
                        let enc = enc.lock().unwrap();
                        match enc.encode(&pcm, &mut output) {
                            Ok(len) => {
                                output.truncate(len);
                                let mut seq_num = seq.lock().unwrap();
                                *seq_num = seq_num.wrapping_add(1);
                                let frame = AudioFrame {
                                    data: output,
                                    timestamp: std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .unwrap_or_default()
                                        .as_millis() as u64,
                                    sequence: *seq_num,
                                };
                                let _ = frame_tx.send(frame);
                            }
                            Err(e) => {
                                warn!("opus encode error: {}", e);
                            }
                        }
                    }
                },
                |err| {
                    error!("audio input stream error: {}", err);
                },
                None,
            )
            .map_err(|e| AudioError::StreamError(e.to_string()))?;

        Ok(Self {
            stream: Some(stream),
            is_muted,
        })
    }

    /// Start capturing audio.
    pub fn start(&self) -> Result<(), AudioError> {
        if let Some(stream) = &self.stream {
            stream
                .play()
                .map_err(|e| AudioError::StreamError(e.to_string()))?;
            info!("audio: capture started");
        }
        Ok(())
    }

    /// Stop capturing audio.
    pub fn stop(&self) -> Result<(), AudioError> {
        if let Some(stream) = &self.stream {
            stream
                .pause()
                .map_err(|e| AudioError::StreamError(e.to_string()))?;
            info!("audio: capture stopped");
        }
        Ok(())
    }

    /// Set the mute state.
    pub fn set_muted(&self, muted: bool) {
        if let Ok(mut m) = self.is_muted.lock() {
            *m = muted;
        }
    }
}

/// Manages audio playback to speakers/headphones.
pub struct AudioPlayback {
    stream: Option<cpal::Stream>,
    decoder: Arc<Mutex<audiopus::coder::Decoder>>,
    /// Ring buffer for decoded PCM samples waiting to be played.
    playback_buffer: Arc<Mutex<Vec<f32>>>,
}

impl AudioPlayback {
    /// Create a new audio playback instance.
    pub fn new() -> Result<Self, AudioError> {
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or(AudioError::NoOutputDevice)?;

        info!(device = device.description().map(|d| d.name().to_string()).unwrap_or_default(), "audio: using output device");

        let config = cpal::StreamConfig {
            channels: CHANNELS,
            sample_rate: SAMPLE_RATE,
            buffer_size: cpal::BufferSize::Default,
        };

        let decoder = audiopus::coder::Decoder::new(
            audiopus::SampleRate::Hz48000,
            audiopus::Channels::Mono,
        )
        .map_err(|e| AudioError::OpusDecodeError(e.to_string()))?;
        let decoder = Arc::new(Mutex::new(decoder));

        let playback_buffer = Arc::new(Mutex::new(Vec::<f32>::with_capacity(OPUS_FRAME_SIZE * 10)));
        let buf = Arc::clone(&playback_buffer);

        let stream = device
            .build_output_stream(
                &config,
                move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                    let mut buffer = buf.lock().unwrap();
                    for sample in data.iter_mut() {
                        *sample = if buffer.is_empty() {
                            0.0 // silence when no audio available
                        } else {
                            buffer.remove(0)
                        };
                    }
                },
                |err| {
                    error!("audio output stream error: {}", err);
                },
                None,
            )
            .map_err(|e| AudioError::StreamError(e.to_string()))?;

        Ok(Self {
            stream: Some(stream),
            decoder,
            playback_buffer,
        })
    }

    /// Start playing audio.
    pub fn start(&self) -> Result<(), AudioError> {
        if let Some(stream) = &self.stream {
            stream
                .play()
                .map_err(|e| AudioError::StreamError(e.to_string()))?;
            info!("audio: playback started");
        }
        Ok(())
    }

    /// Stop playing audio.
    pub fn stop(&self) -> Result<(), AudioError> {
        if let Some(stream) = &self.stream {
            stream
                .pause()
                .map_err(|e| AudioError::StreamError(e.to_string()))?;
            info!("audio: playback stopped");
        }
        Ok(())
    }

    /// Decode and queue an incoming Opus audio frame for playback.
    pub fn queue_frame(&self, opus_data: &[u8]) -> Result<(), AudioError> {
        let mut decoder = self.decoder.lock().unwrap();
        let mut pcm = vec![0i16; OPUS_FRAME_SIZE];
        let packet = audiopus::packet::Packet::try_from(opus_data)
            .map_err(|e| AudioError::OpusDecodeError(e.to_string()))?;
        let mut signals = audiopus::MutSignals::try_from(&mut pcm[..])
            .map_err(|e| AudioError::OpusDecodeError(e.to_string()))?;
        let decoded_samples = decoder
            .decode(Some(packet), signals, false)
            .map_err(|e| AudioError::OpusDecodeError(e.to_string()))?;

        // Convert i16 to f32
        let float_samples: Vec<f32> = pcm[..decoded_samples]
            .iter()
            .map(|&s| s as f32 / 32767.0)
            .collect();

        let mut buffer = self.playback_buffer.lock().unwrap();
        buffer.extend(float_samples);

        // Prevent buffer from growing unboundedly (keep ~200ms max)
        let max_samples = OPUS_FRAME_SIZE * 10;
        if buffer.len() > max_samples {
            let excess = buffer.len() - max_samples;
            buffer.drain(..excess);
        }

        Ok(())
    }
}

/// Check if audio devices are available on this system.
pub fn has_audio_devices() -> (bool, bool) {
    let host = cpal::default_host();
    let has_input = host.default_input_device().is_some();
    let has_output = host.default_output_device().is_some();
    (has_input, has_output)
}

/// List available audio input devices.
pub fn list_input_devices() -> Vec<String> {
    let host = cpal::default_host();
    host.input_devices()
        .map(|devices| {
            devices
                .filter_map(|d| Some(d.description().ok()?.name().to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// List available audio output devices.
pub fn list_output_devices() -> Vec<String> {
    let host = cpal::default_host();
    host.output_devices()
        .map(|devices| {
            devices
                .filter_map(|d| Some(d.description().ok()?.name().to_string()))
                .collect()
        })
        .unwrap_or_default()
}
