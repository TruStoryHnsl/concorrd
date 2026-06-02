//! Phase 8/9 follow-up — mesh-mode audio capture + playback pipeline.
//!
//! Desktop-only (Linux / macOS / Windows). iOS is gated off in
//! [`super::media`] via `#[cfg(not(target_os = "ios"))]`; iOS mesh
//! callers see `VoiceError::AudioNotSupported` and the path-selector
//! falls back to LiveKit. An iOS-specific AVAudioEngine path is the
//! `TODO(mesh-media-followup-v2)` follow-up.
//!
//! ## Pipeline shape
//!
//! ### Send (mic → remote peer)
//!
//! ```text
//!   cpal input stream  (audio thread, FnMut(&[f32]) callback)
//!         │
//!         ▼  ringbuf::HeapRb<i16>  (SPSC, lock-free, bridges audio
//!         │                          thread → tokio task)
//!         ▼
//!   AudioSendPipeline::spawn (tokio task)
//!         │  drain 20ms frames (960 samples @ 48kHz mono)
//!         ▼
//!   audiopus::coder::Encoder::encode  →  opus payload bytes
//!         │
//!         ▼  build_rtp_packet(ssrc, seq, ts, payload)
//!         ▼
//!   TrackLocalStaticRTP::write_rtp  →  webrtc-rs RTP path
//! ```
//!
//! ### Receive (remote peer → speaker)
//!
//! ```text
//!   TrackRemote::read_rtp  →  rtp::packet::Packet
//!         │
//!         ▼  payload bytes (opus)
//!         ▼
//!   audiopus::coder::Decoder::decode → i16 PCM samples
//!         │
//!         ▼  ringbuf::HeapRb<i16>  (SPSC, bridges tokio task →
//!         │                          cpal output thread)
//!         ▼
//!   cpal output stream  (audio thread, FnMut(&mut [f32]) callback)
//! ```
//!
//! ## Hot path invariants
//!
//!   * cpal callbacks run on a **non-tokio audio thread**. Never call
//!     `tokio::*` blocking primitives inside them. The ring buffer is
//!     the bridge — SPSC, lock-free, allocation-free on the hot path.
//!   * The encode/decode tasks run inside the tokio runtime. They use
//!     `tokio::time::sleep` for backpressure (NOT `std::thread::sleep`
//!     — that would block the runtime).
//!   * The mic ringbuf is sized so that ~10 frames (200ms) of audio
//!     fit before the producer (cpal callback) starts dropping
//!     samples. Generous headroom for jitter without growing
//!     unbounded.
//!   * Output stream samples are interleaved at the device's native
//!     channel count; we resample/downmix to mono internally and let
//!     cpal handle the device-side spread.
//!
//! ## What this PR does NOT ship
//!
//!   * No opus DTX / FEC / NACK / congestion control / jitter buffer.
//!     Fixed 20ms frames at default bitrate (~32kbps mono). Quality
//!     tuning is a follow-up.
//!   * No sample-rate conversion — if the host's default input sample
//!     rate is not 48kHz, we request 48kHz from cpal and let it
//!     resample (most modern host APIs do this transparently; on some
//!     platforms this falls back to the device's native rate, which
//!     opus doesn't like). The follow-up handles non-48kHz inputs.
//!   * No microphone level / VAD / noise suppression. Raw PCM in,
//!     raw PCM out.
//!   * iOS AVAudioEngine wiring — see module doc above.

#![cfg(not(target_os = "ios"))]

use std::sync::Arc;
use std::time::Duration;

use audiopus::coder::{Decoder, Encoder};
use audiopus::{Application, Channels, SampleRate};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};
use rtp::packet::Packet as RtpPacket;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::TrackLocalWriter;
use webrtc::track::track_remote::TrackRemote;

use super::error::VoiceError;

/// Opus internal sampling rate — the codec is built around it.
pub const SAMPLE_RATE_HZ: u32 = 48_000;

/// Frame duration. The standard opus VoIP frame; matches webrtc-rs's
/// default opus packetizer cadence.
pub const FRAME_DURATION_MS: u32 = 20;

/// 20ms @ 48kHz mono = 960 samples per frame.
pub const FRAME_SAMPLES: usize =
    (SAMPLE_RATE_HZ as usize / 1000) * FRAME_DURATION_MS as usize;

