use crate::ipc::InMsg;

pub(crate) enum RoutedInMsg {
    Connection(ConnectionCommand),
    Capture(CaptureCommand),
    Playback(PlaybackCommand),
    StreamPublish(StreamPublishCommand),
}

pub(crate) enum ConnectionCommand {
    Join {
        guild_id: String,
        channel_id: String,
        self_mute: bool,
    },
    VoiceServer {
        data: crate::ipc::VoiceServerData,
    },
    VoiceState {
        data: crate::ipc::VoiceStateData,
    },
    StreamWatchConnect {
        endpoint: String,
        token: String,
        server_id: String,
        session_id: String,
        user_id: String,
        dave_channel_id: String,
    },
    StreamWatchDisconnect {
        reason: Option<String>,
    },
    StreamPublishConnect {
        endpoint: String,
        token: String,
        server_id: String,
        session_id: String,
        user_id: String,
        dave_channel_id: String,
    },
    StreamPublishDisconnect {
        reason: Option<String>,
    },
}

pub(crate) enum CaptureCommand {
    SubscribeUser {
        user_id: String,
        silence_duration_ms: u32,
        sample_rate: u32,
    },
    UnsubscribeUser {
        user_id: String,
    },
    SubscribeUserVideo {
        user_id: String,
        max_frames_per_second: u32,
        preferred_quality: u32,
        preferred_pixel_count: Option<u32>,
        preferred_stream_type: Option<String>,
        jpeg_quality: Option<u32>,
    },
    UnsubscribeUserVideo {
        user_id: String,
    },
}

pub(crate) enum PlaybackCommand {
    Audio {
        pcm_base64: String,
        sample_rate: u32,
    },
    StopPlayback,
    StopTtsPlayback,
    MusicPlay {
        url: String,
        resolved_direct_url: bool,
    },
    MusicStop,
    MusicPause,
    MusicResume,
    MusicSetGain {
        target: f32,
        fade_ms: u32,
    },
    Destroy,
}

pub(crate) enum StreamPublishCommand {
    Play {
        url: String,
        resolved_direct_url: bool,
    },
    PlayVisualizer {
        url: String,
        resolved_direct_url: bool,
        visualizer_mode: String,
    },
    BrowserStart {
        mime_type: String,
    },
    BrowserFrame {
        mime_type: String,
        frame_base64: String,
        captured_at_ms: u64,
    },
    Stop,
    Pause,
    Resume,
}

impl From<InMsg> for RoutedInMsg {
    fn from(msg: InMsg) -> Self {
        match msg {
            InMsg::Join {
                guild_id,
                channel_id,
                self_mute,
            } => Self::Connection(ConnectionCommand::Join {
                guild_id,
                channel_id,
                self_mute,
            }),
            InMsg::VoiceServer { data } => {
                Self::Connection(ConnectionCommand::VoiceServer { data })
            }
            InMsg::VoiceState { data } => Self::Connection(ConnectionCommand::VoiceState { data }),
            InMsg::StreamWatchConnect {
                endpoint,
                token,
                server_id,
                session_id,
                user_id,
                dave_channel_id,
            } => Self::Connection(ConnectionCommand::StreamWatchConnect {
                endpoint,
                token,
                server_id,
                session_id,
                user_id,
                dave_channel_id,
            }),
            InMsg::StreamWatchDisconnect { reason } => {
                Self::Connection(ConnectionCommand::StreamWatchDisconnect { reason })
            }
            InMsg::StreamPublishConnect {
                endpoint,
                token,
                server_id,
                session_id,
                user_id,
                dave_channel_id,
            } => Self::Connection(ConnectionCommand::StreamPublishConnect {
                endpoint,
                token,
                server_id,
                session_id,
                user_id,
                dave_channel_id,
            }),
            InMsg::StreamPublishDisconnect { reason } => {
                Self::Connection(ConnectionCommand::StreamPublishDisconnect { reason })
            }
            InMsg::SubscribeUser {
                user_id,
                silence_duration_ms,
                sample_rate,
            } => Self::Capture(CaptureCommand::SubscribeUser {
                user_id,
                silence_duration_ms,
                sample_rate,
            }),
            InMsg::UnsubscribeUser { user_id } => {
                Self::Capture(CaptureCommand::UnsubscribeUser { user_id })
            }
            InMsg::SubscribeUserVideo {
                user_id,
                max_frames_per_second,
                preferred_quality,
                preferred_pixel_count,
                preferred_stream_type,
                jpeg_quality,
            } => Self::Capture(CaptureCommand::SubscribeUserVideo {
                user_id,
                max_frames_per_second,
                preferred_quality,
                preferred_pixel_count,
                preferred_stream_type,
                jpeg_quality,
            }),
            InMsg::UnsubscribeUserVideo { user_id } => {
                Self::Capture(CaptureCommand::UnsubscribeUserVideo { user_id })
            }
            InMsg::Audio {
                pcm_base64,
                sample_rate,
            } => Self::Playback(PlaybackCommand::Audio {
                pcm_base64,
                sample_rate,
            }),
            InMsg::StopPlayback => Self::Playback(PlaybackCommand::StopPlayback),
            InMsg::StopTtsPlayback => Self::Playback(PlaybackCommand::StopTtsPlayback),
            InMsg::MusicPlay {
                url,
                resolved_direct_url,
            } => Self::Playback(PlaybackCommand::MusicPlay {
                url,
                resolved_direct_url,
            }),
            InMsg::MusicStop => Self::Playback(PlaybackCommand::MusicStop),
            InMsg::MusicPause => Self::Playback(PlaybackCommand::MusicPause),
            InMsg::MusicResume => Self::Playback(PlaybackCommand::MusicResume),
            InMsg::MusicSetGain { target, fade_ms } => {
                Self::Playback(PlaybackCommand::MusicSetGain { target, fade_ms })
            }
            InMsg::StreamPublishPlay {
                url,
                resolved_direct_url,
            } => Self::StreamPublish(StreamPublishCommand::Play {
                url,
                resolved_direct_url,
            }),
            InMsg::StreamPublishPlayVisualizer {
                url,
                resolved_direct_url,
                visualizer_mode,
            } => Self::StreamPublish(StreamPublishCommand::PlayVisualizer {
                url,
                resolved_direct_url,
                visualizer_mode,
            }),
            InMsg::StreamPublishBrowserStart { mime_type } => {
                Self::StreamPublish(StreamPublishCommand::BrowserStart { mime_type })
            }
            InMsg::StreamPublishBrowserFrame {
                mime_type,
                frame_base64,
                captured_at_ms,
            } => Self::StreamPublish(StreamPublishCommand::BrowserFrame {
                mime_type,
                frame_base64,
                captured_at_ms,
            }),
            InMsg::StreamPublishStop => Self::StreamPublish(StreamPublishCommand::Stop),
            InMsg::StreamPublishPause => Self::StreamPublish(StreamPublishCommand::Pause),
            InMsg::StreamPublishResume => Self::StreamPublish(StreamPublishCommand::Resume),
            InMsg::Destroy => Self::Playback(PlaybackCommand::Destroy),
        }
    }
}
