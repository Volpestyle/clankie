export const title = "Clankie's Discord character";
export const state = (v) =>
  ({
    absent: "No character session yet",
    starting: "Starting the isolated session",
    uncertain: "Launch uncertain; inspect the original",
    ready: "Room character is connected",
    answering: "Answering in the room's own history",
    approval: "Waiting for the owner's permission",
    replied: "Only this message's reply returns to Discord",
    withheld: "Configuration revoked; withhold the reply",
  })[v.phase];
export const step = (action) =>
  ({
    Message: "first admitted room message",
    Connect: "native channel connects",
    LostLaunchResponse: "launch response is lost",
    InspectOriginal: "find the existing session",
    Dispatch: "deliver the room message",
    RequestCommand: "character requests machine work",
    OwnerApproves: "owner approves in the native UI",
    OwnerDeclines: "owner declines",
    MachineWork: null,
    Reply: "send the correlated reply",
    NextMessage: "another message reuses the character",
    Revoke: "owner changes access",
    Done: null,
  })[action];
export const group = (v) =>
  v.phase === "approval" || v.phase === "uncertain"
    ? "waiting"
    : v.phase === "withheld"
      ? "stopped"
      : "normal";
export const colors = { waiting: "orange", stopped: "pink", normal: "teal" };
