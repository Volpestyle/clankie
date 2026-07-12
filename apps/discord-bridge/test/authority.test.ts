import { describe, expect, it } from "vitest";
import { authorizeAmbientCommand, parseRoleIds, refuseAmbientApproval } from "../src/authority.ts";

const bindings = {
  ambientRoleIds: new Set(["ambient-role"]),
  approvalRoleIds: new Set(["approval-role"]),
};

describe("Discord role authority", () => {
  it("denies ambient steering unless a configured role is present", () => {
    expect(authorizeAmbientCommand(new Set(["other-role"]), bindings)).toMatchObject({
      allowed: false,
      code: "role_not_authorized",
    });
    expect(authorizeAmbientCommand(new Set(["ambient-role"]), bindings)).toEqual({ allowed: true });
  });

  it("refuses approval visibly even for mapped roles and deep-links the authenticated surface", () => {
    const unauthorized = refuseAmbientApproval(
      new Set(["other-role"]),
      bindings,
      "https://operator.example/approvals",
      "approval-1",
    );
    expect(unauthorized).toMatchObject({ allowed: false, code: "role_not_authorized" });

    const mapped = refuseAmbientApproval(
      new Set(["approval-role"]),
      bindings,
      "https://operator.example/approvals",
      "approval-1",
    );
    expect(mapped).toMatchObject({ allowed: false, code: "authenticated_surface_required" });
    expect(mapped.message).toContain("https://operator.example/approvals?approval=approval-1");
  });

  it("parses comma-separated role bindings without empty ids", () => {
    expect([...parseRoleIds(" one, two ,,one ")]).toEqual(["one", "two"]);
  });
});
