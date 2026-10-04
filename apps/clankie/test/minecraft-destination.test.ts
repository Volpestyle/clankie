import { expect, it, vi } from "vitest";
import { MinecraftSettingsSchema } from "@clankie/settings";
import {
  minecraftProfiles,
  resolveMinecraftProfile,
  type MinecraftDestinationDns,
} from "../src/minecraft-destination.ts";

function settings(host: string, publicAllowlist: { host: string; port?: number }[] = [], port = 25_565) {
  return MinecraftSettingsSchema.parse({
    profiles: [{ id: "paper", name: "Paper", host, port, version: "1.21.4" }],
    publicAllowlist,
  });
}
function dns(addresses: string[], records: Awaited<ReturnType<MinecraftDestinationDns["resolveSrv"]>> = []) {
  return {
    lookup: vi
      .fn<MinecraftDestinationDns["lookup"]>()
      .mockResolvedValue(addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))),
    resolveSrv: vi.fn<MinecraftDestinationDns["resolveSrv"]>().mockResolvedValue(records),
  };
}

it("allows loopback/private LAN addresses and returns a pinned dial IP without DNS for literals", async () => {
  for (const host of [
    "127.0.0.1",
    "127.12.1.3",
    "10.1.2.3",
    "172.16.5.1",
    "172.31.255.254",
    "192.168.1.2",
    "::1",
    "fd12::2",
    "::ffff:192.168.1.2",
    "0:0:0:0:0:ffff:c0a8:102",
  ]) {
    const resolver = dns([]);
    expect(await resolveMinecraftProfile(settings(host), "paper", { dns: resolver })).toMatchObject({
      host,
      auth: "offline",
    });
    expect(resolver.lookup).not.toHaveBeenCalled();
    expect(resolver.resolveSrv).not.toHaveBeenCalled();
  }
  const resolver = dns(["192.168.1.2"]);
  expect(await resolveMinecraftProfile(settings("world.lan"), "paper", { dns: resolver })).toMatchObject({
    host: "192.168.1.2",
  });
});

it("refuses public destinations without exact owner approval and rejects mixed DNS answers", async () => {
  await expect(
    resolveMinecraftProfile(settings("world.example"), "paper", { dns: dns(["203.0.113.5"]) }),
  ).rejects.toThrow("destination_unapproved");
  await expect(
    resolveMinecraftProfile(settings("world.example"), "paper", { dns: dns(["192.168.1.2", "203.0.113.5"]) }),
  ).rejects.toThrow("destination_unapproved");
  await expect(
    resolveMinecraftProfile(settings("world.example", [{ host: "world.example", port: 25566 }]), "paper", {
      dns: dns(["203.0.113.5"]),
    }),
  ).rejects.toThrow("destination_unapproved");
  expect(
    await resolveMinecraftProfile(settings("world.example", [{ host: "world.example" }]), "paper", {
      dns: dns(["203.0.113.5"]),
    }),
  ).toMatchObject({ host: "203.0.113.5", port: 25_565 });
});

it("checks SRV target host and port instead of trusting approval of the original hostname", async () => {
  const records = [{ name: "dial.example.", port: 25566, priority: 0, weight: 1 }];
  const resolver = dns(["203.0.113.5"], records);
  await expect(
    resolveMinecraftProfile(settings("world.example", [{ host: "world.example" }]), "paper", {
      dns: resolver,
    }),
  ).rejects.toThrow("destination_unapproved");
  expect(
    await resolveMinecraftProfile(
      settings("world.example", [{ host: "dial.example", port: 25566 }]),
      "paper",
      { dns: resolver },
    ),
  ).toMatchObject({ host: "203.0.113.5", port: 25566 });
  expect(resolver.lookup).toHaveBeenCalledWith("dial.example");
  const explicitPort = dns(["192.168.1.2"], records);
  await resolveMinecraftProfile(settings("world.lan", [], 25566), "paper", { dns: explicitPort });
  expect(explicitPort.resolveSrv).not.toHaveBeenCalled();
});

it("fails closed on DNS errors, empty answers and non-unicast endpoints without exposing endpoint material", async () => {
  const resolver = dns(["192.168.1.2"]);
  resolver.resolveSrv.mockRejectedValueOnce(
    Object.assign(new Error("lookup world.example secret detail"), { code: "ETIMEOUT" }),
  );
  await expect(
    resolveMinecraftProfile(settings("world.example"), "paper", { dns: resolver }),
  ).rejects.toThrow(/^destination_unavailable$/u);
  resolver.resolveSrv.mockRejectedValueOnce(Object.assign(new Error("not found"), { code: "ENODATA" }));
  expect(await resolveMinecraftProfile(settings("world.lan"), "paper", { dns: resolver })).toMatchObject({
    host: "192.168.1.2",
  });
  await expect(resolveMinecraftProfile(settings("world.lan"), "paper", { dns: dns([]) })).rejects.toThrow(
    "destination_unavailable",
  );
  for (const host of ["0.0.0.0", "224.0.0.1", "::", "ff02::1", "fe80::1"]) {
    await expect(
      resolveMinecraftProfile(settings(host, [{ host }]), "paper", { dns: resolver }),
    ).rejects.toThrow("destination_unapproved");
  }
  await expect(resolveMinecraftProfile(settings("127.0.0.1"), "missing")).rejects.toThrow("unknown_profile");
  expect(minecraftProfiles(settings("127.0.0.1"))).toEqual([{ id: "paper", name: "Paper" }]);
});
