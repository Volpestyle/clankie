//! Dedicated decode thread for inbound H264 watch frames.
//!
//! openh264 decode, scalar YUV→RGB conversion, and turbojpeg encoding are too
//! heavy for the single-threaded event loop — running them inline delays the
//! 20ms audio send tick and every other event source.  The event loop instead
//! enqueues encoded access units onto a bounded frame lane (drop-oldest on
//! overflow) and this worker owns the per-user persistent decoders, runs the
//! fps gate, and emits `decoded_video_frame` IPC messages directly.
//!
//! Decoder-reset PLI requests flow back to the event loop over a small
//! bounded lane because RTCP feedback must go out through the transport
//! connection, which only the event loop owns.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine as _;
use crossbeam_channel as crossbeam;
use tokio::time;
use tracing::{error, info, warn};

use crate::app_state::transport_stats;
use crate::ipc::{OutMsg, send_msg};
use crate::video_decoder::PersistentVideoDecoder;
use crate::voice_conn::TransportRole;

/// Bounded depth of the frame lane.  Encoded access units are small relative
/// to decoded output; 8 frames is ~250ms of headroom at 30fps before the
/// oldest frame gets dropped.
const FRAME_QUEUE_CAPACITY: usize = 8;
/// Bounded depth of the PLI feedback lane back to the event loop.
const PLI_QUEUE_CAPACITY: usize = 16;

/// One encoded H264 access unit plus the subscription context the worker
/// needs to decode, rate-limit, and emit it.
pub(crate) struct VideoDecodeFrameJob {
    pub(crate) role: TransportRole,
    pub(crate) generation: u64,
    pub(crate) user_id: u64,
    pub(crate) ssrc: u32,
    pub(crate) frame: Vec<u8>,
    pub(crate) jpeg_quality: i32,
    pub(crate) max_frames_per_second: u32,
}

enum VideoDecodeControl {
    RemoveUser(TransportRole, u64),
    ClearRole(TransportRole),
}

/// Event-loop handle to the decode thread.  Dropping it disconnects both
/// lanes, which shuts the worker thread down.
pub(crate) struct VideoDecodeWorker {
    frame_tx: crossbeam::Sender<VideoDecodeFrameJob>,
    /// Receiver clone used only to pop the oldest queued frame when the lane
    /// is full — the worker thread holds its own receiver.
    frame_rx: crossbeam::Receiver<VideoDecodeFrameJob>,
    control_tx: crossbeam::Sender<VideoDecodeControl>,
    pli_rx: crossbeam::Receiver<(TransportRole, u64, u64, u32)>,
    dropped_frames: AtomicU64,
}

impl VideoDecodeWorker {
    pub(crate) fn spawn() -> Self {
        let (frame_tx, frame_rx) = crossbeam::bounded::<VideoDecodeFrameJob>(FRAME_QUEUE_CAPACITY);
        let (control_tx, control_rx) = crossbeam::unbounded::<VideoDecodeControl>();
        let (pli_tx, pli_rx) =
            crossbeam::bounded::<(TransportRole, u64, u64, u32)>(PLI_QUEUE_CAPACITY);

        let worker_frame_rx = frame_rx.clone();
        std::thread::spawn(move || {
            run_worker(&worker_frame_rx, &control_rx, &pli_tx);
        });

        Self {
            frame_tx,
            frame_rx,
            control_tx,
            pli_rx,
            dropped_frames: AtomicU64::new(0),
        }
    }