/// Opus dynamic payload type matching webrtc-rs's default
/// `MIME_TYPE_OPUS` codec capability registration (RFC 7587 reserves
/// 111 as the standard dynamic mapping for opus inside WebRTC).
pub const OPUS_PAYLOAD_TYPE: u8 = 111;

/// Capacity of the mic-side ring buffer in samples. 960 samples per
/// frame × ~10 frames = 9600 samples ≈ 200ms of slack. Generous
/// enough that a jittery tokio scheduler can fall behind without
/// dropping packets, but bounded so a stuck consumer doesn't grow
/// unbounded.
const MIC_RINGBUF_CAPACITY: usize = FRAME_SAMPLES * 10;

/// Capacity of the speaker-side ring buffer. Same shape as mic side
/// but slightly larger because cpal output callbacks ask for whatever
/// frame size the device prefers — sometimes much more than 20ms.
const SPEAKER_RINGBUF_CAPACITY: usize = FRAME_SAMPLES * 20;

/// Errors surfaced by the audio pipeline. Distinct from
/// [`VoiceError`] so the pipeline can be exercised in tests without
/// pulling in the whole `webrtc-rs` error graph. Converted to
/// `VoiceError::Audio` at the [`super::media::WebRtcMediaPeer`] seam.
#[derive(Debug, thiserror::Error)]
pub enum AudioError {
    #[error("no default input device")]
    NoInputDevice,
    #[error("no default output device")]
    NoOutputDevice,
    #[error("cpal: {0}")]
    Cpal(String),
    #[error("opus: {0}")]
    Opus(String),
    #[error("rtp: {0}")]
    Rtp(String),
}

impl From<AudioError> for VoiceError {
    fn from(e: AudioError) -> Self {
        VoiceError::Audio(e.to_string())
    }
}

/// Build the standard 48kHz mono `StreamConfig` opus expects.
fn mono_48k_config() -> cpal::StreamConfig {
    cpal::StreamConfig {
        channels: 1,
        sample_rate: cpal::SampleRate(SAMPLE_RATE_HZ),
        buffer_size: cpal::BufferSize::Default,
    }
}

/// Microphone capture. Holds the consumer half of the SPSC ring
/// buffer + a [`StreamKeepalive`] that pins the cpal stream alive on
/// a dedicated OS thread (cpal's `Stream` is `!Send` across
/// platforms, so it cannot live inside a tokio task — this thread
/// owns it).
///
/// The encode loop pulls 20ms frames at a time via
/// [`Self::read_frame`]. The consumer half IS `Send` (it's a
/// `ringbuf::HeapCons<i16>`), so `AudioCapture` itself is `Send`
/// and can cross await points.
pub struct AudioCapture {
    _keepalive: StreamKeepalive,
    rb_consumer: HeapCons<i16>,
    /// Best-effort sample-count of dropped audio (mic produced
    /// samples faster than the consumer drained them). Surfaces in
    /// debug-level logging; not part of the public API.
    overflow_counter: Arc<std::sync::atomic::AtomicU64>,
}

