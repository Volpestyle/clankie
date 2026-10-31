import { appendFileSync } from "node:fs";
import { Layer, Logger, LogLevel, References } from "effect";

/**
 * Two sinks for one run: every log line, debug included, as JSON in `run.jsonl`
 * (level, message, the flow and step annotations, span timings), and info and above
 * as a readable line on the terminal. The JSON file is what CI keeps.
 */
export const runLoggers = (jsonPath: string) => {
  const pretty = Logger.consolePretty({ colors: process.stdout.isTTY === true });
  return Layer.mergeAll(
    Logger.layer([
      Logger.map(Logger.formatJson, (line) => appendFileSync(jsonPath, `${line}\n`)),
      Logger.make((options) => {
        if (!LogLevel.isLessThan(options.logLevel, "Info")) pretty.log(options);
      }),
    ]),
    Layer.succeed(References.MinimumLogLevel, "Debug"),
  );
};
