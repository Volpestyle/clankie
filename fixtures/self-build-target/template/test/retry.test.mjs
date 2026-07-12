import assert from "node:assert/strict";
import { retry } from "../src/retry.mjs";

let attempts = 0;
const result = await retry(
  async () => {
    attempts += 1;
    if (attempts < 3) throw new Error(`transient-${attempts}`);
    return "recovered";
  },
  { maxAttempts: 3 },
);

assert.equal(result, "recovered");
assert.equal(attempts, 3, "retry must permit all configured attempts");

let failedAttempts = 0;
await assert.rejects(
  retry(
    async () => {
      failedAttempts += 1;
      throw new Error("permanent");
    },
    { maxAttempts: 2 },
  ),
  /permanent/,
);
assert.equal(failedAttempts, 2, "retry must stop at maxAttempts");

console.log("retry fixture: PASS");