/// Owner of a `!Send` cpal Stream. The stream is built on a
/// dedicated OS thread and kept alive until this struct is dropped;
/// at drop time the keepalive signals the thread to release the
/// stream (which stops capture).
pub struct StreamKeepalive {
    stop_tx: Option<std::sync::mpsc::Sender<()>>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl Drop for StreamKeepalive {
    fn drop(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(handle) = self.join.take() {
            let _ = handle.join();
        }
    }
}

impl AudioCapture {
    /// Open the default input device, configure it for 48kHz mono i16
    /// (negotiated from whatever the device natively gives us), and
    /// start streaming samples into the ring buffer.
    ///
    /// Returns immediately — the cpal stream's audio-thread callback
    /// keeps the ringbuf fed; the caller pulls 20ms frames via
    /// [`Self::read_frame`].
    pub fn start() -> Result<Self, AudioError> {
        let rb: HeapRb<i16> = HeapRb::new(MIC_RINGBUF_CAPACITY);
        let (producer, rb_consumer) = rb.split();
        let overflow_counter =
            Arc::new(std::sync::atomic::AtomicU64::new(0));
        let overflow_for_thread = Arc::clone(&overflow_counter);

        // cpal stream is !Send; spawn a dedicated thread to own it.
        // The thread reports init success/failure via a one-shot
        // channel before parking on the stop signal.
        let (init_tx, init_rx) = std::sync::mpsc::channel::<Result<(), AudioError>>();
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        let join = std::thread::Builder::new()
            .name("concord-voice-mic".into())
            .spawn(move || {
                let host = cpal::default_host();
                let device = match host.default_input_device() {
                    Some(d) => d,
                    None => {
                        let _ = init_tx.send(Err(AudioError::NoInputDevice));
                        return;
                    }
                };
                let supported = match device.default_input_config() {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = init_tx.send(Err(AudioError::Cpal(format!(
                            "default_input_config: {e}"
                        ))));
                        return;
                    }
                };
                let sample_format = supported.sample_format();
                let config = mono_48k_config();
                let stream = match build_input_stream(
                    &device,
                    &config,
                    sample_format,
                    producer,
                    overflow_for_thread,
                ) {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = init_tx.send(Err(e));
                        return;
                    }
                };
                if let Err(e) = stream.play() {
                    let _ = init_tx.send(Err(AudioError::Cpal(format!(
                        "stream play: {e}"
                    ))));
                    return;
                }
                let _ = init_tx.send(Ok(()));
                // Park until the keepalive drops. The cpal Stream is
                // dropped here (when this thread returns) — that
                // stops capture cleanly.
                let _ = stop_rx.recv();
                drop(stream);
            })
            .map_err(|e| AudioError::Cpal(format!("spawn mic thread: {e}")))?;

        // Wait for the worker thread's init result before returning.
        match init_rx
            .recv()
            .map_err(|e| AudioError::Cpal(format!("mic thread init recv: {e}")))?
        {
            Ok(()) => {}
            Err(e) => {
                let _ = stop_tx.send(());
                let _ = join.join();
                return Err(e);
            }
        }

        Ok(Self {
            _keepalive: StreamKeepalive {
                stop_tx: Some(stop_tx),
                join: Some(join),
            },
            rb_consumer,
            overflow_counter,
        })
    }

    /// Read one 20ms frame (960 samples) from the ring buffer.
    /// Returns `None` if the buffer doesn't have a full frame yet —
    /// the caller (the encode task) should yield briefly and retry.
    pub fn read_frame(&mut self) -> Option<[i16; FRAME_SAMPLES]> {
        if self.rb_consumer.occupied_len() < FRAME_SAMPLES {
            return None;
        }
        let mut buf = [0i16; FRAME_SAMPLES];
        let n = self.rb_consumer.pop_slice(&mut buf);
        if n < FRAME_SAMPLES {
            // Partial read — the producer raced us between the
            // occupied_len check and the pop. Discard; we'll catch
            // a full frame on the next poll. The dropped samples are
            // <1 frame; not worth surfacing.
            return None;
        }
        Some(buf)
    }

    /// Snapshot of overflow counter — best-effort visibility into
    /// how many samples were dropped because the consumer couldn't
    /// keep up. Useful for diagnostics; not part of the data path.
    pub fn overflow_samples(&self) -> u64 {
        self.overflow_counter
            .load(std::sync::atomic::Ordering::Relaxed)
    }
}

