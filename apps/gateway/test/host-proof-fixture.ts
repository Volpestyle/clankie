import { once } from "node:events";
import { WebSocket } from "ws";
import type { InstallationKey } from "../../../packages/credential-broker/src/index.ts";
import {
  PUBLIC_GATEWAY_HOST_CONNECT_PATH,
  PUBLIC_GATEWAY_HOST_PROOF_HEADER,
  PublicGatewayHostChallengeSchema,
  publicGatewayHostProofPayload,
} from "@clankie/protocol/public-gateway";

/** Real socket handshake. Caller owns socket cleanup, including on refusal. */
export function accountHost(
  origin: string,
  hostId: string,
  installationId: string,
  token: string,
  proof = true,
): WebSocket {
  return new WebSocket(
    `${origin.replace("http", "ws")}${PUBLIC_GATEWAY_HOST_CONNECT_PATH}?hostId=${hostId}&installationId=${installationId}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        ...(proof ? { [PUBLIC_GATEWAY_HOST_PROOF_HEADER]: "1" } : {}),
      },
    },
  );
}

export async function proveHost(
  socket: WebSocket,
  hostId: string,
  installationId: string,
  key: InstallationKey,
  payload?: (nonce: string) => string,
): Promise<{ kind: string } | { code: number; reason: string }> {
  const [data] = await once(socket, "message");
  const challenge = PublicGatewayHostChallengeSchema.parse(JSON.parse(data.toString()));
  const result = new Promise<{ kind: string } | { code: number; reason: string }>((resolve, reject) => {
    socket.once("message", (frame) => resolve(JSON.parse(frame.toString())));
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      kind: "host_proof",
      publicKey: key.publicKey,
      signature: key.sign(
        payload?.(challenge.nonce) ?? publicGatewayHostProofPayload(hostId, installationId, challenge.nonce),
      ),
    }),
  );
  return result;
}
