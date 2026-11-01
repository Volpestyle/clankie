const word = (v, b) => (v.has[b] ? v.st[b] : "fresh");
export const title = "Body transfer: who holds Clankie";
export const state = (v) => `S ${word(v, "S")}, A ${word(v, "A")}, B ${word(v, "B")}`;
export const step = (action, from, to) => {
  const changed = ["S", "A", "B"].filter((b) => JSON.stringify(from.rec[b]) !== JSON.stringify(to.rec[b]) || from.st[b] !== to.st[b]);
  const names = {
    Freeze: "freeze at", Stage: "stage the bundle at", Apply: "apply at", Boot: "boot and activate",
    Release: "release", Discard: "discard (burn) at", Abort: "abort at", Reclaim: "reclaim --force at",
  };
  return `${names[action] ?? action} ${changed.join(", ")}`;
};