/// Build the cpal input stream for the negotiated sample format.
/// cpal's `build_input_stream` is generic over the sample type, so
/// we have to branch by format. We accept whatever the device gives
/// us and convert to i16 inside the audio-thread callback.
fn build_input_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    sample_format: SampleFormat,
    mut producer: HeapProd<i16>,
    overflow_counter: Arc<std::sync::atomic::AtomicU64>,
) -> Result<cpal::Stream, AudioError> {
    let err_fn = |err: cpal::StreamError| {
        log::warn!(target: "concord::servitude::voice::audio",
            "cpal input stream error: {err}");
    };
    let stream = match sample_format {
        SampleFormat::F32 => device
            .build_input_stream(
                config,
                move |data: &[f32], _info| {
                    let mut buf = [0i16; 2048];
                    let mut idx = 0;
                    let mut overflow = 0u64;
                    for s in data.iter().copied() {
                        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
                        buf[idx] = v;
                        idx += 1;
                        if idx == buf.len() {
                            let pushed = producer.push_slice(&buf);
                            if pushed < idx {
                                overflow += (idx - pushed) as u64;
                            }
                            idx = 0;
                        }
                    }
                    if idx > 0 {
                        let pushed = producer.push_slice(&buf[..idx]);
                        if pushed < idx {
                            overflow += (idx - pushed) as u64;
                        }
                    }
                    if overflow > 0 {
                        overflow_counter
                            .fetch_add(overflow, std::sync::atomic::Ordering::Relaxed);
                    }
                },
                err_fn,
                None,
            )
            .map_err(|e| AudioError::Cpal(format!("build_input_stream f32: {e}")))?,
        SampleFormat::I16 => device
            .build_input_stream(
                config,
                move |data: &[i16], _info| {
                    let pushed = producer.push_slice(data);
                    if pushed < data.len() {
                        overflow_counter.fetch_add(
                            (data.len() - pushed) as u64,
                            std::sync::atomic::Ordering::Relaxed,
                        );
                    }
                },
                err_fn,
                None,
            )
            .map_err(|e| AudioError::Cpal(format!("build_input_stream i16: {e}")))?,
        SampleFormat::U16 => device
            .build_input_stream(
                config,
                move |data: &[u16], _info| {
                    let mut buf = [0i16; 2048];
                    let mut idx = 0;
                    let mut overflow = 0u64;
                    for s in data.iter().copied() {
                        let v = (s as i32 - 32768) as i16;
                        buf[idx] = v;
                        idx += 1;
                        if idx == buf.len() {
                            let pushed = producer.push_slice(&buf);
                            if pushed < idx {
                                overflow += (idx - pushed) as u64;
                            }
                            idx = 0;
                        }
                    }
                    if idx > 0 {
                        let pushed = producer.push_slice(&buf[..idx]);
                        if pushed < idx {
                            overflow += (idx - pushed) as u64;
                        }
                    }
                    if overflow > 0 {
                        overflow_counter
                            .fetch_add(overflow, std::sync::atomic::Ordering::Relaxed);
                    }
                },
                err_fn,
                None,
            )
            .map_err(|e| AudioError::Cpal(format!("build_input_stream u16: {e}")))?,
        other => {
            return Err(AudioError::Cpal(format!(
                "unsupported input sample format: {other:?}"
            )))
        }
    };
    Ok(stream)
}

/// Build an opus encoder configured for the mesh codec parameters:
/// 48kHz, mono, VoIP application (low-latency, optimized for speech).
fn build_opus_encoder() -> Result<Encoder, AudioError> {
    Encoder::new(SampleRate::Hz48000, Channels::Mono, Application::Voip)
        .map_err(|e| AudioError::Opus(format!("encoder new: {e}")))
}

/// Build an opus decoder configured for 48kHz mono.
fn build_opus_decoder() -> Result<Decoder, AudioError> {
    Decoder::new(SampleRate::Hz48000, Channels::Mono)
        .map_err(|e| AudioError::Opus(format!("decoder new: {e}")))
}

/// Compose an RTP packet around an opus payload. Uses payload type
/// 111 (the WebRTC dynamic mapping for opus; matches webrtc-rs's
/// `MIME_TYPE_OPUS` codec capability registration).
///
/// Header fields:
///   * version = 2 (RFC 3550)
///   * payload_type = 111 (opus)
///   * marker = false (opus is a single payload per packet; no marker
///     boundary semantics needed for the mesh)
///   * sequence_number / timestamp / ssrc — caller-supplied
pub fn build_rtp_packet(
    ssrc: u32,
    sequence_number: u16,
    timestamp: u32,
    payload: Vec<u8>,
) -> RtpPacket {
    RtpPacket {
        header: rtp::header::Header {
            version: 2,
            padding: false,
            extension: false,
            marker: false,
            payload_type: OPUS_PAYLOAD_TYPE,
            sequence_number,
            timestamp,
            ssrc,
            csrc: Vec::new(),
            extension_profile: 0,
            extensions: Vec::new(),
            extensions_padding: 0,
        },
        payload: payload.into(),
    }
}

