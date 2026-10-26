// Resolves the operator credential the way any `clankie` command does and prints
// only the outcome: never the token. Run inside and outside the worker sandbox.
import { OperatorCredentialError, resolveOperatorCredential } from "@clankie/credential-broker";

try {
  const credential = await resolveOperatorCredential({ env: process.env });
  console.log(
    JSON.stringify(credential ? { outcome: "resolved", source: credential.source } : { outcome: "none" }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      outcome: "refused",
      code: error instanceof OperatorCredentialError ? error.code : "other",
    }),
  );
}
