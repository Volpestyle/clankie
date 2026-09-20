import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FileBlob, Presentation, PresentationFile } from "@oai/artifact-tool";

const outputArgument = process.argv[2];
const renderArgument = process.argv[3];
const skillDirectory = process.argv[4];
const pythonExecutable = process.argv[5];
if (!outputArgument || !renderArgument || !skillDirectory || !pythonExecutable) {
  throw new Error("usage: build-presentation.mjs OUTPUT_PPTX RENDER_DIR SKILL_DIR PYTHON");
}
const output = path.resolve(outputArgument);
const renderDirectory = path.resolve(renderArgument);

const { applyPresentationChartFont, finalizePresentation } = await import(
  pathToFileURL(path.join(skillDirectory, "container_tools/artifact_tool_utils.mjs")).href
);
const family = "Arial";
const presentation = Presentation.create({ slideSize: { width: 1280, height: 720 } });

function addTitle(slide, text) {
  const title = slide.shapes.add({
    geometry: "textbox",
    position: { left: 72, top: 42, width: 1136, height: 64 },
    fill: "none",
    line: { fill: "none", width: 0 },
  });
  title.text = text;
  title.text.style = { typeface: family, fontSize: 38, bold: true, color: "#18324A", autoFit: "none" };
}

function addText(slide, text, position, options = {}) {
  const box = slide.shapes.add({
    geometry: "textbox",
    position,
    fill: options.fill ?? "none",
    line: options.line ?? { fill: "none", width: 0 },
  });
  box.text = text;
  box.text.style = {
    typeface: family,
    fontSize: options.fontSize ?? 22,
    bold: options.bold ?? false,
    color: options.color ?? "#1F1F1F",
    autoFit: "shrinkText",
    verticalAlignment: options.verticalAlignment ?? "middle",
    textAlignment: options.textAlignment ?? "left",
  };
  return box;
}

{
  const slide = presentation.slides.add();
  slide.background.fill = "#F7F9FC";
  addTitle(slide, "Delivered file workflow");
  addText(
    slide,
    "A deliberate file event connects a conversation to exact stored bytes and the device system viewer.",
    { left: 74, top: 112, width: 1110, height: 56 },
    { fontSize: 22, color: "#44546A" },
  );
  const stages = [
    ["1", "Publish", "Resolve an authorized workspace file"],
    ["2", "Store", "Hash and retain private content addressed bytes"],
    ["3", "Retrieve", "Authenticate POST and return exact bytes"],
    ["4", "Open or share", "Write protected local bytes and use native UI"],
  ];
  for (let index = 0; index < stages.length; index += 1) {
    const left = 74 + index * 290;
    addText(
      slide,
      stages[index][0],
      { left, top: 220, width: 54, height: 54 },
      { fill: "#18324A", color: "#FFFFFF", bold: true, fontSize: 25, textAlignment: "center" },
    );
    addText(
      slide,
      stages[index][1],
      { left, top: 294, width: 250, height: 42 },
      { bold: true, fontSize: 25, color: "#18324A" },
    );
    addText(
      slide,
      stages[index][2],
      { left, top: 344, width: 248, height: 128 },
      { fontSize: 20, verticalAlignment: "top" },
    );
  }
  addText(
    slide,
    "Source: ADR 0174 and the implemented captain, relay, and app consumer paths",
    { left: 74, top: 630, width: 1110, height: 34 },
    { fontSize: 15, color: "#667085" },
  );
  slide.speakerNotes.textFrame.setText(
    "Sources: docs/adr/0174-conversation-delivered-files.md; apps/clankie/src/delivered-files.ts; apps/relay/src/operator-conversations.ts; clankie-app DeliveredFileBlock and ExpoClankieFiles.",
  );
}

