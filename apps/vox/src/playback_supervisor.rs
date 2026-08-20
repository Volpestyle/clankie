use base64::Engine as _;
use tokio::time;
use tracing::{info, warn};

use crate::app_state::{AppState, transport_stats};
use crate::audio_pipeline::{
    clear_audio_send_buffer, clear_music_send_buffer, clear_tts_send_buffer,
    convert_llm_to_48k_mono, emit_playback_armed, has_buffered_music_output,
    is_supported_llm_sample_rate, resume_music_output, suppress_music_output,
};
use crate::ipc::{
    ErrorCode, InMsg, MusicErrorCode, OutMsg, TtsPlaybackStatus, send_buffer_depth, send_error,
    send_msg, send_transport_error, send_transport_stats, send_tts_playback_state,
};
use crate::music::{MusicEvent, drain_music_pcm_queue, is_music_output_drained};
use crate::voice_conn::TransportRole;

impl AppState {
    fn mark_tts_playback_started(
        &mut self,
        frame_transmitted: bool,
        frame_contained_audible_tts: bool,
    ) -> Option<String> {
        if !frame_transmitted || !frame_contained_audible_tts || self.tts_playback_started {
            return None;
        }
        let playback_id = self.tts_playback_id.clone()?;
        self.tts_playback_started = true;
        Some(playback_id)
    }

    fn fail_tts_playback(&mut self, playback_id: &str, reason: &str) {
        if !self
            .failed_tts_playback_ids
            .iter()
            .any(|failed| failed == playback_id)
        {
            if self.failed_tts_playback_ids.len() >= crate::app_state::MAX_FAILED_TTS_PLAYBACK_IDS {
                self.failed_tts_playback_ids.pop_front();
            }
            self.failed_tts_playback_ids
                .push_back(playback_id.to_string());
        }
        if self.tts_playback_id.as_deref() == Some(playback_id) {
            clear_tts_send_buffer(&self.audio_send_state);
            self.tts_playback_id = None;
            self.tts_finish_pending = false;
            self.tts_playback_buffered = false;
            self.tts_playback_started = false;
        }
        send_tts_playback_state(playback_id, TtsPlaybackStatus::Failed, Some(reason));
    }

