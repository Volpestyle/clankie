mod app_state;
mod audio_pipeline;
mod capture;
mod capture_supervisor;
mod connection_supervisor;
mod dave;
mod h264;
mod ipc;
mod ipc_log_layer;
mod ipc_protocol;
mod ipc_router;
mod media_sink_wants;
mod music;
mod playback_supervisor;
mod process_unix;
mod rtcp;
mod rtp;
mod stream_publish;
mod transport_crypto;
mod video;
mod video_decode_worker;
mod video_decoder;
mod video_state;
mod voice_conn;
mod vp8;

use std::io;
use std::sync::Arc;
use std::time::Duration;

use crossbeam_channel as crossbeam;
use parking_lot::Mutex;
use tokio::time;
use tracing_subscriber::prelude::*;

use crate::app_state::AppState;
use crate::audio_pipeline::AudioSendState;
use crate::dave::DaveManager;
use crate::ipc::{OutMsg, send_msg, spawn_ipc_reader, spawn_ipc_writer};
use crate::ipc_log_layer::IpcLogLayer;
use crate::music::MusicEvent;
use crate::stream_publish::{StreamPublishEvent, StreamPublishFrame};
use crate::voice_conn::VoiceEvent;

const MUSIC_PCM_QUEUE_CAPACITY_CHUNKS: usize = 100; // ~2s of 20ms PCM chunks
const STREAM_PUBLISH_QUEUE_CAPACITY_FRAMES: usize = 90; // ~3s at 30fps

async fn reconnect_sleep(deadline: Option<time::Instant>) {
    match deadline {
        Some(deadline) => time::sleep_until(deadline).await,
        None => std::future::pending::<()>().await,
    }
}

/// Observability for the 20ms send tick.
///
/// `MissedTickBehavior::Skip` keeps the loop from bursting after a stall, but
/// it silently drops outbound audio cadence.  This monitor measures the gap
/// between consecutive ticks and surfaces sustained slippage as a rate-limited
/// warning so a stalled event loop is visible in the logs.
struct TickSlippageMonitor {
    tick_period: Duration,
    last_tick_at: Option<time::Instant>,
    skipped_ticks_total: u64,
    last_report_at: Option<time::Instant>,
}

impl TickSlippageMonitor {
    const REPORT_INTERVAL: Duration = Duration::from_secs(5);

    fn new(tick_period: Duration) -> Self {
        Self {
            tick_period,
            last_tick_at: None,
            skipped_ticks_total: 0,
            last_report_at: None,
        }
    }

    /// Record a tick.  Returns `Some((skipped_now, skipped_total))` when
    /// slippage occurred and a rate-limited report is due.
    fn record_tick(&mut self, now: time::Instant) -> Option<(u64, u64)> {
        let (skipped, gap) = match self.last_tick_at {
            Some(last) => {
                let elapsed = now.duration_since(last);
                (
                    (elapsed.as_micros() / self.tick_period.as_micros()).saturating_sub(1) as u64,
                    Some(elapsed),
                )
            }
            None => (0, None),
        };
        crate::app_state::transport_stats().record_tick(skipped, gap);
        self.last_tick_at = Some(now);
        if skipped == 0 {
            return None;
        }
        self.skipped_ticks_total = self.skipped_ticks_total.saturating_add(skipped);
        let report_due = self
            .last_report_at
            .is_none_or(|at| now.duration_since(at) >= Self::REPORT_INTERVAL);
        if report_due {
            self.last_report_at = Some(now);
            Some((skipped, self.skipped_ticks_total))
        } else {
            None
        }
    }
}

