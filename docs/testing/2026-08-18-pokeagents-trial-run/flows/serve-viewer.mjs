#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runArchiveViewerCli } from "../../serve-archive.mjs";

const archiveRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await runArchiveViewerCli({ argv: process.argv.slice(2), defaultArchive: archiveRoot });
