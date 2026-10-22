import { expect, it } from "vitest";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { ClankieSettingsSchema, emptySettings } from "@clankie/settings";
import { remoteWorkspaceProject, reviewCheckoutProject } from "../src/captain/project-hire-context.ts";

// VUH-2662: a review candidate's project comes from the checkout its author names.
// A remote Windows author's Git prints its toplevel as C:/…; the owner registers C:\….
it("a remote Windows author's forward-slash toplevel names its registered project", async () => {
  const settings = ClankieSettingsSchema.parse({
    ...emptySettings(),
    machines: [{ id: "pc", ssh: "james@pc", shell: "powershell" }],
    execution: {
      ...emptySettings().execution,
      connections: [
        { id: "pc", machine: "pc", session: "default", ssh: { host: "james@pc", shell: "powershell" } },
      ],
    },
    projects: ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "garden",
          name: "Garden",
          workspaces: [{ id: "pc", machineId: "pc", platform: "windows", path: "C:\\Users\\james\\repo" }],
        },
      ],
    }),
  });
  // Without normalizing, Git for Windows' own spelling matches nothing.
  expect(remoteWorkspaceProject(settings, settings.projects, "pc", "C:/Users/james/repo")).toBeUndefined();
  for (const checkout of ["C:/Users/james/repo", "c:/Users/james/repo", "C:/Users/james/repo/packages/app"])
    expect(await reviewCheckoutProject(settings, "pc/term_author", checkout), checkout).toBe("garden");
  for (const checkout of ["D:/Users/james/repo", "C:/Users/james/other"])
    expect(await reviewCheckoutProject(settings, "pc/term_author", checkout), checkout).toBeUndefined();
  // A seat with no named checkout and no directory has no project.
  expect(await reviewCheckoutProject(settings, "pc/term_author", undefined)).toBeUndefined();
});
