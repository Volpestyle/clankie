/**
 * The landing gate's static phases, in the order it runs them. The gate runs this
 * list, and the landing-selection fixture stubs exactly these inputs, so a new
 * phase cannot leave the fixture behind (#715, #716).
 */
export const landingPnpmChecks = [
  ["skills", "herdr:skill:check"],
  ["format", "fmt:check"],
  ["lint", "lint"],
  ["deadcode", "deadcode"],
];

/** Node checks; `base` passes the gate's fixed base revision as the argument. */
export const landingNodeChecks = [
  ["doc-links", "scripts/check-doc-links.mjs"],
  ["retired-claims", "scripts/check-retired-claims.mjs"],
  ["chromium-sandbox", "scripts/check-chromium-sandbox.mjs"],
  ["swallowed-rejections", "scripts/check-swallowed-rejections.mjs", "base"],
  ["extension-boundary", "scripts/check-extension-boundary.mjs"],
  ["docs-hygiene", "scripts/check-docs-hygiene.mjs", "base"],
];
