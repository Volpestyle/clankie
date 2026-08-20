use crate::app_state::{AppState, PendingConnection, TryConnectOutcome};
use crate::ipc::{
    ErrorCode, InMsg, OutMsg, send_error, send_gateway_voice_leave, send_msg, send_transport_error,
};
use crate::voice_conn::{TransportRole, VoiceConnection, VoiceConnectionParams};

impl AppState {
    fn reset_primary_transport(&mut self, reason: &str) {
        self.reset_reconnect();
        self.clear_primary_playback(reason);
        self.clear_voice_connection();
        self.clear_primary_runtime_state(reason);
    }

    fn settle_primary_transport(&self, reason: &str) {
        let Some(connection_id) = self.connection_id.clone() else {
            return;
        };
        send_msg(OutMsg::ConnectionState {
            status: "disconnected".into(),
            connection_id,
        });
        self.emit_transport_state(TransportRole::Voice, "disconnected", Some(reason));
    }

    fn leave_primary_voice(&mut self, reason: &str, notify_gateway: bool) {
        if notify_gateway && let Some(guild_id) = self.guild_id {
            send_gateway_voice_leave(guild_id, self.self_mute);
        }
        self.reset_primary_transport(reason);
        self.pending_conn = PendingConnection::default();
        self.guild_id = None;
        self.channel_id = None;
        self.self_mute = false;
        self.settle_primary_transport(reason);
        self.connection_id = None;
    }

    async fn maybe_try_connect(&mut self, failure_reason: &str, source: &str) {
        if self.reconnect_deadline.is_some() {
            tracing::info!(
                source = source,
                "Reconnect already scheduled; deferring immediate voice connect"
            );
            return;
        }

        let outcome = self.try_connect().await;
        self.apply_connect_outcome(outcome, failure_reason);
    }

    pub(crate) fn apply_connect_outcome(
        &mut self,
        outcome: TryConnectOutcome,
        failure_reason: &str,
    ) {
        match outcome {
            TryConnectOutcome::Connected => self.reset_reconnect(),
            TryConnectOutcome::Failed => self.schedule_reconnect(failure_reason),
            TryConnectOutcome::AlreadyConnected | TryConnectOutcome::MissingData => {}
        }
    }

    pub(crate) async fn try_connect(&mut self) -> TryConnectOutcome {
        if self.voice_conn.is_some() {
            return TryConnectOutcome::AlreadyConnected;
        }
        let Some(guild_id) = self.guild_id else {
            return TryConnectOutcome::MissingData;
        };
        let Some(channel_id) = self.channel_id else {
            return TryConnectOutcome::MissingData;
        };
        let Some(user_id) = self.pending_conn.user_id else {
            return TryConnectOutcome::MissingData;
        };
        let Some(endpoint) = self.pending_conn.endpoint.as_deref() else {
            return TryConnectOutcome::MissingData;
        };
        let Some(session_id) = self.pending_conn.session_id.as_deref() else {
            return TryConnectOutcome::MissingData;
        };
        let Some(token) = self.pending_conn.token.as_deref() else {
            return TryConnectOutcome::MissingData;
        };

        tracing::info!(
            guild_id,
            channel_id,
            user_id,
            "Connecting primary voice transport"
        );

        match VoiceConnection::connect(
            VoiceConnectionParams {
                endpoint,
                server_id: guild_id,
                user_id,
                session_id,
                token,
                dave_channel_id: channel_id,
                role: TransportRole::Voice,
                generation: self.current_transport_generation(TransportRole::Voice),
            },
            self.voice_event_tx.clone(),
            self.dave.clone(),
        )
        .await
        {
            Ok(conn) => {
                self.voice_conn = Some(conn);
                TryConnectOutcome::Connected
            }
            Err(error) => {
                tracing::error!("Voice connection failed: {error}");
                send_transport_error(
                    ErrorCode::VoiceConnectFailed,
                    TransportRole::Voice,
                    self.connection_id.as_deref(),
                    format!("Voice connect failed: {error}"),
                );
                TryConnectOutcome::Failed
            }
        }
    }