    /// Enqueue a frame for decoding.  When the lane is full the oldest queued
    /// frame is dropped so the decoder keeps working on the freshest video.
    pub(crate) fn submit_frame(&self, job: VideoDecodeFrameJob) {
        let mut job = job;
        loop {
            match self.frame_tx.try_send(job) {
                Ok(()) => {
                    let dropped = self.dropped_frames.swap(0, Ordering::Relaxed);
                    if dropped > 0 {
                        info!(
                            dropped_decode_frames = dropped,
                            "clankvox_video_decode_backpressure_recovered"
                        );
                    }
                    return;
                }
                Err(crossbeam::TrySendError::Full(returned)) => {
                    // Drop the oldest queued frame and retry with this one.
                    if self.frame_rx.try_recv().is_ok() {
                        transport_stats()
                            .inbound_video_decode_dropped
                            .fetch_add(1, Ordering::Relaxed);
                        let dropped = self.dropped_frames.fetch_add(1, Ordering::Relaxed) + 1;
                        if dropped == 1 || dropped.is_multiple_of(100) {
                            warn!(
                                user_id = returned.user_id,
                                ssrc = returned.ssrc,
                                dropped_decode_frames = dropped,
                                "dropping oldest inbound video frame; decode thread is behind"
                            );
                        }
                    }
                    job = returned;
                }
                Err(crossbeam::TrySendError::Disconnected(_)) => {
                    error!("video decode worker thread is gone; dropping frame");
                    return;
                }
            }
        }
    }

    /// Drop the persistent decoder state for a user (video ended or the user
    /// left the channel).
    pub(crate) fn remove_user(&self, role: TransportRole, user_id: u64) {
        let _ = self
            .control_tx
            .send(VideoDecodeControl::RemoveUser(role, user_id));
    }

    pub(crate) fn clear_role(&self, role: TransportRole) {
        let _ = self.control_tx.send(VideoDecodeControl::ClearRole(role));
    }

    /// Collect pending decoder-reset PLI requests as `(user_id, ssrc)` pairs.
    pub(crate) fn drain_pli_requests(&self) -> Vec<(TransportRole, u64, u64, u32)> {
        let mut requests = Vec::new();
        while let Ok(request) = self.pli_rx.try_recv() {
            requests.push(request);
        }
        requests
    }
}

struct WorkerState {
    decoders: HashMap<(TransportRole, u64, u64), PersistentVideoDecoder>,
    last_emit_at: HashMap<(TransportRole, u64, u64), time::Instant>,
}

fn run_worker(
    frame_rx: &crossbeam::Receiver<VideoDecodeFrameJob>,
    control_rx: &crossbeam::Receiver<VideoDecodeControl>,
    pli_tx: &crossbeam::Sender<(TransportRole, u64, u64, u32)>,
) {
    let mut state = WorkerState {
        decoders: HashMap::new(),
        last_emit_at: HashMap::new(),
    };

    loop {
        // Apply control messages before the next frame so a RemoveUser/Clear
        // issued by the event loop is never reordered behind queued frames.
        while let Ok(control) = control_rx.try_recv() {
            handle_control(&mut state, &control);
        }

        crossbeam::select! {
            recv(control_rx) -> msg => match msg {
                Ok(control) => handle_control(&mut state, &control),
                Err(_) => break,
            },
            recv(frame_rx) -> msg => match msg {
                Ok(job) => handle_frame(&mut state, pli_tx, &job),
                Err(_) => break,
            },
        }
    }
    info!("video decode worker exited");
}

fn handle_control(state: &mut WorkerState, control: &VideoDecodeControl) {
    match control {
        VideoDecodeControl::RemoveUser(role, user_id) => {
            state.decoders.retain(|(entry_role, _, entry_user_id), _| {
                entry_role != role || entry_user_id != user_id
            });
            state
                .last_emit_at
                .retain(|(entry_role, _, entry_user_id), _| {
                    entry_role != role || entry_user_id != user_id
                });
        }
        VideoDecodeControl::ClearRole(role) => {
            state
                .decoders
                .retain(|(entry_role, _, _), _| entry_role != role);
            state
                .last_emit_at
                .retain(|(entry_role, _, _), _| entry_role != role);
        }
    }
}