    pub(crate) fn handle_playback_command(&mut self, msg: InMsg) -> bool {
        match msg {
            InMsg::Audio {
                playback_id,
                pcm_base64,
                sample_rate,
            } => {
                if playback_id.is_empty() {
                    send_error(
                        ErrorCode::InvalidRequest,
                        "audio requires a non-empty playbackId",
                    );
                    return false;
                }
                if self.failed_tts_playback_ids.contains(&playback_id) {
                    send_tts_playback_state(
                        &playback_id,
                        TtsPlaybackStatus::Failed,
                        Some("playback_already_failed"),
                    );
                    return false;
                }
                if self
                    .tts_playback_id
                    .as_deref()
                    .is_some_and(|active| active != playback_id)
                    || self.tts_finish_pending
                {
                    self.fail_tts_playback(&playback_id, "stale_playback_id");
                    return false;
                }

                if self.music.active && !self.music.paused {
                    let is_ducked = {
                        let guard = self.audio_send_state.lock();
                        guard
                            .as_ref()
                            .is_some_and(crate::audio_pipeline::AudioSendState::is_music_ducked)
                    };
                    if !is_ducked {
                        self.fail_tts_playback(&playback_id, "music_not_ducked");
                        return false;
                    }
                }

                let engine = base64::engine::general_purpose::STANDARD;
                let Ok(mut raw) = engine.decode(&pcm_base64) else {
                    self.fail_tts_playback(&playback_id, "invalid_pcm_base64");
                    return false;
                };
                if !is_supported_llm_sample_rate(sample_rate) {
                    raw.fill(0);
                    send_error(
                        ErrorCode::InvalidRequest,
                        format!(
                            "audio sampleRate must be between 8000 and 48000 Hz, got {sample_rate}"
                        ),
                    );
                    self.fail_tts_playback(&playback_id, "invalid_sample_rate");
                    return false;
                }
                let mut samples = convert_llm_to_48k_mono(&raw, sample_rate);
                raw.fill(0);
                if samples.is_empty() {
                    self.fail_tts_playback(&playback_id, "empty_pcm");
                    return false;
                }
                let mut buffer_depth = None;
                let mut overflow = None;
                {
                    let mut guard = self.audio_send_state.lock();
                    if let Some(ref mut state) = *guard {
                        match state.push_pcm(samples) {
                            Ok(()) => {
                                buffer_depth = Some((
                                    state.tts_buffer_samples(),
                                    state.music_buffer_samples(),
                                ));
                            }
                            Err(error) => overflow = Some(error),
                        }
                    } else {
                        samples.fill(0);
                    }
                }
                if let Some(overflow) = overflow {
                    send_msg(OutMsg::TtsBufferOverflow {
                        playback_id: playback_id.clone(),
                        dropped_samples: overflow.dropped_samples,
                        dropped_ms: overflow.dropped_ms,
                        buffer_samples: overflow.buffer_samples,
                        buffer_ms: overflow.buffer_ms,
                    });
                    self.fail_tts_playback(&playback_id, "tts_buffer_overflow");
                    return false;
                }
                let Some((tts, music)) = buffer_depth else {
                    self.fail_tts_playback(&playback_id, "voice_transport_not_ready");
                    return false;
                };
                if self.tts_playback_id.is_none() {
                    self.tts_playback_started = false;
                }
                self.tts_playback_id = Some(playback_id.clone());
                send_buffer_depth(tts, music, "tts_pcm_enqueued");
                if !self.tts_playback_buffered {
                    self.tts_playback_buffered = true;
                    send_tts_playback_state(&playback_id, TtsPlaybackStatus::Buffered, None);
                }
                false
            }
            InMsg::StopPlayback => {
                let music_id = self.music.music_id.clone();
                self.music.reset();
                drain_music_pcm_queue(&self.music_pcm_rx);
                clear_audio_send_buffer(&self.audio_send_state);
                if let Some(playback_id) = self.tts_playback_id.take() {
                    send_tts_playback_state(
                        &playback_id,
                        TtsPlaybackStatus::Stopped,
                        Some("stop_playback"),
                    );
                }
                self.tts_finish_pending = false;
                self.tts_playback_buffered = false;
                self.tts_playback_started = false;
                send_msg(OutMsg::PlayerState {
                    status: "idle".into(),
                    music_id: music_id.clone(),
                });
                if let Some(music_id) = music_id {
                    send_msg(OutMsg::MusicIdle { music_id });
                }
                emit_playback_armed("stop_playback", &self.audio_send_state);
                false
            }
            InMsg::FinishTtsPlayback { playback_id } => {
                if self.tts_playback_id.as_deref() == Some(playback_id.as_str())
                    && !self.tts_finish_pending
                {
                    self.tts_finish_pending = true;
                } else {
                    self.fail_tts_playback(&playback_id, "stale_playback_id");
                }
                false
            }
            InMsg::StopTtsPlayback { playback_id } => {
                if self.tts_playback_id.as_deref() != Some(playback_id.as_str()) {
                    self.fail_tts_playback(&playback_id, "stale_playback_id");
                    return false;
                }
                clear_tts_send_buffer(&self.audio_send_state);
                self.tts_playback_id = None;
                self.tts_finish_pending = false;
                self.tts_playback_buffered = false;
                self.tts_playback_started = false;
                send_tts_playback_state(
                    &playback_id,
                    TtsPlaybackStatus::Stopped,
                    Some("stop_tts_playback"),
                );
                false
            }
            InMsg::MusicPlay {
                music_id,
                url,
                resolved_direct_url,
            } => {
                let normalized_url = url.trim().to_string();
                if music_id.is_empty() || normalized_url.is_empty() {
                    send_msg(OutMsg::MusicError {
                        music_id,
                        code: MusicErrorCode::PipelineFailed,
                        message: "music_play requires non-empty musicId and url".to_string(),
                    });
                    return false;
                }

                clear_music_send_buffer(&self.audio_send_state);
                self.music.start(
                    music_id.clone(),
                    normalized_url.clone(),
                    resolved_direct_url,
                );
                self.start_music_pipeline(&music_id, &normalized_url, resolved_direct_url, false);
                send_msg(OutMsg::PlayerState {
                    status: "loading".into(),
                    music_id: Some(music_id),
                });
                tracing::info!("music_play started direct={}", resolved_direct_url);
                false
            }
            InMsg::MusicStop { music_id } => {
                if self.music.music_id.as_deref() != Some(music_id.as_str()) {
                    return false;
                }
                if self.music.player.is_some() && self.music.active {
                    let mut guard = self.audio_send_state.lock();
                    if let Some(ref mut state) = *guard {
                        let _ = state.set_music_gain(0.0, 300);
                    }
                    self.music.pending_stop = true;
                } else {
                    self.music.reset();
                    drain_music_pcm_queue(&self.music_pcm_rx);
                    clear_music_send_buffer(&self.audio_send_state);
                    send_msg(OutMsg::PlayerState {
                        status: "idle".into(),
                        music_id: Some(music_id.clone()),
                    });
                    send_msg(OutMsg::MusicIdle { music_id });
                    emit_playback_armed("music_stop", &self.audio_send_state);
                }
                false
            }
            InMsg::MusicPause { music_id } => {
                if self.music.music_id.as_deref() != Some(music_id.as_str()) {
                    return false;
                }
                self.music.pending_stop = false;
                let was_finishing = self.music.finishing;
                let player_alive = self
                    .music
                    .player
                    .as_ref()
                    .is_some_and(crate::music::MusicPlayer::is_alive);
                let buffered_music_output = !self.music_pcm_rx.is_empty()
                    || has_buffered_music_output(&self.audio_send_state);
                info!(
                    "music_pause: player_alive={} active={} was_finishing={} buffered_output={}",
                    player_alive, self.music.active, was_finishing, buffered_music_output
                );
                if !self
                    .music
                    .player
                    .as_ref()
                    .is_none_or(crate::music::MusicPlayer::pause)
                {
                    warn!("music_pause: failed to pause music process group");
                }
                self.music.paused = true;
                self.music.active = false;
                self.music.finishing = was_finishing || (!player_alive && buffered_music_output);
                suppress_music_output(&self.audio_send_state);
                send_msg(OutMsg::PlayerState {
                    status: "paused".into(),
                    music_id: Some(music_id),
                });
                emit_playback_armed("music_pause", &self.audio_send_state);
                false
            }
            InMsg::MusicResume { music_id } => {
                if self.music.music_id.as_deref() != Some(music_id.as_str()) {
                    return false;
                }
                self.music.pending_stop = false;
                self.music.finishing = false;

                let player_alive = self
                    .music
                    .player
                    .as_ref()
                    .is_some_and(crate::music::MusicPlayer::is_alive);
                let resumed_in_place = player_alive
                    && self
                        .music
                        .player
                        .as_ref()
                        .is_some_and(crate::music::MusicPlayer::resume);
                let buffered_music_output = !self.music_pcm_rx.is_empty()
                    || has_buffered_music_output(&self.audio_send_state);

                if resumed_in_place {
                    info!("music_resume: player alive, resuming from position");
                    resume_music_output(&self.audio_send_state);
                    self.music.paused = false;
                    self.music.active = self.music.first_pcm_seen;
                    send_msg(OutMsg::PlayerState {
                        status: if self.music.active {
                            "playing".into()
                        } else {
                            "loading".into()
                        },
                        music_id: Some(music_id.clone()),
                    });
                } else if !player_alive && buffered_music_output {
                    info!(
                        "music_resume: player dead, resuming buffered output from current position"
                    );
                    resume_music_output(&self.audio_send_state);
                    self.music.paused = false;
                    self.music.active = true;
                    self.music.finishing = true;
                    send_msg(OutMsg::PlayerState {
                        status: "playing".into(),
                        music_id: Some(music_id.clone()),
                    });
                } else if self.music.player.is_some() {
                    let _ = self
                        .music
                        .player
                        .as_ref()
                        .is_some_and(crate::music::MusicPlayer::resume);
                    resume_music_output(&self.audio_send_state);
                    self.music.paused = false;
                    self.music.active = false;
                    send_msg(OutMsg::PlayerState {
                        status: "loading".into(),
                        music_id: Some(music_id.clone()),
                    });
                } else if let Some(url) = self.music.active_url.clone() {
                    self.music.stop_player();
                    warn!(
                        "music_resume: player dead, restarting pipeline direct={}",
                        self.music.active_resolved_direct_url
                    );
                    self.start_music_pipeline(
                        &music_id,
                        &url,
                        self.music.active_resolved_direct_url,
                        true,
                    );
                    self.music.paused = false;
                    self.music.active = true;
                    send_msg(OutMsg::PlayerState {
                        status: "playing".into(),
                        music_id: Some(music_id),
                    });
                } else {
                    warn!("music_resume: no player and no url, cannot resume");
                }
                false
            }
            InMsg::MusicSetGain {
                music_id,
                target,
                fade_ms,
            } => {
                if self.music.music_id.as_deref() != Some(music_id.as_str()) {
                    return false;
                }
                let clamped = target.clamp(0.0, 1.0);
                self.music.desired_gain = clamped;
                let mut guard = self.audio_send_state.lock();
                if let Some(ref mut state) = *guard
                    && let Some(reached) = state.set_music_gain(clamped, fade_ms)
                {
                    drop(guard);
                    send_msg(OutMsg::MusicGainReached {
                        music_id,
                        gain: reached,
                    });
                }
                false
            }
            InMsg::Destroy => {
                self.clear_primary_playback("destroy");
                self.stream_publish.reset();
                self.clear_voice_connection();
                self.clear_stream_watch_connection();
                self.clear_stream_publish_connection();
                true
            }
            _ => unreachable!("non-playback IPC command routed to playback supervisor"),
        }
    }

