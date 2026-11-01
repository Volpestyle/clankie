export const title = "Clankie routing design: return to the same live session";

const runners = {
  seat: "Claude Code lead is on it",
  pi: "Clankie's service model is on it",
  worker: "The worker who owns it is on it",
  app: "Your connected app is on it",
  room: "Clankie chats in his isolated room session",
};

export const state = (v) => {
  switch (v.status) {
    case "idle":
      return "Nothing waiting";
    case "arrived":
      return "Core checks the previous session, then fallback";
    case "held":
      return "Waiting in the owner inbox";
    case "paused":
      return "Paused; remembers the previous session";
    case "answered":
      return "Answered";
    case "notServed":
      return "Isolated room session unavailable";
    case "working":
      return runners[v.runner];
  }
  return v.status;
};

export const group = (v) =>
  ({
    idle: "rest",
    answered: "rest",
    notServed: "rest",
    arrived: "core",
    held: "held",
    paused: "held",
    working: "busy",
  })[v.status];

export const colors = { rest: "teal", core: "blue", held: "orange", busy: "purple" };

export const step = (action, from, to) => {
  switch (action) {
    case "Arrive":
      return "a tag or room message reaches Clankie";
    case "Route":
      if (to.status === "held") return "no owner session is available";
      if (to.status === "notServed") return "no isolated room session is available";
      if (from.resumeRunner !== "none" && to.runner === from.resumeRunner)
        return "resume the same live session";
      if (from.resumeRunner !== "none") return "previous session unavailable; permitted fallback";
      if (to.runner === "room") return "use the isolated character session";
      if (to.runner === "worker") return "deliver to the worker who owns it";
      return "push to an available owner session";
    case "Finish":
      return "answer through the original surface";
    case "Reset":
      return null;
    case "AppReadsInbox":
      return from.status === "held" ? "app connects; core pushes held work" : null;
    case "SeatStarts":
      return from.status === "held" ? "lead starts; core pushes held work" : null;
    case "PiStarts":
      return from.status === "held" ? "service model becomes available" : null;
    case "RoomStarts":
      return null;
    case "SeatStops":
      return from.runner === "seat" ? "lead pane ends; retain the request" : null;
    case "PiStops":
      return from.runner === "pi" ? "service model becomes unavailable" : null;
    case "AppStops":
      return from.runner === "app" ? "app disconnects" : null;
    case "RoomStops":
      return from.runner === "room" ? "room session ends" : null;
    case "WorkerStops":
      return from.runner === "worker" ? "owning worker ends" : null;
    case "Sleep":
      return "Mac sleeps; retain the previous runner";
    case "Wake":
      return "Mac wakes; route the retained request";
    case "WorkerComesOrGoes":
      return null;
  }
  return action;
};
