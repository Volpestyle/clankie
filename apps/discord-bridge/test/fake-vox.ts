import type {
  VoxClient,
  VoxControlEvent,
  VoxDecodedVideoFrame,
  VoxMusicRequest,
  VoxProcessStatus,
  VoxStreamConnect,
  VoxTtsAudio,
  VoxUserAudioFrame,
} from "@clankie/vox-client";
import { VOX_IPC_PROTOCOL_VERSION } from "@clankie/vox-client";

export class FakeVox implements VoxClient {
  public available = true;
  public status: VoxProcessStatus = "ready";
  public detail = "fake Vox";
  public autoTransportReady = true;
  public autoDaveReady = true;
  public autoGatewayLeave = true;
  public readonly joins: { connectionId: string; guildId: string; channelId: string; selfMute?: boolean }[] =
    [];
  public readonly leaves: (string | undefined)[] = [];
  public readonly voiceServers: { endpoint: string | null; token: string | null }[] = [];
  public readonly voiceStates: {
    session_id?: string | null;
    user_id?: string | null;
    channel_id?: string | null;
  }[] = [];
  public readonly audio: VoxTtsAudio[] = [];
  public readonly subscriptions: { userId: string; captureId: string }[] = [];
  public readonly music: { action: string; request?: VoxMusicRequest; musicId?: string }[] = [];
  public closeCalls = 0;
  private readonly eventListeners = new Set<(event: VoxControlEvent) => void>();
  private readonly statusListeners = new Set<(status: VoxProcessStatus, detail: string) => void>();
  private readonly audioListeners = new Set<(frame: VoxUserAudioFrame) => void>();
  private readonly decodedListeners = new Set<(frame: VoxDecodedVideoFrame) => void>();

  public joinVoice(input: {
    connectionId: string;
    guildId: string;
    channelId: string;
    selfMute?: boolean;
  }): void {
    this.joins.push(input);
    this.emit({
      type: "adapter_send",
      payload: {
        op: 4,
        d: {
          guild_id: input.guildId,
          channel_id: input.channelId,
          self_mute: input.selfMute ?? false,
          self_deaf: false,
        },
      },
    });
    queueMicrotask(() => {
      if (this.autoTransportReady) {
        this.emit({
          type: "transport_state",
          role: "voice",
          connectionId: input.connectionId,
          status: "ready",
        });
      }
      if (this.autoDaveReady)
        this.emit({
          type: "dave_state",
          role: "voice",
          connectionId: input.connectionId,
          status: "ready",
          protocolVersion: 1,
        });
    });
  }

  public leaveVoice(reason?: string): void {
    this.leaves.push(reason);
    const guildId = this.joins.at(-1)?.guildId;
    if (guildId === undefined || !this.autoGatewayLeave) return;
    this.emitGatewayLeave(guildId);
  }

  public emitGatewayLeave(guildId: string): void {
    this.emit({
      type: "adapter_send",
      payload: {
        op: 4,
        d: { guild_id: guildId, channel_id: null, self_mute: false, self_deaf: false },
      },
    });
  }

  public updateVoiceServer(data: { endpoint: string | null; token: string | null }): void {
    this.voiceServers.push(data);
  }

  public updateVoiceState(data: {
    session_id?: string | null;
    user_id?: string | null;
    channel_id?: string | null;
  }): void {
    this.voiceStates.push(data);
  }

  public sendAudio(input: VoxTtsAudio): void {
    this.audio.push(input);
    queueMicrotask(() => {
      this.emit({ type: "tts_playback_state", playbackId: input.playbackId, status: "buffered" });
      this.emit({ type: "tts_playback_state", playbackId: input.playbackId, status: "started" });
    });
  }
  public stopPlayback(): void {}
  public finishTtsPlayback(playbackId: string): void {
    queueMicrotask(() => this.emit({ type: "tts_playback_state", playbackId, status: "drained" }));
  }
  public stopTtsPlayback(playbackId: string): void {
    this.emit({ type: "tts_playback_state", playbackId, status: "stopped" });
  }
  public subscribeUserAudio(userId: string, captureId: string): void {
    this.subscriptions.push({ userId, captureId });
  }
  public unsubscribeUserAudio(): void {}
  public streamWatchConnect(_input: VoxStreamConnect): void {}
  public streamWatchDisconnect(): void {}
  public subscribeUserVideo(): void {}
  public unsubscribeUserVideo(): void {}
  public streamPublishConnect(_input: VoxStreamConnect): void {}
  public streamPublishDisconnect(): void {}
  public streamPublishPlay(): void {}
  public streamPublishBrowserStart(): void {}
  public streamPublishBrowserFrame(): void {}
  public streamPublishStop(): void {}
  public streamPublishPause(): void {}
  public streamPublishResume(): void {}
  public musicPlay(request: VoxMusicRequest): void {
    this.music.push({ action: "play", request });
  }
  public musicStop(musicId: string): void {
    this.music.push({ action: "stop", musicId });
  }
  public musicPause(musicId: string): void {
    this.music.push({ action: "pause", musicId });
  }
  public musicResume(musicId: string): void {
    this.music.push({ action: "resume", musicId });
  }
  public musicSetGain(musicId: string, _target: number, _fadeMs?: number): void {
    this.music.push({ action: "gain", musicId });
  }

  public onStatus(listener: (status: VoxProcessStatus, detail: string) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status, this.detail);
    return () => this.statusListeners.delete(listener);
  }
  public onEvent(listener: (event: VoxControlEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  public onUserAudio(listener: (frame: VoxUserAudioFrame) => void): () => void {
    this.audioListeners.add(listener);
    return () => this.audioListeners.delete(listener);
  }
  public onDecodedFrame(listener: (frame: VoxDecodedVideoFrame) => void): () => void {
    this.decodedListeners.add(listener);
    return () => this.decodedListeners.delete(listener);
  }

  public emit(event: VoxControlEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  public emitStatus(status: VoxProcessStatus, detail = this.detail): void {
    this.status = status;
    this.detail = detail;
    for (const listener of this.statusListeners) listener(status, detail);
  }

  public emitProcessReady(protocolVersion = VOX_IPC_PROTOCOL_VERSION): void {
    this.emitStatus("ready");
    this.emit({ type: "process_ready", protocolVersion });
  }

  public emitAudio(userId: string, pcm: Uint8Array): void {
    const captureId = this.subscriptions.findLast((entry) => entry.userId === userId)?.captureId;
    if (captureId === undefined) throw new Error(`No Vox capture for ${userId}`);
    const frame: VoxUserAudioFrame = {
      userId,
      captureId,
      signalPeakAbs: 1,
      signalActiveSampleCount: pcm.byteLength / 2,
      signalSampleCount: pcm.byteLength / 2,
      pcm,
    };
    for (const listener of this.audioListeners) listener(frame);
  }

  public close(): void {
    this.closeCalls += 1;
    this.emitStatus("closed", "closed");
  }
}
