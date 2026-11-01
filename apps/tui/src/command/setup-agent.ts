import {
  SETUP_SURVEY_APPLY_PATH,
  SETUP_SURVEY_CANCEL_PATH,
  SETUP_SURVEY_PATH,
  SetupSurveySnapshotSchema,
  type SetupSurveySnapshot,
} from "@clankie/protocol";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";

const USAGE =
  "Usage: clankie setup-agent [status | start [--account <label>] | apply <surveyId> [lineId...] | cancel <surveyId>]";

/**
 * Setup's one read-only agent (ADR 0316), over the same owner API as the app:
 * start it, read its proposal, approve lines by id, or say no.
 */
export async function runSetupAgentCommand(
  args: readonly string[],
  options: OwnerSettingsApiOptions = {},
): Promise<SetupSurveySnapshot> {
  const [verb = "status", ...rest] = args;
  const api = await ownerSettingsApi(options);
  try {
    if (verb === "status" && rest.length === 0)
      return await api.get(SETUP_SURVEY_PATH, SetupSurveySnapshotSchema);
    if (verb === "start") {
      if (rest.length !== 0 && (rest.length !== 2 || rest[0] !== "--account")) throw new Error(USAGE);
      return await api.write(
        SETUP_SURVEY_PATH,
        { schemaVersion: 1, ...(rest[1] === undefined ? {} : { account: rest[1] }) },
        SetupSurveySnapshotSchema,
      );
    }
    if (verb === "apply" && rest[0] !== undefined)
      return await api.write(
        SETUP_SURVEY_APPLY_PATH,
        { schemaVersion: 1, surveyId: rest[0], lineIds: rest.slice(1) },
        SetupSurveySnapshotSchema,
      );
    if (verb === "cancel" && rest.length === 1)
      return await api.write(
        SETUP_SURVEY_CANCEL_PATH,
        { schemaVersion: 1, surveyId: rest[0] },
        SetupSurveySnapshotSchema,
      );
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 409)
      throw new Error(
        "A setup agent is already looking around, it has not proposed anything yet, or that setup has ended. Run `clankie setup-agent status`.",
      );
    throw error;
  }
  throw new Error(USAGE);
}
