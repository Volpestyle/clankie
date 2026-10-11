import { writeFileSync } from "node:fs";
import { relative } from "node:path";

// Release recovery needs completed file results, not a grep of console output.
export default class ReleaseTestReporter {
  onInit(vitest) {
    this.root = vitest.config.root;
  }

  onTestRunStart(specifications) {
    this.selected = specifications.map((spec) => relative(this.root, spec.moduleId));
  }

  onTestRunEnd(modules, errors, reason) {
    writeFileSync(
      process.env.CLANKIE_RELEASE_TEST_REPORT,
      JSON.stringify({
        version: 1,
        runId: process.env.CLANKIE_RELEASE_TEST_RUN_ID,
        selected: this.selected,
        reason,
        errors: errors.map((error) => ({ name: error.name, message: error.message })),
        files: modules.map((module) => ({
          path: relative(this.root, module.moduleId),
          state: module.state(),
          tests: [...module.children.allTests()].map((test) => ({
            name: test.fullName,
            state: test.result().state,
          })),
        })),
      }),
    );
  }
}
