import { FileCredentialStore, resolveGoogleBearer } from "@clankie/credential-broker";
import type { GoogleOAuthApp, GoogleOAuthEndpoints } from "@clankie/credential-broker";

const input = JSON.parse(process.argv[2] ?? "{}") as {
  path: string;
  config: GoogleOAuthApp;
  endpoints: GoogleOAuthEndpoints;
  now: number;
};
await resolveGoogleBearer({
  store: new FileCredentialStore(input.path),
  provider: "google-gmail",
  apps: async () => input.config,
  endpoints: input.endpoints,
  now: () => input.now,
});
process.stdout.write("refreshed\n");