    pub(crate) fn handle_music_event(&mut self, event: MusicEvent) {
        match event {
            MusicEvent::Idle { music_id } => {
                if self.music.music_id.as_deref() != Some(music_id.as_str()) {
                    return;
                }
                info!(
                    "music_event_idle: active={} paused={} finishing={}",
                    self.music.active, self.music.paused, self.music.finishing
                );
                self.music.stop_player();
                self.music.paused = false;
                self.music.finishing = self.music.active;
                self.music.pending_stop = false;
                if !self.music.finishing {
                    self.music.music_id = None;
                    self.music.active_url = None;
                    self.music.active_resolved_direct_url = false;
                    self.music.first_pcm_seen = false;
                    send_msg(OutMsg::PlayerState {
                        status: "idle".into(),
                        music_id: Some(music_id.clone()),
                    });
                    send_msg(OutMsg::MusicIdle { music_id });
                    emit_playback_armed("music_idle", &self.audio_send_state);
                }
            }
            MusicEvent::Error {
                music_id,
                code,
                diagnostic,
            } => {
                if self.music.music_id.as_deref() != Some(music_id.as_str()) {
                    return;
                }
                self.music.reset();
                drain_music_pcm_queue(&self.music_pcm_rx);
                clear_music_send_buffer(&self.audio_send_state);
                send_msg(OutMsg::MusicError {
                    music_id: music_id.clone(),
                    code,
                    message: diagnostic,
                });
                send_msg(OutMsg::PlayerState {
                    status: "idle".into(),
                    music_id: Some(music_id),
                });
                emit_playback_armed("music_error", &self.audio_send_state);
            }
            MusicEvent::FirstPcm {
                music_id,
                startup_ms,
                resolved_direct_url,
            } => {
                if self.music.music_id.as_deref() != Some(music_id.as_str()) {
                    return;
                }
                self.music.active = !self.music.paused;
                self.music.first_pcm_seen = true;
                if self.music.active {
                    let mut guard = self.audio_send_state.lock();
                    if let Some(ref mut state) = *guard {
                        state.begin_music_fade_in(self.music.desired_gain, 1500);
                    }
                }
                send_msg(OutMsg::PlayerState {
                    status: if self.music.paused {
                        "paused".into()
                    } else {
                        "playing".into()
                    },
                    music_id: Some(music_id),
                });
                tracing::info!(
                    "music_play started direct={} startupMs={}",
                    resolved_direct_url,
                    startup_ms
                );
            }
        }
    }

