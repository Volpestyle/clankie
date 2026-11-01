// Clankie's look, as the core offers it to extensions (ADR 0328). The persona
// extension fills it from the owner's persona images; while the persona is off
// it is empty. Media draws him from it, so media never imports the persona.

/** One reference picture of him, as the persona's board holds it. */
interface AppearanceImage {
  /** `appearance` pictures define how he looks; `vibe` ones only set the mood. */
  readonly role: "appearance" | "vibe";
  readonly mimeType: string;
  /** Base64 bytes. */
  readonly data: string;
  /** Set when the picture is a contact sheet of frames from a video. */
  readonly contactSheet?: true;
}

interface AppearanceBoard {
  readonly images: readonly AppearanceImage[];
}

/** His current board, or undefined while nothing fills it. */
export type AppearancePort = () => Promise<AppearanceBoard | undefined>;
