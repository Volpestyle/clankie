import fs from "node:fs/promises";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const output = process.argv[2];
const preview = process.argv[3];
if (!output || !preview) throw new Error("usage: build-workbook.mjs OUTPUT_XLSX PREVIEW_PNG");

const workbook = Workbook.create();
const sheet = workbook.worksheets.add("Delivery Matrix");
sheet.showGridLines = false;
sheet.tabColor = "#18324A";

sheet.getRange("A2:F2").merge();
sheet.getRange("A2").values = [["Delivered file types and boundaries"]];
sheet.getRange("A2:F2").format = {
  font: { name: "Arial", size: 16, bold: true, color: "#000000" },
  verticalAlignment: "center",
};
sheet.getRange("A3:F3").merge();
sheet.getRange("A3").values = [
  ["VUH-1105 source-backed artifacts prepared for isolated publication and retrieval"],
];
sheet.getRange("A3:F3").format = { font: { name: "Arial", size: 10, italic: true, color: "#44546A" } };

sheet.getRange("A5:F10").values = [
  ["Deliverable", "Filename", "Format", "Content type", "Native action", "Source basis"],
  [
    "Report",
    "delivered-files-acceptance-report.docx",
    "DOCX",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "Preview and share",
    "ADR 0174 and server implementation",
  ],
  [
    "Spreadsheet",
    "delivered-files-evidence-matrix.xlsx",
    "XLSX",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Preview and share",
    "Protocol and consumer contract",
  ],
  [
    "Presentation",
    "delivered-files-workflow.pptx",
    "PPTX",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "Preview and share",
    "Delivery workflow and proof plan",
  ],
  [
    "Website bundle",
    "delivered-files-site-bundle.zip",
    "ZIP",
    "application/zip",
    "Save and share",
    "Static site source bundle",
  ],
  [
    "Maximum stored size",
    "Per artifact",
    "15 MiB",
    "Validated before storage",
    "Refuse oversize",
    "DELIVERED_FILE_BYTES_MAX",
  ],
];
sheet.getRange("A5:F5").format = {
  fill: "#18324A",
  font: { name: "Arial", size: 10, bold: true, color: "#FFFFFF" },
  horizontalAlignment: "center",
  verticalAlignment: "center",
  borders: { preset: "all", style: "thin", color: "#D9D9D9" },
};
sheet.getRange("A6:F10").format = {
  font: { name: "Arial", size: 10, color: "#1F1F1F" },
  verticalAlignment: "center",
  wrapText: true,
  borders: { preset: "all", style: "thin", color: "#D9D9D9" },
};
sheet.getRange("A6:F10").format.rowHeight = 42;

sheet.getRange("A12:F18").values = [
  ["Boundary", "Publisher", "Store", "Captain route", "Relay", "App"],
  [
    "Authentication",
    "Trusted local operation",
    "Private process access",
    "Operator bearer",
    "Device bearer and chat grant",
    "Keychain device session",
  ],
  [
    "Path",
    "Workspace realpath",
    "Content addressed path",
    "Strict POST body",
    "No path publication",
    "Host scoped relative route",
  ],
  [
    "Size",
    "15 MiB maximum",
    "Hash and byte metadata",
    "Declared and actual bytes",
    "Bounded upstream response",
    "Declared and actual bytes",
  ],
  [
    "Type",
    "Validated media type",
    "Stored metadata",
    "Preserved content type",
    "Preserved safe headers",
    "Native local file extension",
  ],
  [
    "Failure",
    "Typed refusal",
    "Unavailable on mismatch",
    "401 or 404",
    "Grant refusal",
    "Visible card error",
  ],
  [
    "Secrets",
    "No secret output",
    "No public URL",
    "Authorization header",
    "Authorization header",
    "No bearer in download URL",
  ],
];
sheet.getRange("A12:F12").format = {
  fill: "#DCE6F1",
  font: { name: "Arial", size: 10, bold: true, color: "#000000" },
  horizontalAlignment: "center",
  verticalAlignment: "center",
  borders: { preset: "all", style: "thin", color: "#D9D9D9" },
};
sheet.getRange("A13:F18").format = {
  font: { name: "Arial", size: 10, color: "#1F1F1F" },
  verticalAlignment: "center",
  wrapText: true,
  borders: { preset: "all", style: "thin", color: "#D9D9D9" },
};
sheet.getRange("A13:F18").format.rowHeight = 38;

sheet.getRange("A20:F20").values = [["Source", "Reference", "Purpose", "", "", ""]];
sheet.getRange("A20:C20").format = {
  fill: "#44546A",
  font: { name: "Arial", size: 10, bold: true, color: "#FFFFFF" },
  borders: { preset: "all", style: "thin", color: "#D9D9D9" },
};
sheet.getRange("A21:C24").values = [
  ["Architecture", "docs/adr/0174-conversation-delivered-files.md", "Retention and trust boundaries"],
  ["Operator contract", "docs/cli.md", "Publish and retrieve commands"],
  ["Server", "apps/clankie/src/delivered-files.ts", "Containment, limits, storage and hash verification"],
  ["Issue", "Linear VUH-1105", "Acceptance criteria"],
];
sheet.getRange("A21:C24").format = {
  font: { name: "Arial", size: 10, color: "#1F1F1F" },
  wrapText: true,
  verticalAlignment: "center",
  borders: { preset: "all", style: "thin", color: "#D9D9D9" },
};

sheet.getRange("A1:F24").format.font.name = "Arial";
sheet.getRange("A1:A24").format.columnWidth = 19;
sheet.getRange("B1:B24").format.columnWidth = 41;
sheet.getRange("C1:C24").format.columnWidth = 18;
sheet.getRange("D1:D24").format.columnWidth = 35;
sheet.getRange("E1:E24").format.columnWidth = 25;
sheet.getRange("F1:F24").format.columnWidth = 34;
sheet.freezePanes.freezeRows(5);

workbook.recalculate();
const inspection = await workbook.inspect({
  kind: "table",
  range: "Delivery Matrix!A2:F24",
  include: "values,formulas",
  tableMaxRows: 24,
  tableMaxCols: 6,
});
console.log(inspection.ndjson);
const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!",
  options: { useRegex: true, maxResults: 50 },
  summary: "final formula error scan",
});
console.log(errors.ndjson);

const rendered = await workbook.render({
  sheetName: "Delivery Matrix",
  range: "A1:F24",
  scale: 1.5,
  format: "png",
});
await fs.mkdir(new URL(".", `file://${output}`).pathname, { recursive: true }).catch(() => undefined);
await fs.writeFile(preview, new Uint8Array(await rendered.arrayBuffer()));
await (await SpreadsheetFile.exportXlsx(workbook)).save(output);
