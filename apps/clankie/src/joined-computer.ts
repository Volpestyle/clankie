import {
  ComputerCommandSchema,
  ComputerFrameSchema,
  ComputerScreenshotSchema,
  ComputerInventorySchema,
  ComputerLeaseSchema,
  ComputerReceiptSchema,
  type ComputerScreenshot,
  JoinedScreenChunkSchema,
  JOINED_SCREEN_CHUNK_CHARS,
  type ComputerCommand,
  type JoinedScreenRequest,
} from "@clankie/interactive-environment";
import type { SettingsStore } from "@clankie/settings";
import type { BodyConversationIdentity } from "./body-lease-router.ts";
import type { MachineJoins } from "./machine-joins.ts";
import { requireMachineAccess } from "./machine-access.ts";

/** Selection is explicit. No host failure redirects an action to another desktop. */
export class JoinedComputer {
  private readonly joins: MachineJoins;
  private readonly settings: SettingsStore;
  private readonly screenshots = new Map<string, ComputerScreenshot>();
  constructor(joins: MachineJoins, settings: SettingsStore) {
    this.joins = joins;
    this.settings = settings;
  }

  async dispatch(identity: BodyConversationIdentity, machineId: string, raw: unknown): Promise<unknown> {
    const command: ComputerCommand = ComputerCommandSchema.parse(raw);
    const recovery = ["status", "release", "revoke", "recover"].includes(command.action);
    const guard = async () => {
      if (
        !this.joins.has(machineId) ||
        identity.route?.mode !== "machine" ||
        !identity.current() ||
        !(await identity.authorize("computer", recovery ? "recover" : "effect")) ||
        !identity.current()
      )
        throw Error("computer_authorization_required");
      if (!recovery) await requireMachineAccess(this.settings, machineId, "screen", this.joins);
    };
    const exchange = async (request: JoinedScreenRequest): Promise<unknown> => {
      await guard();
      const result = await this.joins.request(machineId, {
        kind: "screen",
        request: JSON.stringify(request),
      });
      await guard();
      if (!result.ok || result.truncated || result.screenOutput === undefined)
        throw Error("joined_computer_unavailable");
      return JSON.parse(result.screenOutput);
    };
    if (command.action !== "frame") {
      const result = await exchange({ op: "command", conversationId: identity.conversationId, command });
      if (command.action === "capture") {
        const shot = ComputerScreenshotSchema.parse(result);
        if (
          shot.conversationId !== identity.conversationId ||
          shot.leaseId !== command.leaseId ||
          Date.parse(shot.expiresAt) <= Date.now()
        )
          throw Error("joined_capture_refused");
        this.screenshots.set(`${machineId}:${shot.screenshotId}`, shot);
        while (this.screenshots.size > 128) this.screenshots.delete(this.screenshots.keys().next().value!);
        return shot;
      }
      if (command.action === "inventory") return ComputerInventorySchema.parse(result);
      if (
        command.action === "input" &&
        typeof result === "object" &&
        result !== null &&
        "outcome" in result &&
        ["confirmed", "failed", "uncertain"].includes(String(result.outcome))
      ) {
        const receipt = ComputerReceiptSchema.parse(result);
        if (
          receipt.conversationId !== identity.conversationId ||
          receipt.leaseId !== command.leaseId ||
          receipt.requestId !== command.requestId ||
          receipt.screenshotId !== command.screenshotId
        )
          throw Error("joined_receipt_refused");
        return receipt;
      }
      if (
        (command.action === "acquire" || command.action === "renew") &&
        typeof result === "object" &&
        result !== null &&
        "lease" in result &&
        "outcome" in result &&
        ["acquired", "renewed"].includes(String(result.outcome))
      ) {
        const lease = ComputerLeaseSchema.parse(result.lease);
        if (lease.conversationId !== identity.conversationId) throw Error("joined_lease_refused");
      }
      return result;
    }
    const expected = this.screenshots.get(`${machineId}:${command.screenshotId}`);
    if (
      !expected ||
      expected.conversationId !== identity.conversationId ||
      expected.leaseId !== command.leaseId ||
      Date.parse(expected.expiresAt) <= Date.now()
    )
      throw Error("joined_frame_expired");
    const chunk = async (offset: number) => {
      const value = JoinedScreenChunkSchema.parse(
        await exchange({
          op: "frame_chunk",
          conversationId: identity.conversationId,
          leaseId: command.leaseId,
          screenshotId: command.screenshotId,
          offset,
        }),
      );
      if (
        value.screenshotId !== command.screenshotId ||
        value.offset !== offset ||
        value.expiresAt !== expected.expiresAt ||
        value.sha256 !== expected.sha256 ||
        Date.parse(value.expiresAt) <= Date.now() ||
        value.data.length !== Math.min(JOINED_SCREEN_CHUNK_CHARS, value.totalChars - offset)
      )
        throw Error("joined_frame_refused");
      return value;
    };
    const first = await chunk(0);
    const data = [first.data];
    for (
      let offset = JOINED_SCREEN_CHUNK_CHARS;
      offset < first.totalChars;
      offset += JOINED_SCREEN_CHUNK_CHARS * 8
    ) {
      const offsets = Array.from(
        { length: 8 },
        (_, index) => offset + index * JOINED_SCREEN_CHUNK_CHARS,
      ).filter((value) => value < first.totalChars);
      const batch = await Promise.all(offsets.map(chunk));
      for (const value of batch) {
        if (
          value.byteLength !== first.byteLength ||
          value.sha256 !== first.sha256 ||
          value.totalChars !== first.totalChars
        )
          throw Error("joined_frame_identity_changed");
        data.push(value.data);
      }
    }
    await guard();
    if (Date.parse(expected.expiresAt) <= Date.now()) throw Error("joined_frame_expired");
    return ComputerFrameSchema.parse({
      screenshotId: first.screenshotId,
      encoding: "png",
      byteLength: first.byteLength,
      sha256: first.sha256,
      data: data.join(""),
    });
  }
}