fn handle_frame(
    state: &mut WorkerState,
    pli_tx: &crossbeam::Sender<(TransportRole, u64, u64, u32)>,
    job: &VideoDecodeFrameJob,
) {
    // Lazily create or retrieve the decoder.  If init fails, skip H264
    // decode for this user instead of panicking.
    let decoder = match state
        .decoders
        .entry((job.role, job.generation, job.user_id))
    {
        std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
        std::collections::hash_map::Entry::Vacant(entry) => match PersistentVideoDecoder::new() {
            Ok(decoder) => {
                info!(
                    user_id = job.user_id,
                    ssrc = job.ssrc,
                    jpeg_quality = job.jpeg_quality,
                    "clankvox_persistent_h264_decoder_created"
                );
                entry.insert(decoder)
            }
            Err(error) => {
                error!(
                    user_id = job.user_id,
                    error = %error,
                    "clankvox_persistent_h264_decoder_init_failed"
                );
                return;
            }
        },
    };
    decoder.set_jpeg_quality(job.jpeg_quality);

    // Feed EVERY frame to the decoder so it maintains full reference-frame
    // state.  Only rate-limit the JPEG encode + IPC emission below.
    let picture = decoder.decode_frame(&job.frame);

    // If the decoder was reset after sustained errors, it needs a fresh
    // keyframe — hand the PLI request back to the event loop, which owns
    // the transport connection.
    if decoder.take_pending_pli()
        && pli_tx
            .try_send((job.role, job.generation, job.user_id, job.ssrc))
            .is_err()
    {
        warn!(
            user_id = job.user_id,
            ssrc = job.ssrc,
            "clankvox_decoder_reset_pli_queue_full"
        );
    }
    let frames_decoded = decoder.frames_decoded();

    let Some(picture) = picture else {
        return;
    };

    // fps gate BEFORE the JPEG encode: rate-limited frames still update the
    // decoder's reference state but never pay the encode + base64 + IPC cost.
    let now = time::Instant::now();
    let min_gap =
        std::time::Duration::from_secs_f64(1.0 / f64::from(job.max_frames_per_second.max(1)));
    let should_emit = state
        .last_emit_at
        .get(&(job.role, job.generation, job.user_id))
        .is_none_or(|last| now.duration_since(*last) >= min_gap);
    if !should_emit {
        return;
    }
    state
        .last_emit_at
        .insert((job.role, job.generation, job.user_id), now);

    let Some(jpeg_data) = decoder.encode_jpeg(picture.width, picture.height) else {
        warn!(
            width = picture.width,
            height = picture.height,
            "clankvox_turbojpeg_encode_failed"
        );
        return;
    };

    if frames_decoded == 1 {
        info!(
            user_id = job.user_id,
            ssrc = job.ssrc,
            width = picture.width,
            height = picture.height,
            jpeg_bytes = jpeg_data.len(),
            "clankvox_first_h264_frame_decoded"
        );
    }

    let jpeg_base64 = base64::engine::general_purpose::STANDARD.encode(&jpeg_data);
    send_msg(OutMsg::DecodedVideoFrame {
        role: job.role,
        user_id: job.user_id.to_string(),
        width: picture.width,
        height: picture.height,
        jpeg_base64,
    });
}

#[cfg(test)]
mod tests {
    use super::{VideoDecodeFrameJob, VideoDecodeWorker};

    fn garbage_job(user_id: u64) -> VideoDecodeFrameJob {
        VideoDecodeFrameJob {
            role: crate::voice_conn::TransportRole::StreamWatch,
            generation: 1,
            user_id,
            ssrc: 4201,
            frame: vec![0x00, 0x00, 0x00, 0x01, 0xFF, 0xAB, 0xCD, 0xEF],
            jpeg_quality: 75,
            max_frames_per_second: 2,
        }
    }

    #[test]
    fn worker_accepts_frames_and_control_without_blocking_the_caller() {
        let worker = VideoDecodeWorker::spawn();
        for _ in 0..32 {
            worker.submit_frame(garbage_job(42));
        }
        worker.remove_user(crate::voice_conn::TransportRole::StreamWatch, 42);
        worker.clear_role(crate::voice_conn::TransportRole::StreamWatch);
        assert!(worker.drain_pli_requests().is_empty());
    }
}
