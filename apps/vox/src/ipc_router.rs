use crate::app_state::AppState;
use crate::ipc::InMsg;

impl AppState {
    pub(crate) async fn route_ipc_message(&mut self, msg: InMsg) -> bool {
        match msg {
            command @ (InMsg::Join { .. }
            | InMsg::Leave { .. }
            | InMsg::VoiceServer { .. }
            | InMsg::VoiceState { .. }
            | InMsg::StreamWatchConnect { .. }
            | InMsg::StreamWatchDisconnect { .. }
            | InMsg::StreamPublishConnect { .. }
            | InMsg::StreamPublishDisconnect { .. }) => {
                self.handle_connection_command(command).await;
                false
            }
            command @ (InMsg::SubscribeUser { .. }
            | InMsg::UnsubscribeUser { .. }
            | InMsg::SubscribeUserVideo { .. }
            | InMsg::UnsubscribeUserVideo { .. }) => {
                self.handle_capture_command(command);
                false
            }
            command @ (InMsg::Audio { .. }
            | InMsg::StopPlayback
            | InMsg::FinishTtsPlayback { .. }
            | InMsg::StopTtsPlayback { .. }
            | InMsg::MusicPlay { .. }
            | InMsg::MusicStop { .. }
            | InMsg::MusicPause { .. }
            | InMsg::MusicResume { .. }
            | InMsg::MusicSetGain { .. }
            | InMsg::Destroy) => self.handle_playback_command(command),
            command @ (InMsg::StreamPublishPlay { .. }
            | InMsg::StreamPublishBrowserStart { .. }
            | InMsg::StreamPublishBrowserFrame { .. }
            | InMsg::StreamPublishStop
            | InMsg::StreamPublishPause
            | InMsg::StreamPublishResume) => {
                self.handle_stream_publish_command(command);
                false
            }
        }
    }
}