    /// Complete a pending stop once the music gain fade-out finishes: reset
    /// music state, drain queues, clear audio buffers, and notify the TS side.
    fn tick_pending_stop(&mut self) {
        if !self.music.pending_stop {
            return;
        }
        let fade_done = {
            let guard = self.audio_send_state.lock();
            guard
                .as_ref()
                .is_none_or(crate::audio_pipeline::AudioSendState::is_music_fade_out_complete)
        };
        if fade_done {
            let music_id = self.music.music_id.clone();
            self.music.reset();
            drain_music_pcm_queue(&self.music_pcm_rx);
            clear_music_send_buffer(&self.audio_send_state);
            send_msg(OutMsg::PlayerState {
                status: "idle".into(),
                music_id: music_id.clone(),
            });
            if let Some(music_id) = music_id {
                send_msg(OutMsg::MusicIdle { music_id });
            }
            emit_playback_armed("music_stop", &self.audio_send_state);
        }
    }

    /// Periodically report TTS/music buffer depth to the TS side and
    /// synchronise the `tts_playback_buffered` flag with actual buffer state.
    fn tick_buffer_depth_report(&mut self) {
        self.buffer_depth_tick_counter += 1;
        if self.buffer_depth_tick_counter < Self::BUFFER_DEPTH_REPORT_INTERVAL {
            return;
        }
        self.buffer_depth_tick_counter = 0;

        let guard = self.audio_send_state.lock();
        if let Some(ref state) = *guard {
            let tts = state.tts_buffer_samples();
            let music = state.music_buffer_samples();
            if tts > 0 || music > 0 {
                self.buffer_depth_was_nonempty = true;
                drop(guard);
                send_buffer_depth(tts, music, "periodic_nonempty");
            } else if self.buffer_depth_was_nonempty {
                self.buffer_depth_was_nonempty = false;
                drop(guard);
                send_buffer_depth(0, 0, "periodic_drained");
            }
        } else if self.buffer_depth_was_nonempty {
            self.buffer_depth_was_nonempty = false;
            drop(guard);
            send_buffer_depth(0, 0, "audio_send_state_missing");
        }
    }

