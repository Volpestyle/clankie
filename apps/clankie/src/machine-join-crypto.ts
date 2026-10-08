import { createHash } from "node:crypto";

/** Routing hashes reveal no approval secret. Keys stay at the two endpoints. */
export const machineJoinHash = (value: string): string => createHash("sha256").update(value).digest("hex");
export const machineJoinKey = (secret: string): Buffer =>
  createHash("sha256").update(`clankie-machine-join-key-v1:${secret}`).digest();
