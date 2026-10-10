import { writeFileSync } from "node:fs";
import { relative } from "node:path";

/**
 * Records what the landing gate's `--changed` run depended on (VUH-2024): each
 * selected test module and the local imports Vitest itself walked to select
 * it. A later base move that touches none of these cannot change the result.
 */
export default class LandingGraphReporter {
  onInit(vitest) {
    this.vitest = vitest;
  }

  async onTestRunEnd(testModules) {
    const output = process.env.CLANKIE_LANDING_GRAPH;
    if (!output) return;
    const root = this.vitest.config.root;
    const local = (path) => relative(root, path).replaceAll("\\", "/");
    const dependencies = new Set();
    for (const module of testModules) {
      dependencies.add(local(module.moduleId));
      const specification = module.project.createSpecification(module.moduleId);
      for (const path of await this.vitest.specifications.getTestDependencies(specification))
        dependencies.add(local(path));
    }
    writeFileSync(
      output,
      JSON.stringify({
        testModules: testModules.map((module) => local(module.moduleId)).sort(),
        dependencies: [...dependencies].filter((path) => !path.startsWith("../")).sort(),
      }),
    );
  }
}