    fn tick_transport_stats_report(&mut self) {
        let transport_connected = self.voice_conn.is_some()
            || self.stream_watch_conn.is_some()
            || self.stream_publish_conn.is_some();
        if !transport_connected {
            self.transport_stats_tick_counter = 0;
            return;
        }

        self.transport_stats_tick_counter += 1;
        if self.transport_stats_tick_counter < Self::TRANSPORT_STATS_REPORT_INTERVAL {
            return;
        }
        self.transport_stats_tick_counter = 0;

        send_transport_stats(transport_stats().snapshot(), "periodic");
    }

    pub(crate) async fn on_audio_tick(&mut self) {
        let now = time::Instant::now();
        self.on_capture_tick(now);
        self.drain_stream_publish_runtime_events();

        if self.music.active && !self.music.paused {
            let mut guard = self.audio_send_state.lock();
            if let Some(ref mut state) = *guard {
                while state.can_accept_music_chunk() {
                    let Ok(mut chunk) = self.music_pcm_rx.try_recv() else {
                        break;
                    };
                    if self.music.music_id.as_deref() == Some(chunk.music_id.as_str()) {
                        state.push_music_pcm(chunk.samples);
                    } else {
                        chunk.samples.fill(0);
                    }
                }
            }
        }

        if self.music.finishing
            && is_music_output_drained(&self.music_pcm_rx, &self.audio_send_state)
        {
            let music_id = self.music.music_id.take();
            self.music.finishing = false;
            self.music.active = false;
            self.music.paused = false;
            self.music.active_url = None;
            self.music.active_resolved_direct_url = false;
            self.music.first_pcm_seen = false;
            send_msg(OutMsg::PlayerState {
                status: "idle".into(),
                music_id: music_id.clone(),
            });
            if let Some(music_id) = music_id {
                send_msg(OutMsg::MusicIdle { music_id });
            }
            emit_playback_armed("music_idle", &self.audio_send_state);
        }

        {
            let mut guard = self.audio_send_state.lock();
            if let Some(ref mut state) = *guard
                && let Some(reached) = state.maybe_take_music_gain_reached()
                && let Some(music_id) = self.music.music_id.clone()
            {
                drop(guard);
                send_msg(OutMsg::MusicGainReached {
                    music_id,
                    gain: reached,
                });
            }
        }

        self.tick_pending_stop();
        self.tick_buffer_depth_report();
        self.tick_transport_stats_report();

        let (opus_frame, opus_frame_contained_audible_tts) = {
            let mut guard = self.audio_send_state.lock();
            match *guard {
                Some(ref mut state) => {
                    let frame = state.next_opus_frame();
                    let contained_audible_tts =
                        frame.is_some() && state.last_frame_contained_audible_tts();
                    (frame, contained_audible_tts)
                }
                None => (None, false),
            }
        };

        let mut opus_send_failed = false;
        let mut opus_frame_transmitted = false;
        if let Some(opus) = opus_frame {
            if let Some(encrypted) = self.encrypt_outbound_opus(opus) {
                if let Some(ref conn) = self.voice_conn {
                    if let Err(error) = conn.send_rtp_frame(&encrypted).await {
                        tracing::debug!("RTP send error: {}", error);
                        opus_send_failed = true;
                    } else {
                        opus_frame_transmitted = true;
                        transport_stats()
                            .outbound_rtp_audio_sent
                            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    }
                } else {
                    opus_send_failed = true;
                }
            } else {
                opus_send_failed = true;
            }
        }

        if opus_send_failed {
            if let Some(playback_id) = self.tts_playback_id.clone() {
                self.fail_tts_playback(&playback_id, "transport_send_failed");
            }
        } else {
            if let Some(playback_id) = self
                .mark_tts_playback_started(opus_frame_transmitted, opus_frame_contained_audible_tts)
            {
                send_tts_playback_state(&playback_id, TtsPlaybackStatus::Started, None);
            }
        }

        if !opus_send_failed && self.tts_finish_pending {
            let drained = self
                .audio_send_state
                .lock()
                .as_ref()
                .is_none_or(crate::audio_pipeline::AudioSendState::tts_is_fully_drained);
            if drained && let Some(playback_id) = self.tts_playback_id.take() {
                self.tts_finish_pending = false;
                self.tts_playback_buffered = false;
                self.tts_playback_started = false;
                send_tts_playback_state(&playback_id, TtsPlaybackStatus::Drained, None);
            }
        }

        self.send_pending_stream_publish_frame().await;
    }

