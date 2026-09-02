import { access, glob, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, posix, resolve } from "node:path";
import { buildPublicDocs } from "./build.mjs";

const outputDir = await mkdtemp(resolve(tmpdir(), "clankie-docs-check-"));
try {
  await checkPublicDocs(outputDir);
} finally {
  await rm(outputDir, { recursive: true, force: true });
}

async function checkPublicDocs(outputDir) {
  await buildPublicDocs(outputDir);
  const htmlFiles = [];
  for await (const file of glob("**/*.html", { cwd: outputDir })) htmlFiles.push(file);

  const failures = [];
  for (const file of htmlFiles) {
    const absolute = resolve(outputDir, file);
    const source = await readFile(absolute, "utf8");
    if (source.includes("{{")) failures.push(`${file}: unresolved template marker`);

    const ids = new Set([...source.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    for (const match of source.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
      const target = match[1];
      if (/^(?:https?:|mailto:)/u.test(target)) continue;
      const [location, fragment] = target.split("#", 2);
      let targetFile = file;
      if (location.length > 0) {
        const relative = location.startsWith("/")
          ? location.slice(1)
          : posix.normalize(posix.join(posix.dirname(file), location));
        targetFile =
          relative.length === 0 ? "index.html" : relative.endsWith("/") ? `${relative}index.html` : relative;
        if (extname(targetFile) === "") targetFile = `${targetFile}/index.html`;
        try {
          await access(resolve(outputDir, targetFile));
        } catch {
          failures.push(`${file}: missing ${target}`);
          continue;
        }
      }
      if (fragment !== undefined && fragment.length > 0) {
        const targetSource =
          targetFile === file ? source : await readFile(resolve(outputDir, targetFile), "utf8");
        const targetIds =
          targetFile === file
            ? ids
            : new Set([...targetSource.matchAll(/\bid="([^"]+)"/g)].map((idMatch) => idMatch[1]));
        if (!targetIds.has(fragment)) failures.push(`${file}: missing anchor ${target}`);
      }
    }
  }

  if (failures.length > 0) {
    console.error("Public docs check failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`Checked ${htmlFiles.length} public docs pages; links and anchors resolve.`);
  }
}