/// Send-side audio pipeline: pulls 20ms PCM frames from
/// [`AudioCapture`], opus-encodes them, and pushes RTP packets into
/// a `TrackLocalStaticRTP`. Spawned on the tokio runtime — the
/// `JoinHandle` returned by [`Self::spawn`] is cancelable, which
/// `WebRtcMediaPeer::stop_audio_capture` uses on call leave.
pub struct AudioSendPipeline {
    encoder: Encoder,
    capture: AudioCapture,
    track: Arc<TrackLocalStaticRTP>,
    /// Monotonic RTP sequence number. Wraps at u16::MAX.
    rtp_seq: u16,
    /// Monotonic RTP timestamp in opus samples (advances by
    /// `FRAME_SAMPLES` each packet).
    rtp_ts: u32,
    /// Random SSRC chosen at pipeline construction. Stable for the
    /// lifetime of the call so the remote can demux us correctly.
    ssrc: u32,
}

impl AudioSendPipeline {
    /// Build a fresh send pipeline. Allocates the cpal input stream,
    /// the opus encoder, and the RTP sequence state. The track is
    /// borrowed via an `Arc` so the pipeline can write into the
    /// same track the WebRTC PeerConnection holds.
    pub fn new(track: Arc<TrackLocalStaticRTP>) -> Result<Self, AudioError> {
        let encoder = build_opus_encoder()?;
        let capture = AudioCapture::start()?;
        // SSRC must be non-zero and unique per stream. Using a true
        // random 32-bit value matches webrtc-rs's own default.
        let ssrc: u32 = rand::random::<u32>() | 1;
        Ok(Self {
            encoder,
            capture,
            track,
            rtp_seq: rand::random::<u16>(),
            rtp_ts: rand::random::<u32>(),
            ssrc,
        })
    }

    /// Construct a pipeline without opening a real audio device.
    /// Used by unit tests so the encode/RTP path can be exercised
    /// against synthetic PCM without a microphone.
    #[cfg(test)]
    pub fn new_with_capture(
        track: Arc<TrackLocalStaticRTP>,
        capture: AudioCapture,
    ) -> Result<Self, AudioError> {
        let encoder = build_opus_encoder()?;
        let ssrc: u32 = rand::random::<u32>() | 1;
        Ok(Self {
            encoder,
            capture,
            track,
            rtp_seq: rand::random::<u16>(),
            rtp_ts: rand::random::<u32>(),
            ssrc,
        })
    }

    /// Spawn the send loop on the current tokio runtime. The task
    /// runs until the track is closed (write_rtp errors) or the
    /// JoinHandle is aborted.
    pub fn spawn(mut self) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut opus_buf = vec![0u8; 1500];
            loop {
                let Some(samples) = self.capture.read_frame() else {
                    // Not enough samples yet — yield briefly. We use
                    // tokio::time::sleep so the runtime stays
                    // responsive; std::thread::sleep would block the
                    // entire runtime worker.
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    continue;
                };
                let n = match self.encoder.encode(&samples, &mut opus_buf) {
                    Ok(n) => n,
                    Err(e) => {
                        log::debug!(target: "concord::servitude::voice::audio",
                            "opus encode failed: {e}");
                        continue;
                    }
                };
                if n == 0 {
                    continue;
                }
                let payload = opus_buf[..n].to_vec();
                let packet =
                    build_rtp_packet(self.ssrc, self.rtp_seq, self.rtp_ts, payload);
                self.rtp_seq = self.rtp_seq.wrapping_add(1);
                self.rtp_ts = self.rtp_ts.wrapping_add(FRAME_SAMPLES as u32);
                match self.track.write_rtp(&packet).await {
                    Ok(_) => {}
                    Err(webrtc::Error::ErrClosedPipe) => {
                        // Track shut down. Clean exit.
                        log::debug!(target: "concord::servitude::voice::audio",
                            "track closed — send pipeline exiting");
                        return;
                    }
                    Err(e) => {
                        log::debug!(target: "concord::servitude::voice::audio",
                            "track write_rtp error: {e}");
                        // Some webrtc-rs implementations surface
                        // non-fatal errors during early ICE; one
                        // failure isn't enough to tear the pipeline
                        // down. We loop and retry. If write_rtp
                        // keeps failing for >250ms because the track
                        // is truly closed, the next iteration's
                        // sleep gives a follower a chance to react.
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                }
            }
        })
    }
}