    /// DAVE-encrypt an outbound opus frame.  Fails closed: with a ready DAVE
    /// session, a frame that cannot be encrypted must never leave as
    /// plaintext — it is dropped (`None`), consecutive failures are counted,
    /// and a structured IPC error is raised once the streak crosses the
    /// alert threshold.
    fn encrypt_outbound_opus(&mut self, opus: Vec<u8>) -> Option<Vec<u8>> {
        let mut guard = self.dave.lock();
        match *guard {
            Some(ref mut dave_manager) if dave_manager.is_ready() => {
                match dave_manager.encrypt_opus(&opus) {
                    Ok(encrypted) => {
                        self.dave_audio_encrypt_failures = 0;
                        Some(encrypted)
                    }
                    Err(error) => {
                        transport_stats()
                            .outbound_dave_encrypt_fail
                            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        self.dave_audio_encrypt_failures =
                            self.dave_audio_encrypt_failures.saturating_add(1);
                        let failures = self.dave_audio_encrypt_failures;
                        if failures == 1 || failures.is_multiple_of(100) {
                            warn!(
                                consecutive_failures = failures,
                                error = %error,
                                "DAVE opus encrypt failed; dropping outbound audio frame"
                            );
                        }
                        if failures == crate::app_state::DAVE_ENCRYPT_FAILURE_ALERT_THRESHOLD {
                            send_transport_error(
                                ErrorCode::VoiceRuntimeError,
                                TransportRole::Voice,
                                self.connection_id.as_deref(),
                                format!(
                                    "DAVE opus encrypt failed {failures} times in a row; dropping outbound audio"
                                ),
                            );
                        }
                        None
                    }
                }
            }
            // DAVE absent or still handshaking — plaintext is the
            // protocol-correct output in this window.
            _ => Some(opus),
        }
    }
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use crossbeam_channel as crossbeam;
    use parking_lot::Mutex;
    use std::sync::Arc;
    use tokio::sync::mpsc;

    use super::AppState;
    use crate::audio_pipeline::{
        AUDIO_FRAME_SAMPLES, AudioSendState, MAX_MUSIC_BUFFER_SAMPLES, MAX_PCM_BUFFER_SAMPLES,
    };
    use crate::ipc::InMsg;
    use crate::music::{MusicEvent, MusicPcm};
    use crate::stream_publish::{StreamPublishEvent, StreamPublishFrame};

    fn make_app_state_with_music_queue_capacity(queue_capacity: usize) -> AppState {
        let (_voice_event_tx, voice_event_rx) = mpsc::channel(4);
        drop(voice_event_rx);
        let (music_event_tx, music_event_rx) = mpsc::channel(4);
        drop(music_event_rx);

        let audio_send_state = Arc::new(Mutex::new(Some(
            AudioSendState::new().expect("audio state"),
        )));
        let (music_pcm_tx, music_pcm_rx) = crossbeam::bounded::<MusicPcm>(queue_capacity);
        let (stream_publish_frame_tx, stream_publish_frame_rx) =
            crossbeam::bounded::<StreamPublishFrame>(4);
        let (stream_publish_event_tx, stream_publish_event_rx) =
            crossbeam::bounded::<StreamPublishEvent>(4);

        AppState::new(
            Arc::new(Mutex::new(None)),
            _voice_event_tx,
            audio_send_state,
            music_pcm_tx,
            music_pcm_rx,
            music_event_tx,
            stream_publish_frame_tx,
            stream_publish_frame_rx,
            stream_publish_event_tx,
            stream_publish_event_rx,
        )
    }

    fn make_app_state() -> AppState {
        make_app_state_with_music_queue_capacity(4)
    }

    #[test]
    fn tts_finish_is_ordered_after_pcm_and_stop_is_playback_scoped() {
        let mut state = make_app_state();
        let pcm = [1_u8, 0].repeat(960);
        let pcm_base64 = base64::engine::general_purpose::STANDARD.encode(pcm);

        assert!(!state.handle_playback_command(InMsg::Audio {
            playback_id: "playback-1".into(),
            pcm_base64: pcm_base64.clone(),
            sample_rate: 24_000,
        }));
        assert!(!state.handle_playback_command(InMsg::FinishTtsPlayback {
            playback_id: "playback-1".into(),
        }));
        assert_eq!(state.tts_playback_id.as_deref(), Some("playback-1"));
        assert!(state.tts_finish_pending);
        assert!(
            state
                .audio_send_state
                .lock()
                .as_ref()
                .is_some_and(|audio| audio.tts_buffer_samples() > 0)
        );

        assert!(!state.handle_playback_command(InMsg::Audio {
            playback_id: "stale-playback".into(),
            pcm_base64,
            sample_rate: 24_000,
        }));
        assert_eq!(state.tts_playback_id.as_deref(), Some("playback-1"));

        assert!(!state.handle_playback_command(InMsg::StopTtsPlayback {
            playback_id: "playback-1".into(),
        }));
        assert!(state.tts_playback_id.is_none());
        assert!(!state.tts_finish_pending);
        assert!(
            state
                .audio_send_state
                .lock()
                .as_ref()
                .is_some_and(|audio| audio.tts_buffer_samples() == 0)
        );
    }

