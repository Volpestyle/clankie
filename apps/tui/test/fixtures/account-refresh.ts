// The running service's half of #791: a connector refreshing this Mac's account
// token in its own process, holding the credential lock across the refresh.
import { createClankieAccountTokenProvider, FileCredentialStore } from "@clankie/credential-broker";

const [gatewayUrl, credentialsPath] = process.argv.slice(2);
const token = await createClankieAccountTokenProvider({
  gatewayUrl: gatewayUrl!,
  store: new FileCredentialStore(credentialsPath!),
})();
process.stdout.write(JSON.stringify({ accountId: token.accountId }));