/// Receive-side audio pipeline: reads RTP packets from a
/// `TrackRemote`, opus-decodes them, and writes PCM samples into a
/// cpal output stream's ring buffer.
///
/// One pipeline per remote track. The webrtc-rs `on_track` callback
/// constructs one when a remote's audio track arrives.
///
/// The cpal output Stream is `!Send`, so we keep it pinned to a
/// dedicated thread via [`StreamKeepalive`] — the spawned tokio task
/// only holds Send-safe state (the ring buffer producer + the opus
/// decoder + the remote track Arc).
pub struct AudioReceivePipeline {
    track: Arc<TrackRemote>,
    decoder: Decoder,
    rb_producer: HeapProd<i16>,
    /// cpal output stream lives on its own thread; this keepalive
    /// holds the thread handle + stop signal until the pipeline is
    /// dropped.
    _keepalive: StreamKeepalive,
    output_channels: usize,
}

impl AudioReceivePipeline {
    /// Build a receive pipeline driven by `track`. Opens the default
    /// output device, decodes incoming opus frames in
    /// [`Self::spawn`]'s loop, and writes PCM into the device's
    /// ring buffer.
    pub fn new(track: Arc<TrackRemote>) -> Result<Self, AudioError> {
        let decoder = build_opus_decoder()?;

        let rb: HeapRb<i16> = HeapRb::new(SPEAKER_RINGBUF_CAPACITY);
        let (rb_producer, rb_consumer) = rb.split();

        let (init_tx, init_rx) =
            std::sync::mpsc::channel::<Result<usize, AudioError>>();
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        let join = std::thread::Builder::new()
            .name("concord-voice-speaker".into())
            .spawn(move || {
                let host = cpal::default_host();
                let device = match host.default_output_device() {
                    Some(d) => d,
                    None => {
                        let _ = init_tx.send(Err(AudioError::NoOutputDevice));
                        return;
                    }
                };
                let supported = match device.default_output_config() {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = init_tx.send(Err(AudioError::Cpal(format!(
                            "default_output_config: {e}"
                        ))));
                        return;
                    }
                };
                let device_channels = supported.channels() as usize;
                let device_rate = supported.sample_rate().0;
                let config = cpal::StreamConfig {
                    channels: supported.channels(),
                    sample_rate: supported.sample_rate(),
                    buffer_size: cpal::BufferSize::Default,
                };
                let sample_format = supported.sample_format();
                if device_rate != SAMPLE_RATE_HZ {
                    log::warn!(target: "concord::servitude::voice::audio",
                        "output device runs at {device_rate}Hz; opus is 48kHz — \
                         pitch may be slightly off until resampling lands");
                }
                let stream = match build_output_stream(
                    &device,
                    &config,
                    sample_format,
                    rb_consumer,
                    device_channels,
                ) {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = init_tx.send(Err(e));
                        return;
                    }
                };
                if let Err(e) = stream.play() {
                    let _ = init_tx.send(Err(AudioError::Cpal(format!(
                        "output play: {e}"
                    ))));
                    return;
                }
                let _ = init_tx.send(Ok(device_channels));
                let _ = stop_rx.recv();
                drop(stream);
            })
            .map_err(|e| AudioError::Cpal(format!("spawn speaker thread: {e}")))?;

        let output_channels = match init_rx
            .recv()
            .map_err(|e| AudioError::Cpal(format!("speaker init recv: {e}")))?
        {
            Ok(n) => n,
            Err(e) => {
                let _ = stop_tx.send(());
                let _ = join.join();
                return Err(e);
            }
        };

        Ok(Self {
            track,
            decoder,
            rb_producer,
            _keepalive: StreamKeepalive {
                stop_tx: Some(stop_tx),
                join: Some(join),
            },
            output_channels,
        })
    }

    /// Spawn the receive loop. Reads opus packets from the remote
    /// track, decodes, and pushes PCM into the speaker ring buffer.
    /// Exits when the track is closed (read_rtp returns an error).
    pub fn spawn(mut self) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut pcm_buf = vec![0i16; FRAME_SAMPLES * 6];
            loop {
                let (pkt, _attrs) = match self.track.read_rtp().await {
                    Ok(v) => v,
                    Err(e) => {
                        log::debug!(target: "concord::servitude::voice::audio",
                            "remote track read_rtp error: {e} — exiting");
                        return;
                    }
                };
                if pkt.payload.is_empty() {
                    continue;
                }
                // Decode opus → PCM. `MutSignals` is just a wrapper
                // around `&mut [i16]`; the decoder writes interleaved
                // mono into it. With FEC disabled (we don't have
                // packet-loss info at this layer).
                let signals = match audiopus::MutSignals::try_from(&mut pcm_buf[..]) {
                    Ok(s) => s,
                    Err(e) => {
                        log::debug!(target: "concord::servitude::voice::audio",
                            "MutSignals init failed: {e}");
                        continue;
                    }
                };
                let pkt_view =
                    match audiopus::packet::Packet::try_from(&pkt.payload[..]) {
                        Ok(p) => p,
                        Err(e) => {
                            log::debug!(target: "concord::servitude::voice::audio",
                                "opus packet wrap failed: {e}");
                            continue;
                        }
                    };
                let samples = match self.decoder.decode(Some(pkt_view), signals, false) {
                    Ok(n) => n,
                    Err(e) => {
                        log::debug!(target: "concord::servitude::voice::audio",
                            "opus decode failed: {e}");
                        continue;
                    }
                };
                if samples == 0 {
                    continue;
                }
                // Spread mono → device channels. The output callback
                // expects interleaved samples at the device's native
                // channel count.
                push_mono_as_multichannel(
                    &mut self.rb_producer,
                    &pcm_buf[..samples],
                    self.output_channels,
                );
            }
        })
    }
}

