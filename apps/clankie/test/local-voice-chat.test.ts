import { Buffer } from "node:buffer";
import { expect, it } from "vitest";
import type {
  TranscriptVoiceConversationOpenInput,
  TranscriptVoiceRealtimePorts,
  VoiceConversationPort,
  VoiceTranscriptionHandlers,
  VoiceTranscriptionPort,
} from "@clankie/discord-presence-core";
import { LocalVoiceChatSession, type LocalVoiceSocket } from "../src/local-voice-chat.ts";
import { createStubCaptain } from "../src/captain/port.ts";

it("turns committed local PCM into a realtime spoken exchange", async () => {
  let transcriptionHandlers: VoiceTranscriptionHandlers | undefined;
  let conversationHandlers: TranscriptVoiceConversationOpenInput | undefined;
  const heard: Buffer[] = [];
  let commits = 0;
  const transcription: VoiceTranscriptionPort = {
    isOpen: true,
    appendAudio: (pcm) => heard.push(Buffer.from(pcm)),
    commitAudio: () => {
      commits += 1;
    },
    close: () => {},
  };
  const textItems: string[] = [];
  let responses = 0;
  const conversation: VoiceConversationPort = {
    isOpen: true,
    appendAudio: () => {},
    createTextItem: (text) => textItems.push(text),
    createImageItem: () => {},
    createResponse: () => {
      responses += 1;
    },
    truncate: () => {},
    submitFunctionResult: () => {},
    close: () => {},
  };
  const realtime: TranscriptVoiceRealtimePorts = {
    openTranscription: async (handlers) => {
      transcriptionHandlers = handlers;
      return transcription;
    },
    openConversation: async (handlers) => {
      conversationHandlers = handlers;
      return conversation;
    },
  };
  const sent: (string | Uint8Array)[] = [];
  const socket: LocalVoiceSocket = {
    bufferedAmount: 0,
    send: (data) => sent.push(typeof data === "string" ? data : Uint8Array.from(data)),
    close: () => {},
  };
  const session = await LocalVoiceChatSession.open({
    realtime,
    captain: createStubCaptain(),
    instructions: "Be Clankie.",
    briefing: "This is a private local call.",
  });
  session.attach(socket);
  session.receiveAudio(Uint8Array.from([1, 0, 2, 0]));
  session.receiveText('{"schemaVersion":1,"type":"commit"}');
  transcriptionHandlers?.onTranscript({ itemId: "input-1", text: "hey clankie", final: true });
  conversationHandlers?.onAudioDelta(Buffer.from([3, 0, 4, 0]), "output-1");
  conversationHandlers?.onResponseDone({
    responseId: "response-1",
    status: "completed",
    audioBytes: 4,
    textCharacters: 0,
  });

  expect(heard[0]).toEqual(Buffer.from([1, 0, 2, 0]));
  expect(commits).toBe(1);
  expect(textItems).toEqual(["This is a private local call.", "Operator: hey clankie"]);
  expect(responses).toBe(1);
  expect(sent.some((item) => item instanceof Uint8Array && item[0] === 3)).toBe(true);
  expect(sent.some((item) => typeof item === "string" && item.includes('"type":"response_done"'))).toBe(true);
});