    async fn try_connect_stream(&mut self, role: TransportRole) -> TryConnectOutcome {
        let (pending, connected, dave, error_code, label) = match role {
            TransportRole::StreamWatch => (
                self.stream_watch_pending_conn.clone(),
                self.stream_watch_conn.is_some(),
                self.stream_watch_dave.clone(),
                ErrorCode::StreamWatchConnectFailed,
                "Stream watch",
            ),
            TransportRole::StreamPublish => (
                self.stream_publish_pending_conn.clone(),
                self.stream_publish_conn.is_some(),
                self.stream_publish_dave.clone(),
                ErrorCode::StreamPublishConnectFailed,
                "Stream publish",
            ),
            TransportRole::Voice => unreachable!("primary voice uses try_connect"),
        };
        if connected {
            return TryConnectOutcome::AlreadyConnected;
        }
        let crate::app_state::PendingStreamConnection {
            endpoint: Some(endpoint),
            token: Some(token),
            session_id: Some(session_id),
            user_id: Some(user_id),
            server_id: Some(server_id),
            dave_channel_id: Some(dave_channel_id),
        } = pending
        else {
            return TryConnectOutcome::MissingData;
        };

        tracing::info!(
            role = role.as_str(),
            server_id,
            dave_channel_id,
            user_id,
            "Connecting stream transport"
        );

        match VoiceConnection::connect(
            VoiceConnectionParams {
                endpoint: &endpoint,
                server_id,
                user_id,
                session_id: &session_id,
                token: &token,
                dave_channel_id,
                role,
                generation: self.current_transport_generation(role),
            },
            self.voice_event_tx.clone(),
            dave,
        )
        .await
        {
            Ok(conn) => {
                match role {
                    TransportRole::StreamWatch => self.stream_watch_conn = Some(conn),
                    TransportRole::StreamPublish => self.stream_publish_conn = Some(conn),
                    TransportRole::Voice => unreachable!("primary voice uses try_connect"),
                }
                TryConnectOutcome::Connected
            }
            Err(error) => {
                tracing::error!(role = role.as_str(), %error, "Stream connection failed");
                send_transport_error(
                    error_code,
                    role,
                    None,
                    format!("{label} connect failed: {error}"),
                );
                self.emit_transport_state(role, "failed", Some(&error.to_string()));
                TryConnectOutcome::Failed
            }
        }
    }

    pub(crate) async fn handle_reconnect_timer(&mut self) {
        self.reconnect_deadline = None;
        let outcome = self.try_connect().await;
        match outcome {
            TryConnectOutcome::Connected | TryConnectOutcome::AlreadyConnected => {
                self.reconnect_attempt = 0;
            }
            TryConnectOutcome::Failed | TryConnectOutcome::MissingData => {
                self.schedule_reconnect("reconnect_retry");
            }
        }
    }