    #[test]
    fn tts_started_requires_a_transmitted_tts_frame_and_emits_once() {
        let mut state = make_app_state();
        state.tts_playback_id = Some("playback-1".into());

        assert_eq!(state.mark_tts_playback_started(false, true), None);
        assert_eq!(state.mark_tts_playback_started(true, false), None);
        assert_eq!(
            state.mark_tts_playback_started(true, true).as_deref(),
            Some("playback-1")
        );
        assert_eq!(state.mark_tts_playback_started(true, true), None);
    }

    #[test]
    fn failed_tts_playback_tombstones_are_bounded_and_reject_late_audio() {
        let mut state = make_app_state();
        for index in 0..crate::app_state::MAX_FAILED_TTS_PLAYBACK_IDS + 8 {
            state.fail_tts_playback(&format!("failed-{index}"), "test_failure");
        }

        assert_eq!(
            state.failed_tts_playback_ids.len(),
            crate::app_state::MAX_FAILED_TTS_PLAYBACK_IDS
        );
        assert!(!state.failed_tts_playback_ids.contains(&"failed-0".into()));
        let latest = format!(
            "failed-{}",
            crate::app_state::MAX_FAILED_TTS_PLAYBACK_IDS + 7
        );
        assert!(state.failed_tts_playback_ids.contains(&latest));

        let pcm_base64 = base64::engine::general_purpose::STANDARD.encode([1_u8, 0].repeat(960));
        state.handle_playback_command(InMsg::Audio {
            playback_id: latest,
            pcm_base64,
            sample_rate: 24_000,
        });
        assert!(state.tts_playback_id.is_none());
    }

    #[test]
    fn policy_approved_music_starts_without_waiting_for_tts() {
        let mut state = make_app_state();
        state
            .music
            .start("music-1".into(), "https://example.com/live".into(), false);

        assert!(!state.music.active, "music remains loading until first PCM");
        assert_eq!(state.music.music_id.as_deref(), Some("music-1"));
        assert_eq!(
            state.music.active_url.as_deref(),
            Some("https://example.com/live")
        );
    }

    #[test]
    fn pause_before_first_pcm_remains_paused_when_pipeline_starts() {
        let mut state = make_app_state();
        state
            .music
            .start("music-1".into(), "https://example.com/live".into(), false);

        state.handle_playback_command(InMsg::MusicPause {
            music_id: "music-1".into(),
        });
        state.handle_music_event(MusicEvent::FirstPcm {
            music_id: "music-1".into(),
            startup_ms: 10,
            resolved_direct_url: false,
        });

        assert!(state.music.paused);
        assert!(!state.music.active);
        assert!(
            state
                .audio_send_state
                .lock()
                .as_ref()
                .is_some_and(AudioSendState::is_music_output_suppressed)
        );
    }

    #[test]
    fn resume_before_first_pcm_stays_loading_until_pcm_arrives() {
        let mut state = make_app_state();
        state
            .music
            .start("music-1".into(), "https://example.com/live".into(), false);
        state.music.player = Some(crate::music::MusicPlayer::pending_for_test());

        state.handle_playback_command(InMsg::MusicPause {
            music_id: "music-1".into(),
        });
        state.handle_playback_command(InMsg::MusicResume {
            music_id: "music-1".into(),
        });

        assert!(!state.music.paused);
        assert!(!state.music.active);
        assert!(!state.music.first_pcm_seen);

        state.handle_music_event(MusicEvent::FirstPcm {
            music_id: "music-1".into(),
            startup_ms: 10,
            resolved_direct_url: false,
        });
        assert!(state.music.active);
        assert!(state.music.first_pcm_seen);
    }

    #[test]
    fn duck_before_first_pcm_is_not_overwritten_by_fade_in() {
        let mut state = make_app_state();
        state
            .music
            .start("music-1".into(), "https://example.com/live".into(), false);

        state.handle_playback_command(InMsg::MusicSetGain {
            music_id: "music-1".into(),
            target: 0.2,
            fade_ms: 150,
        });
        state.handle_music_event(MusicEvent::FirstPcm {
            music_id: "music-1".into(),
            startup_ms: 10,
            resolved_direct_url: false,
        });

        assert!((state.music.desired_gain - 0.2).abs() < f32::EPSILON);
        assert!(
            state
                .audio_send_state
                .lock()
                .as_ref()
                .is_some_and(|audio| (audio.music_gain_target() - 0.2).abs() < f32::EPSILON)
        );
    }

