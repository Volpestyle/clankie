// Loaded by the installed Pi through its extension loader, exactly as
// worker.mjs is, but only inside probe.mjs's isolated process.
export default function clankiePiProbe(pi) {
  globalThis[Symbol.for("clankie.pi-worker.probe")]?.(pi);
}