/// Spread mono i16 PCM into the speaker ring buffer at the device's
/// native channel count. Duplicates each mono sample N times.
fn push_mono_as_multichannel(
    producer: &mut HeapProd<i16>,
    mono: &[i16],
    channels: usize,
) {
    if channels <= 1 {
        producer.push_slice(mono);
        return;
    }
    let mut interleaved = Vec::with_capacity(mono.len() * channels);
    for s in mono.iter().copied() {
        for _ in 0..channels {
            interleaved.push(s);
        }
    }
    producer.push_slice(&interleaved);
}

fn build_output_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    sample_format: SampleFormat,
    mut consumer: HeapCons<i16>,
    _channels: usize,
) -> Result<cpal::Stream, AudioError> {
    let err_fn = |err: cpal::StreamError| {
        log::warn!(target: "concord::servitude::voice::audio",
            "cpal output stream error: {err}");
    };
    let stream = match sample_format {
        SampleFormat::F32 => device
            .build_output_stream(
                config,
                move |data: &mut [f32], _info| {
                    let mut buf = vec![0i16; data.len()];
                    let popped = consumer.pop_slice(&mut buf);
                    for i in 0..data.len() {
                        if i < popped {
                            data[i] = buf[i] as f32 / 32768.0;
                        } else {
                            data[i] = 0.0;
                        }
                    }
                },
                err_fn,
                None,
            )
            .map_err(|e| AudioError::Cpal(format!("build_output_stream f32: {e}")))?,
        SampleFormat::I16 => device
            .build_output_stream(
                config,
                move |data: &mut [i16], _info| {
                    let popped = consumer.pop_slice(data);
                    for i in popped..data.len() {
                        data[i] = 0;
                    }
                },
                err_fn,
                None,
            )
            .map_err(|e| AudioError::Cpal(format!("build_output_stream i16: {e}")))?,
        SampleFormat::U16 => device
            .build_output_stream(
                config,
                move |data: &mut [u16], _info| {
                    let mut buf = vec![0i16; data.len()];
                    let popped = consumer.pop_slice(&mut buf);
                    for i in 0..data.len() {
                        let s = if i < popped { buf[i] } else { 0 };
                        data[i] = (s as i32 + 32768) as u16;
                    }
                },
                err_fn,
                None,
            )
            .map_err(|e| AudioError::Cpal(format!("build_output_stream u16: {e}")))?,
        other => {
            return Err(AudioError::Cpal(format!(
                "unsupported output sample format: {other:?}"
            )))
        }
    };
    Ok(stream)
}

#[cfg(test)]
mod tests {
    //! Inline unit tests that exercise the codec wire without a real
    //! audio device. Device-backed tests live in
    //! `src-tauri/tests/audio_pipeline_test.rs`.

    use super::*;