    #[test]
    fn stop_before_first_pcm_prevents_stale_pipeline_start() {
        let mut state = make_app_state();
        state
            .music
            .start("music-1".into(), "https://example.com/live".into(), false);

        state.handle_playback_command(InMsg::MusicStop {
            music_id: "music-1".into(),
        });
        state.handle_music_event(MusicEvent::FirstPcm {
            music_id: "music-1".into(),
            startup_ms: 10,
            resolved_direct_url: false,
        });

        assert!(state.music.music_id.is_none());
        assert!(!state.music.active);
    }

    #[test]
    fn tts_overflow_fails_the_playback_and_clears_all_pcm() {
        let mut state = make_app_state();
        let input_samples = MAX_PCM_BUFFER_SAMPLES / 2 + 1;
        let pcm_base64 =
            base64::engine::general_purpose::STANDARD.encode([1_u8, 0].repeat(input_samples));

        state.handle_playback_command(InMsg::Audio {
            playback_id: "overflowed-playback".into(),
            pcm_base64,
            sample_rate: 24_000,
        });

        assert!(state.tts_playback_id.is_none());
        assert!(
            state
                .failed_tts_playback_ids
                .iter()
                .any(|playback_id| playback_id == "overflowed-playback")
        );
        assert_eq!(
            state
                .audio_send_state
                .lock()
                .as_ref()
                .map(AudioSendState::tts_buffer_samples),
            Some(0)
        );
        state.handle_playback_command(InMsg::FinishTtsPlayback {
            playback_id: "overflowed-playback".into(),
        });
        assert!(!state.tts_finish_pending);
    }

    #[test]
    fn stale_music_lifecycle_cannot_advance_current_track() {
        let mut state = make_app_state();
        state
            .music
            .start("music-new".into(), "https://example.com/new".into(), false);
        state.music.active = true;

        state.handle_music_event(MusicEvent::Idle {
            music_id: "music-old".into(),
        });

        assert!(state.music.active);
        assert_eq!(state.music.music_id.as_deref(), Some("music-new"));
    }

    #[test]
    fn wake_word_pause_preserves_buffered_music_tail_when_player_is_dead() {
        let mut state = make_app_state();
        {
            let mut guard = state.audio_send_state.lock();
            let audio_state = guard.as_mut().expect("audio state");
            audio_state.push_music_pcm(vec![123; 960]);
        }
        state.music.active = true;
        state.music.finishing = true;
        state.music.music_id = Some("music-1".into());
        state.music.active_url = Some("https://cdn.example.com/track.mp4".to_string());
        state.music.active_resolved_direct_url = true;

        assert!(!state.handle_playback_command(InMsg::MusicPause {
            music_id: "music-1".into(),
        }));
        assert!(state.music.paused);
        assert!(!state.music.active);
        assert!(state.music.finishing);
        {
            let guard = state.audio_send_state.lock();
            let audio_state = guard.as_ref().expect("audio state");
            assert_eq!(audio_state.music_buffer_samples(), 960);
            assert!(audio_state.is_music_output_suppressed());
        }

        assert!(!state.handle_playback_command(InMsg::MusicResume {
            music_id: "music-1".into(),
        }));
        assert!(
            state.music.player.is_none(),
            "buffered resume should not restart the pipeline"
        );
        assert!(!state.music.paused);
        assert!(state.music.active);
        assert!(state.music.finishing);
        {
            let mut guard = state.audio_send_state.lock();
            let audio_state = guard.as_mut().expect("audio state");
            assert!(!audio_state.is_music_output_suppressed());
            let frame = audio_state
                .next_opus_frame()
                .expect("buffered music should resume from preserved PCM");
            assert!(!frame.is_empty());
            assert_eq!(audio_state.music_buffer_samples(), 0);
        }
    }

    #[tokio::test]
    async fn on_audio_tick_caps_music_prefetch_to_live_window() {
        let mut state = make_app_state_with_music_queue_capacity(128);
        state.music.active = true;
        state.music.music_id = Some("music-1".into());

        for _ in 0..128 {
            state
                .music_pcm_tx
                .send(MusicPcm {
                    music_id: "music-1".into(),
                    samples: vec![321; AUDIO_FRAME_SAMPLES],
                })
                .expect("queue music chunk");
        }

        state.on_audio_tick().await;

        {
            let guard = state.audio_send_state.lock();
            let audio_state = guard.as_ref().expect("audio state");
            assert_eq!(
                audio_state.music_buffer_samples(),
                MAX_MUSIC_BUFFER_SAMPLES - AUDIO_FRAME_SAMPLES
            );
        }
        assert!(
            state.music_pcm_rx.len() > 0,
            "backpressure should leave upstream music PCM queued instead of draining the full track"
        );
    }
}
