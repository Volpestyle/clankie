import { expect, it, vi } from "vitest";
import { linearProjectExists } from "../src/linear-project-binding.ts";

const id = "bdfa8c5a-933d-4f59-abf7-db42f81e45d1";
function host(project: unknown) {
  return {
    account: vi.fn().mockResolvedValue({ binding: "verified-linear", account: {} }),
    call: vi.fn().mockResolvedValue({ outcome: "ok", isError: false, content: JSON.stringify(project) }),
  } as unknown as Parameters<typeof linearProjectExists>[0];
}

it("accepts the verified remote connection's exact UUID without an API credential", async () => {
  const connection = host({ id: "P-VUH-17", uuid: id });
  expect(await linearProjectExists(connection, id)).toBe(true);
  expect(connection.call).toHaveBeenCalledWith(
    expect.objectContaining({
      server: "linear",
      tool: "get_project",
      arguments: { query: id },
    }),
  );
});
it("accepts the selected API connection and rejects another project's UUID", async () => {
  expect(await linearProjectExists(host({ id }), id)).toBe(true);
  expect(await linearProjectExists(host({ id, uuid: "another-project" }), id)).toBe(false);
});
it("refuses a local tracker without a verified account before reading", async () => {
  const connection = host({ id });
  vi.mocked(connection.account).mockRejectedValue(new Error("local tracker"));
  await expect(linearProjectExists(connection, id)).rejects.toThrow("local tracker");
  expect(connection.call).not.toHaveBeenCalled();
});
it("refuses a connection changed during validation", async () => {
  const connection = host({ id });
  vi.mocked(connection.account)
    .mockResolvedValueOnce({ binding: "before", account: {} } as never)
    .mockResolvedValueOnce({ binding: "after", account: {} } as never);
  await expect(linearProjectExists(connection, id)).rejects.toThrow("Linear connection changed");
});
it("keeps provider failure unavailable instead of approving or falling back", async () => {
  const connection = host({ id });
  vi.mocked(connection.call).mockResolvedValue({ outcome: "ok", isError: true, content: "unavailable" });
  await expect(linearProjectExists(connection, id)).rejects.toThrow("Bound Linear project unavailable");
});
