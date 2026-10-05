import type { ActivityFrameSink } from "@clankie/rendered-surface-client";
import type { ActivitySharingSource } from "./activity-sharing.ts";

/** Fan out an existing play producer; attaching a viewer never starts capture or play. */
export class ActivityPlaySource {
  private current: { subscribers: Set<ActivityFrameSink>; title: string } | undefined;
  createSink(title: string, legacy?: ActivityFrameSink): ActivityFrameSink {
    for (const sink of this.current?.subscribers ?? []) sink.close();
    this.current?.subscribers.clear();
    const current = { subscribers: new Set<ActivityFrameSink>(), title };
    this.current = current;
    let closed = false;
    const each = (effect: (sink: ActivityFrameSink) => void) => {
      if (closed) return;
      if (legacy) effect(legacy);
      for (const sink of current.subscribers) effect(sink);
    };
    return {
      publishFrame: (frame) => each((sink) => sink.publishFrame(frame)),
      publishAudio: (audio) => each((sink) => sink.publishAudio(audio)),
      publishOverlay: (overlay) => each((sink) => sink.publishOverlay(overlay)),
      publishStatus: (status) => each((sink) => sink.publishStatus(status)),
      get connected() {
        return !closed;
      },
      get droppedFrameCount() {
        return legacy?.droppedFrameCount ?? 0;
      },
      get droppedAudioPacketCount() {
        return legacy?.droppedAudioPacketCount ?? 0;
      },
      close: () => {
        if (closed) return;
        closed = true;
        legacy?.close();
        for (const sink of current.subscribers) sink.close();
        current.subscribers.clear();
        if (this.current === current) this.current = undefined;
      },
    };
  }
  resolve(sourceId: string): ActivitySharingSource | undefined {
    const current = this.current;
    if (sourceId !== "play" || current === undefined) return undefined;
    return {
      source: { kind: "game", id: "play", title: current.title },
      attach: (sink) => {
        if (this.current !== current) throw new Error("activity_source_unavailable");
        if (current.subscribers.size >= 8) throw new Error("activity_share_capacity");
        current.subscribers.add(sink);
        return () => current.subscribers.delete(sink);
      },
    };
  }
}
