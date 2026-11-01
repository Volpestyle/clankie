import { readFileSync, writeFileSync } from "node:fs";
const [peleEntry, mmdPath, cssPath] = process.argv.slice(2);
const { render, PeleError } = await import(peleEntry);
const out = mmdPath.replace(/\.mmd$/, ".svg");
try {
  const r = render(readFileSync(mmdPath, "utf8"), {
    limit: 1_000_000,
    outputLimit: 8_000_000,
    maxEdges: 10_000,
  });
  const svg = r.svg ?? r.output ?? String(r);
  const css = readFileSync(cssPath, "utf8");
  writeFileSync(
    out,
    svg.replace(
      /(<svg[^>]*>)/,
      `$1<style>${css}</style><rect width="100%" height="100%" style="fill:var(--pele-bg,#fff)"/>`,
    ),
  );
  console.log(out);
} catch (e) {
  if (e instanceof PeleError) {
    console.error("PeleError:", e.message);
    process.exit(2);
  }
  throw e;
}