#[tokio::main]
async fn main() {
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");

    // Build layered subscriber: stderr fmt for local dev + IPC forwarding to Clankie/Loki.
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(io::stderr)
                .with_filter(
                    tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                        tracing_subscriber::EnvFilter::new(
                            "info,davey=warn,davey::cryptor::frame_processors=off",
                        )
                    }),
                ),
        )
        .with(IpcLogLayer)
        .init();

    spawn_ipc_writer();
    ipc_log_layer::mark_ipc_log_ready();

    let audio_debug = std::env::var("AUDIO_DEBUG").is_ok();
    let mut inbound_ipc = spawn_ipc_reader(audio_debug);

    tracing::info!("Voice subprocess started, waiting for IPC messages");

    let dave: Arc<Mutex<Option<DaveManager>>> = Arc::new(Mutex::new(None));
    let (voice_event_tx, mut voice_event_rx) = tokio::sync::mpsc::channel::<VoiceEvent>(256);
    let audio_send_state = Arc::new(Mutex::new(None::<AudioSendState>));

    let send_tick_period = Duration::from_millis(20);
    let mut send_interval = time::interval(send_tick_period);
    send_interval.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
    send_interval.tick().await;
    let mut tick_slippage = TickSlippageMonitor::new(send_tick_period);

    let (music_pcm_tx, music_pcm_rx) =
        crossbeam::bounded::<Vec<i16>>(MUSIC_PCM_QUEUE_CAPACITY_CHUNKS);
    let (music_event_tx, mut music_event_rx) = tokio::sync::mpsc::channel::<MusicEvent>(32);
    let (stream_publish_frame_tx, stream_publish_frame_rx) =
        crossbeam::bounded::<StreamPublishFrame>(STREAM_PUBLISH_QUEUE_CAPACITY_FRAMES);
    let (stream_publish_event_tx, stream_publish_event_rx) =
        crossbeam::bounded::<StreamPublishEvent>(32);

    let mut state = AppState::new(
        dave,
        voice_event_tx,
        audio_send_state,
        music_pcm_tx,
        music_pcm_rx,
        music_event_tx,
        stream_publish_frame_tx,
        stream_publish_frame_rx,
        stream_publish_event_tx,
        stream_publish_event_rx,
    );
    send_msg(OutMsg::ProcessReady);

    loop {
        tokio::select! {
            msg = inbound_ipc.recv() => {
                let Some(msg) = msg else {
                    break;
                };

                if state.route_ipc_message(msg).await {
                    break;
                }
            }

            Some(event) = voice_event_rx.recv() => {
                state.handle_voice_event(event);
            }

            Some(event) = music_event_rx.recv() => {
                state.handle_music_event(event);
            }

            () = reconnect_sleep(state.reconnect_deadline) => {
                state.handle_reconnect_timer().await;
            }

            _ = send_interval.tick() => {
                if let Some((skipped_now, skipped_total)) =
                    tick_slippage.record_tick(time::Instant::now())
                {
                    tracing::warn!(
                        skipped_now,
                        skipped_total,
                        "clankvox_audio_tick_slippage: event loop fell behind the 20ms send cadence"
                    );
                }
                state.on_audio_tick().await;
            }
        }
    }

    tracing::info!("Shutting down");
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use futures_util::FutureExt;
    use tokio::time;

    use super::{TickSlippageMonitor, reconnect_sleep};

    #[test]
    fn reconnect_sleep_without_deadline_is_pending() {
        let future = reconnect_sleep(None);
        tokio::pin!(future);
        assert!(future.now_or_never().is_none());
    }

    #[test]
    fn tick_slippage_monitor_counts_skipped_ticks_and_rate_limits_reports() {
        let period = Duration::from_millis(20);
        let mut monitor = TickSlippageMonitor::new(period);
        let start = time::Instant::now();

        // First tick establishes the baseline; on-cadence ticks are silent.
        assert_eq!(monitor.record_tick(start), None);
        assert_eq!(monitor.record_tick(start + period), None);

        // A 100ms gap skipped four ticks and reports immediately.
        let stalled = start + period + Duration::from_millis(100);
        assert_eq!(monitor.record_tick(stalled), Some((4, 4)));

        // More slippage inside the report window accumulates silently…
        let stalled_again = stalled + Duration::from_millis(60);
        assert_eq!(monitor.record_tick(stalled_again), None);
        assert_eq!(monitor.skipped_ticks_total, 6);

        // …and the next report after the window carries the running total.
        let later = stalled_again + Duration::from_secs(6);
        let (_, total) = monitor
            .record_tick(later)
            .expect("report due after interval");
        assert!(total >= 6);
    }
}