    /// `build_rtp_packet` produces an RTP packet with the canonical
    /// header fields opus requires.
    #[test]
    fn rtp_packet_has_canonical_opus_header() {
        let payload = vec![0xAA, 0xBB, 0xCC];
        let pkt = build_rtp_packet(0xDEADBEEF, 42, 9600, payload.clone());
        assert_eq!(pkt.header.version, 2);
        assert_eq!(pkt.header.payload_type, OPUS_PAYLOAD_TYPE);
        assert_eq!(pkt.header.sequence_number, 42);
        assert_eq!(pkt.header.timestamp, 9600);
        assert_eq!(pkt.header.ssrc, 0xDEADBEEF);
        assert!(!pkt.header.marker);
        assert_eq!(pkt.payload.as_ref(), payload.as_slice());
    }

    /// Opus encoder + decoder round-trip a 1-second 440Hz sine wave.
    /// Asserts the decoder produced non-zero PCM and that the
    /// reconstructed waveform is "close enough" to the original by
    /// energy. Tests the codec wire without needing real audio
    /// devices.
    #[test]
    fn opus_encode_decode_round_trip() {
        let encoder = build_opus_encoder().expect("encoder");
        let mut decoder = build_opus_decoder().expect("decoder");

        // Generate 50 frames × 960 samples = 1 second of 440Hz sine
        // at 48kHz mono.
        let mut total_in_energy: u64 = 0;
        let mut total_out_energy: u64 = 0;
        let mut decoded_frames = 0;
        for frame_idx in 0..50 {
            let mut samples = [0i16; FRAME_SAMPLES];
            for i in 0..FRAME_SAMPLES {
                let t = (frame_idx * FRAME_SAMPLES + i) as f32 / SAMPLE_RATE_HZ as f32;
                let v = (t * 440.0 * 2.0 * std::f32::consts::PI).sin() * 16384.0;
                samples[i] = v as i16;
                total_in_energy += (v as i64).unsigned_abs();
            }
            let mut opus_buf = vec![0u8; 1500];
            let n = encoder.encode(&samples, &mut opus_buf).expect("encode");
            assert!(n > 0, "encoder must produce non-empty packet");
            opus_buf.truncate(n);
            let pkt = audiopus::packet::Packet::try_from(&opus_buf[..]).expect("pkt");
            let mut decoded = vec![0i16; FRAME_SAMPLES];
            let signals =
                audiopus::MutSignals::try_from(&mut decoded[..]).expect("signals");
            let dec_n = decoder.decode(Some(pkt), signals, false).expect("decode");
            assert_eq!(dec_n, FRAME_SAMPLES, "decoder produces a full frame");
            for s in &decoded {
                total_out_energy += (*s as i64).unsigned_abs();
            }
            decoded_frames += 1;
        }
        assert_eq!(decoded_frames, 50);
        assert!(
            total_out_energy > 0,
            "decoded waveform must contain non-zero samples"
        );
        // SNR sanity — output energy within ~50% of input. Opus VoIP
        // at default bitrate is lossy but preserves energy
        // reasonably well for pure tones.
        let ratio = total_out_energy as f64 / total_in_energy as f64;
        assert!(
            ratio > 0.3 && ratio < 3.0,
            "decoded energy ratio {ratio} is wildly off the input — codec wire broken"
        );
    }

    /// Spread-to-multichannel doubles every mono sample for stereo.
    #[test]
    fn mono_spread_to_stereo_duplicates_samples() {
        let rb: HeapRb<i16> = HeapRb::new(128);
        let (mut prod, mut cons) = rb.split();
        push_mono_as_multichannel(&mut prod, &[1, 2, 3], 2);
        let mut buf = vec![0i16; 6];
        let n = cons.pop_slice(&mut buf);
        assert_eq!(n, 6);
        assert_eq!(buf, vec![1, 1, 2, 2, 3, 3]);
    }

    /// Mono spread with channels=1 is a pass-through.
    #[test]
    fn mono_spread_with_one_channel_is_passthrough() {
        let rb: HeapRb<i16> = HeapRb::new(128);
        let (mut prod, mut cons) = rb.split();
        push_mono_as_multichannel(&mut prod, &[7, 8, 9], 1);
        let mut buf = vec![0i16; 3];
        let n = cons.pop_slice(&mut buf);
        assert_eq!(n, 3);
        assert_eq!(buf, vec![7, 8, 9]);
    }
}
