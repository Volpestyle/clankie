import type {
  DrawDiagramResult,
  DrawErDiagramRequest,
  DrawSequenceDiagramRequest,
  GenerateImageRequest,
  GenerateImageResult,
  GenerateVideoRequest,
  GenerateVideoResult,
} from "@clankie/protocol";
import type { SkinDraftCommand, SkinDraftResult, SkinKeyPose } from "@clankie/protocol/skin-drafts";
import type { QuestionAuthority } from "../captain/conversation-questions.ts";

// The core's side of the media extension (ADR 0328): what the captain and the
// app call. The generators and the tldraw host behind them are the extension's.

/**
 * Where making a picture actually happens (ADR 0085).
 *
 * Provider and model come from operator config (`/image-model`, `/video-model`)
 * and never from the request. A turn chooses what to draw, not what to spend.
 */
export interface MediaGeneratorPort {
  generateImage(request: GenerateImageRequest): Promise<GenerateImageResult>;
  /** `signal` abandons the wait on a hung-up caller; the render itself continues upstream. */
  generateVideo(request: GenerateVideoRequest, options?: GenerateVideoOptions): Promise<GenerateVideoResult>;
  /**
   * Renders this room started that outlived the call and have since landed,
   * and that he has not collected yet (ADR 0094).
   *
   * Checks the outstanding ones as it goes: the turn is the clock, so a render
   * is only ever asked about when someone is there to be told. Scoped by room
   * for the same reason `observe_room` is — what he was asked to make in one
   * channel is not another channel's business.
   */
  finishedRenders(room: string): Promise<readonly FinishedRender[]>;
}

export interface GenerateVideoOptions {
  /** Abandons the wait on a hung-up caller; the render itself continues. */
  readonly signal?: AbortSignal | undefined;
  /**
   * Opaque key for the room that asked, stored and compared verbatim — the
   * generator never parses it. Absent means nobody is told when it lands.
   */
  readonly room?: string | undefined;
}

/** A render that outlived its call, waiting to be collected. */
export interface FinishedRender {
  readonly requestId: string;
  /** What he asked for, so the reminder names the right video. */
  readonly prompt: string;
  readonly outcome: "ok" | "refused";
  /** Seconds between starting the render and it landing. */
  readonly tookSeconds: number;
}

/** His drawing hand (ADR 0096), as the captain calls it. */
export interface DiagramPort {
  drawErDiagram(request: DrawErDiagramRequest): Promise<DrawDiagramResult>;
  drawSequenceDiagram(request: DrawSequenceDiagramRequest): Promise<DrawDiagramResult>;
}

/** One stored skin draft picture, as the owner's preview reads it. */
interface SkinDraftImage {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly mediaType: string;
}

/** The owner's lead-skin drafts, as the captain's tool and the app's routes call them. */
export interface SkinDraftPort {
  handle(authority: QuestionAuthority | undefined, value: SkinDraftCommand): Promise<SkinDraftResult>;
  referencePreview(
    authority: QuestionAuthority | undefined,
    id: string,
    revision: string,
  ): Promise<SkinDraftImage>;
  preview(
    authority: QuestionAuthority | undefined,
    id: string,
    pose: SkinKeyPose,
    revision: string,
    kind: "source" | "native",
  ): Promise<SkinDraftImage>;
}
