import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";

// Release recovery needs completed file results, not a grep of console output.
export default class ReleaseTestReporter {
  onInit(vitest) {
    this.root = vitest.config.root;
  }

  onTestRunStart(specifications) {
    this.selected = specifications.map((spec) => relative(this.root, spec.moduleId));
    // A fresh CI checkout has no .local yet.
    mkdirSync(dirname(process.env.CLANKIE_RELEASE_TEST_REPORT), { recursive: true });
    this.running = new Set();
  }

  // The report is written only when the run ends. A run killed first, such as a hung
  // file at the job's timeout, leaves this list of the files still running (#593).
  onTestModuleStart(module) {
    this.running.add(relative(this.root, module.moduleId));
    this.writeRunning();
  }

  onTestModuleEnd(module) {
    this.running.delete(relative(this.root, module.moduleId));
    this.writeRunning();
  }

  writeRunning() {
    writeFileSync(`${process.env.CLANKIE_RELEASE_TEST_REPORT}.running`, JSON.stringify([...this.running]));
  }

  onTestRunEnd(modules, errors, reason) {
    rmSync(`${process.env.CLANKIE_RELEASE_TEST_REPORT}.running`, { force: true });
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
          // Load errors and failed hooks belong to the file or a suite, not to a test.
          suiteErrors: [module, ...module.children.allSuites()].reduce(
            (count, suite) => count + suite.errors().length,
            0,
          ),
          tests: [...module.children.allTests()].map((test) => ({
            name: test.fullName,
            state: test.result().state,
          })),
        })),
      }),
    );
  }
}