{
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  addTitle(slide, "Trust boundaries");
  const labels = [
    "Workspace containment",
    "15 MiB limit",
    "Header authentication",
    "Conversation and grant checks",
    "No secret download URL",
  ];
  const chart = slide.charts.add("bar", {
    position: { left: 78, top: 145, width: 1120, height: 430 },
    categories: labels,
    series: [{ name: "Enforced", values: [1, 1, 1, 1, 1], fill: "#2D6A8A" }],
    barOptions: { direction: "bar", grouping: "clustered" },
    hasLegend: false,
    dataLabels: { showValue: false },
  });
  applyPresentationChartFont(chart, { fontFamily: family });
  chart.xAxis = {
    minimumScale: 0,
    maximumScale: 1,
    majorUnit: 1,
    visible: false,
    textStyle: { typeface: family },
  };
  chart.yAxis = { textStyle: { typeface: family, fontSize: 18 } };
  addText(
    slide,
    "Each check fails closed before bytes reach an unrelated caller or path.",
    { left: 78, top: 590, width: 1120, height: 52 },
    { fontSize: 22, color: "#44546A" },
  );
  slide.speakerNotes.textFrame.setText(
    "Sources: apps/clankie/src/delivered-files.ts; apps/clankie/src/app.ts; apps/relay/src/operator-conversations.ts; packages/command-center/src/composer/liveCaptainTransport.ts.",
  );
}

{
  const slide = presentation.slides.add();
  slide.background.fill = "#F7F9FC";
  addTitle(slide, "Four sourced deliverables");
  const entries = [
    ["DOCX report", "Implementation contract and acceptance plan"],
    ["XLSX matrix", "File types, media types, actions, and boundaries"],
    ["PPTX deck", "Workflow and security summary"],
    ["ZIP website bundle", "Static HTML, CSS, JSON, README, and sources"],
  ];
  for (let index = 0; index < entries.length; index += 1) {
    const top = 154 + index * 118;
    addText(
      slide,
      entries[index][0],
      { left: 82, top, width: 300, height: 58 },
      { bold: true, fontSize: 25, color: "#18324A" },
    );
    addText(slide, entries[index][1], { left: 402, top, width: 790, height: 58 }, { fontSize: 22 });
  }
  addText(
    slide,
    "The isolated run publishes all four, retrieves them through the authenticated relay, restarts the host, and verifies byte identity again.",
    { left: 82, top: 620, width: 1110, height: 54 },
    { fontSize: 19, color: "#44546A" },
  );
  slide.speakerNotes.textFrame.setText(
    "Source: Linear VUH-1105 acceptance criteria and docs/testing/2026-09-20-delivered-files-live.",
  );
}

const workspaceDir = path.dirname(path.dirname(path.dirname(output)));
const stagingDirectory = path.join(workspaceDir, ".codex-finalizer");
await fs.mkdir(stagingDirectory, { recursive: true });
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.mkdir(renderDirectory, { recursive: true });
const candidate = path.join(stagingDirectory, "delivered-files-workflow-candidate.pptx");
await (await PresentationFile.exportPptx(presentation)).save(candidate);

await finalizePresentation({
  explicitTotalSlideCount: 3,
  requiredNativeTableOwnerSlides: [],
  requiredNativeChartOwnerSlides: [2],
  materializeLiteralChartWorkbooks: true,
  workspaceDir,
  candidatePath: candidate,
  finalPath: output,
  pythonExecutable,
  integrityValidatorPath: path.join(
    skillDirectory,
    "container_tools/inspect_presentation_package_integrity.py",
  ),
  layoutValidatorPath: path.join(skillDirectory, "container_tools/inspect_presentation_layout_geometry.py"),
  layoutArgs: [
    "--expected-slide-size-emu",
    "12192000,6858000",
    "--validate-bullet-geometry",
    "--validate-heading-fit",
  ],
  fontPolicy: { basis: "design", families: [family] },
  verifyArtifactToolImport: true,
  receiptPath: path.join(stagingDirectory, "delivered-files-workflow.validation.json"),
});

const checked = await PresentationFile.importPptx(await FileBlob.load(output));
for (let index = 0; index < checked.slides.items.length; index += 1) {
  const image = await checked.export({ slide: checked.slides.items[index], format: "png", scale: 1 });
  await fs.writeFile(
    path.join(renderDirectory, `presentation-slide-${index + 1}.png`),
    new Uint8Array(await image.arrayBuffer()),
  );
}