    pub(crate) async fn handle_connection_command(&mut self, msg: InMsg) {
        match msg {
            InMsg::Join {
                connection_id,
                guild_id,
                channel_id,
                self_mute,
            } => {
                if connection_id.trim().is_empty() {
                    send_error(
                        ErrorCode::InvalidRequest,
                        "join requires a non-empty connectionId",
                    );
                    return;
                }
                let Ok(guild_id) = guild_id.parse::<u64>() else {
                    send_error(
                        ErrorCode::InvalidRequest,
                        format!("join requires a numeric guild_id, got {guild_id:?}"),
                    );
                    return;
                };
                let Ok(channel_id) = channel_id.parse::<u64>() else {
                    send_error(
                        ErrorCode::InvalidRequest,
                        format!("join requires a numeric channel_id, got {channel_id:?}"),
                    );
                    return;
                };
                self.reset_primary_transport("join_replaced_primary_voice");
                self.pending_conn = PendingConnection::default();
                self.connection_id = Some(connection_id);
                self.guild_id = Some(guild_id);
                self.channel_id = Some(channel_id);
                self.self_mute = self_mute;
                self.reset_reconnect();

                crate::ipc::send_gateway_voice_state_update(guild_id, channel_id, self_mute);
                tracing::info!(
                    guild_id,
                    channel_id,
                    "Join requested; forwarded OP4 voice state update"
                );
            }
            InMsg::Leave { reason } => {
                let reason = reason.unwrap_or_else(|| "explicit_leave".into());
                self.leave_primary_voice(&reason, true);
            }
            InMsg::VoiceServer { data } => {
                let changed = self.pending_conn.endpoint != data.endpoint
                    || self.pending_conn.token != data.token;
                let has_endpoint = data.endpoint.is_some();
                let has_token = data.token.is_some();
                tracing::info!(
                    has_endpoint,
                    has_token,
                    connected = self.voice_conn.is_some(),
                    "IPC voice_server received"
                );
                if changed && self.voice_conn.is_some() {
                    self.reset_primary_transport("voice_server_changed");
                    self.settle_primary_transport("voice_server_changed");
                }
                self.pending_conn.endpoint = data.endpoint;
                self.pending_conn.token = data.token;
                if self.pending_conn.endpoint.is_none() || self.pending_conn.token.is_none() {
                    self.reset_primary_transport("voice_server_cleared");
                    self.settle_primary_transport("voice_server_cleared");
                    return;
                }
                self.maybe_try_connect("voice_server_connect_failed", "voice_server")
                    .await;
            }
            InMsg::VoiceState { data } => {
                if matches!(data.channel_id, Some(None)) {
                    self.leave_primary_voice("gateway_voice_state_left", false);
                    return;
                }
                let new_session_id = data.session_id.as_ref().and_then(Clone::clone);
                let new_user_id = data
                    .user_id
                    .as_ref()
                    .and_then(|value| value.as_deref())
                    .and_then(|user_id| {
                        crate::app_state::parse_user_id_field(user_id, "voice_state")
                    });
                tracing::info!(
                    has_session_id = new_session_id.is_some(),
                    had_session_id = self.pending_conn.session_id.is_some(),
                    channel_id = ?data.channel_id,
                    user_id = ?new_user_id,
                    connected = self.voice_conn.is_some(),
                    stream_watch_connected = self.stream_watch_conn.is_some(),
                    "IPC voice_state received"
                );

                if let Some(channel_id) =
                    data.channel_id.as_ref().and_then(|value| value.as_deref())
                {
                    let Ok(channel_id) = channel_id.parse::<u64>() else {
                        send_error(
                            ErrorCode::InvalidRequest,
                            format!(
                                "voice_state requires a numeric channel_id, got {channel_id:?}"
                            ),
                        );
                        return;
                    };
                    if self.channel_id.is_some_and(|current| current != channel_id) {
                        self.reset_primary_transport("voice_channel_changed");
                        self.pending_conn = PendingConnection::default();
                    }
                    self.channel_id = Some(channel_id);
                }

                if let Some(session_id) = data.session_id {
                    if self.pending_conn.session_id != session_id && self.voice_conn.is_some() {
                        tracing::warn!(
                            session_changed = true,
                            "Voice session id changed while connected; tearing down for reconnect"
                        );
                        self.reset_primary_transport("session_id_changed");
                        self.settle_primary_transport("session_id_changed");
                    }
                    self.pending_conn.session_id = session_id;
                }
                if let Some(user_id_field) = data.user_id {
                    if user_id_field.is_some() && new_user_id.is_none() {
                        return;
                    }
                    self.pending_conn.user_id = new_user_id;
                }
                if self.pending_conn.session_id.is_none() || self.pending_conn.user_id.is_none() {
                    self.reset_primary_transport("voice_state_cleared");
                    self.settle_primary_transport("voice_state_cleared");
                    return;
                }
                self.maybe_try_connect("voice_state_connect_failed", "voice_state")
                    .await;
            }
            InMsg::StreamWatchConnect {
                endpoint,
                token,
                server_id,
                session_id,
                user_id,
                dave_channel_id,
            } => {
                let Some(user_id) =
                    crate::app_state::parse_user_id_field(&user_id, "stream_watch_connect.user_id")
                else {
                    return;
                };
                let Some(server_id) = crate::app_state::parse_user_id_field(
                    &server_id,
                    "stream_watch_connect.server_id",
                ) else {
                    return;
                };
                let Some(dave_channel_id) = crate::app_state::parse_user_id_field(
                    &dave_channel_id,
                    "stream_watch_connect.dave_channel_id",
                ) else {
                    return;
                };

                tracing::info!(
                    has_endpoint = !endpoint.trim().is_empty(),
                    has_session_id = !session_id.is_empty(),
                    server_id,
                    dave_channel_id,
                    user_id,
                    "IPC stream_watch_connect received"
                );

                self.clear_stream_watch_connection();
                self.stream_watch_pending_conn.endpoint = Some(endpoint);
                self.stream_watch_pending_conn.token = Some(token);
                self.stream_watch_pending_conn.server_id = Some(server_id);
                self.stream_watch_pending_conn.session_id = Some(session_id);
                self.stream_watch_pending_conn.user_id = Some(user_id);
                self.stream_watch_pending_conn.dave_channel_id = Some(dave_channel_id);

                self.emit_transport_state(TransportRole::StreamWatch, "connecting", None);
                match self.try_connect_stream(TransportRole::StreamWatch).await {
                    TryConnectOutcome::Connected | TryConnectOutcome::AlreadyConnected => {}
                    TryConnectOutcome::MissingData => {
                        self.emit_transport_state(
                            TransportRole::StreamWatch,
                            "failed",
                            Some("missing_stream_watch_credentials"),
                        );
                    }
                    TryConnectOutcome::Failed => {}
                }
            }
            InMsg::StreamWatchDisconnect { reason } => {
                let disconnect_reason = reason.unwrap_or_else(|| "stream_watch_disconnect".into());
                tracing::info!(reason = %disconnect_reason, "IPC stream_watch_disconnect received");
                self.clear_stream_watch_connection();
                self.emit_transport_state(
                    TransportRole::StreamWatch,
                    "disconnected",
                    Some(&disconnect_reason),
                );
            }
            InMsg::StreamPublishConnect {
                endpoint,
                token,
                server_id,
                session_id,
                user_id,
                dave_channel_id,
            } => {
                let Some(user_id) = crate::app_state::parse_user_id_field(
                    &user_id,
                    "stream_publish_connect.user_id",
                ) else {
                    return;
                };
                let Some(server_id) = crate::app_state::parse_user_id_field(
                    &server_id,
                    "stream_publish_connect.server_id",
                ) else {
                    return;
                };
                let Some(dave_channel_id) = crate::app_state::parse_user_id_field(
                    &dave_channel_id,
                    "stream_publish_connect.dave_channel_id",
                ) else {
                    return;
                };

                tracing::info!(
                    has_endpoint = !endpoint.trim().is_empty(),
                    has_session_id = !session_id.is_empty(),
                    server_id,
                    dave_channel_id,
                    user_id,
                    "IPC stream_publish_connect received"
                );

                self.clear_stream_publish_connection();
                self.stream_publish_pending_conn.endpoint = Some(endpoint);
                self.stream_publish_pending_conn.token = Some(token);
                self.stream_publish_pending_conn.server_id = Some(server_id);
                self.stream_publish_pending_conn.session_id = Some(session_id);
                self.stream_publish_pending_conn.user_id = Some(user_id);
                self.stream_publish_pending_conn.dave_channel_id = Some(dave_channel_id);

                self.emit_transport_state(TransportRole::StreamPublish, "connecting", None);
                match self.try_connect_stream(TransportRole::StreamPublish).await {
                    TryConnectOutcome::Connected | TryConnectOutcome::AlreadyConnected => {}
                    TryConnectOutcome::MissingData => {
                        self.emit_transport_state(
                            TransportRole::StreamPublish,
                            "failed",
                            Some("missing_stream_publish_credentials"),
                        );
                    }
                    TryConnectOutcome::Failed => {}
                }
            }
            InMsg::StreamPublishDisconnect { reason } => {
                let disconnect_reason =
                    reason.unwrap_or_else(|| "stream_publish_disconnect".into());
                tracing::info!(
                    reason = %disconnect_reason,
                    "IPC stream_publish_disconnect received"
                );
                self.stop_stream_publish_runtime("stream_publish_disconnect");
                self.clear_stream_publish_connection();
                self.emit_transport_state(
                    TransportRole::StreamPublish,
                    "disconnected",
                    Some(&disconnect_reason),
                );
            }
            _ => unreachable!("non-connection IPC command routed to connection supervisor"),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use crossbeam_channel as crossbeam;
    use parking_lot::Mutex;
    use tokio::sync::mpsc;

    use super::AppState;
    use crate::audio_pipeline::AudioSendState;
    use crate::capture::UserCaptureState;
    use crate::ipc::InMsg;
    use crate::music::{MusicEvent, MusicPcm};
    use crate::stream_publish::{StreamPublishEvent, StreamPublishFrame};
    use crate::voice_conn::VoiceEvent;

    fn test_app_state() -> AppState {
        let (voice_event_tx, _voice_event_rx) = mpsc::channel::<VoiceEvent>(4);
        let (music_pcm_tx, music_pcm_rx) = crossbeam::bounded::<MusicPcm>(4);
        let (music_event_tx, _music_event_rx) = mpsc::channel::<MusicEvent>(4);
        let (stream_publish_frame_tx, stream_publish_frame_rx) =
            crossbeam::bounded::<StreamPublishFrame>(4);
        let (stream_publish_event_tx, stream_publish_event_rx) =
            crossbeam::bounded::<StreamPublishEvent>(4);

        AppState::new(
            Arc::new(Mutex::new(None)),
            voice_event_tx,
            Arc::new(Mutex::new(Some(
                AudioSendState::new().expect("audio state"),
            ))),
            music_pcm_tx,
            music_pcm_rx,
            music_event_tx,
            stream_publish_frame_tx,
            stream_publish_frame_rx,
            stream_publish_event_tx,
            stream_publish_event_rx,
        )
    }

    #[tokio::test]
    async fn explicit_leave_clears_only_primary_voice_and_never_reconnects() {
        let mut state = test_app_state();
        state.guild_id = Some(1);
        state.channel_id = Some(2);
        state.pending_conn.endpoint = Some("voice.example".into());
        state.pending_conn.token = Some("secret".into());
        state.pending_conn.session_id = Some("voice-session".into());
        state.pending_conn.user_id = Some(3);
        state.reconnect_deadline = Some(tokio::time::Instant::now());
        state.reconnect_attempt = 4;
        let mut capture = UserCaptureState::new("capture-1".into(), 24_000, 700);
        capture.stream_active = true;
        state.user_capture_states.insert(4, capture);
        state.tts_playback_id = Some("playback-1".into());
        state.tts_finish_pending = true;
        state.music.music_id = Some("music-1".into());
        state.music.active = true;
        state.stream_watch_pending_conn.endpoint = Some("watch.example".into());
        state.stream_publish_pending_conn.endpoint = Some("publish.example".into());
        state.stream_publish.active = true;

        state
            .handle_connection_command(InMsg::Leave {
                reason: Some("operator_left".into()),
            })
            .await;

        assert!(state.guild_id.is_none());
        assert!(state.channel_id.is_none());
        assert!(state.pending_conn.endpoint.is_none());
        assert!(state.pending_conn.token.is_none());
        assert!(state.reconnect_deadline.is_none());
        assert_eq!(state.reconnect_attempt, 0);
        assert!(state.user_capture_states.is_empty());
        assert!(state.tts_playback_id.is_none());
        assert!(state.music.music_id.is_none());
        assert!(state.audio_send_state.lock().is_none());
        assert_eq!(
            state.stream_watch_pending_conn.endpoint.as_deref(),
            Some("watch.example")
        );
        assert_eq!(
            state.stream_publish_pending_conn.endpoint.as_deref(),
            Some("publish.example")
        );
        assert!(state.stream_publish.active);
    }

    #[tokio::test]
    async fn null_gateway_fields_clear_stale_primary_credentials() {
        let mut state = test_app_state();
        state.guild_id = Some(1);
        state.channel_id = Some(2);
        state.pending_conn.endpoint = Some("old.example".into());
        state.pending_conn.token = Some("old-token".into());
        state.pending_conn.session_id = Some("old-session".into());
        state.pending_conn.user_id = Some(3);

        state
            .handle_connection_command(InMsg::VoiceServer {
                data: crate::ipc::VoiceServerData {
                    endpoint: None,
                    token: None,
                },
            })
            .await;
        assert!(state.pending_conn.endpoint.is_none());
        assert!(state.pending_conn.token.is_none());

        let message: InMsg = serde_json::from_value(serde_json::json!({
            "type": "voice_state",
            "data": { "channel_id": null }
        }))
        .unwrap();
        state.handle_connection_command(message).await;
        assert!(state.guild_id.is_none());
        assert!(state.channel_id.is_none());
        assert!(state.pending_conn.session_id.is_none());
        assert!(state.pending_conn.user_id.is_none());
    }

    #[tokio::test]
    async fn fresh_join_discards_previous_primary_transport_inputs() {
        let mut state = test_app_state();
        state.pending_conn.endpoint = Some("old.example".into());
        state.pending_conn.token = Some("old-token".into());
        state.pending_conn.session_id = Some("old-session".into());
        state.pending_conn.user_id = Some(3);

        state
            .handle_connection_command(InMsg::Join {
                connection_id: "connection-1".into(),
                guild_id: "10".into(),
                channel_id: "20".into(),
                self_mute: false,
            })
            .await;

        assert_eq!(state.guild_id, Some(10));
        assert_eq!(state.channel_id, Some(20));
        assert!(state.pending_conn.endpoint.is_none());
        assert!(state.pending_conn.token.is_none());
        assert!(state.pending_conn.session_id.is_none());
        assert!(state.pending_conn.user_id.is_none());
    }

    #[tokio::test]
    async fn rejoin_ignores_disconnect_from_replaced_connection_generation() {
        let mut state = test_app_state();
        state
            .handle_connection_command(InMsg::Join {
                connection_id: "connection-old".into(),
                guild_id: "10".into(),
                channel_id: "20".into(),
                self_mute: false,
            })
            .await;
        let old_generation =
            state.current_transport_generation(crate::voice_conn::TransportRole::Voice);

        state
            .handle_connection_command(InMsg::Join {
                connection_id: "connection-new".into(),
                guild_id: "30".into(),
                channel_id: "40".into(),
                self_mute: false,
            })
            .await;
        assert_eq!(state.connection_id.as_deref(), Some("connection-new"));
        assert!(
            state.current_transport_generation(crate::voice_conn::TransportRole::Voice)
                > old_generation
        );

        state.handle_voice_event(crate::voice_conn::VoiceEvent::Disconnected {
            role: crate::voice_conn::TransportRole::Voice,
            generation: old_generation,
            reason: "old socket closed".into(),
        });

        assert_eq!(state.connection_id.as_deref(), Some("connection-new"));
        assert_eq!(state.guild_id, Some(30));
        assert_eq!(state.channel_id, Some(40));
        assert!(state.reconnect_deadline.is_none());
    }
}
