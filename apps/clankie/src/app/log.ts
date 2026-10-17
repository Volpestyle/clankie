import { createLogger } from "@clankie/observability";
import packageMetadata from "../../../../package.json" with { type: "json" };

/** The install's version, the one `clankie --version` prints; the app package's own stays 0.2.0. */
export const CLANKIE_VERSION = packageMetadata.version;
export const logger = createLogger({ service: "clankie", version: CLANKIE_VERSION });
