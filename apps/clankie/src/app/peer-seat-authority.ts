import { isDeepStrictEqual } from "node:util";
import type { PeerSeatAuthority } from "../captain/peer-seat-messages.ts";
import type { LocalFleetIdentity } from "../local-fleet-link.ts";

/** Peer attribution is native process authority, never an operator or fleet bearer. */
export async function peerSeatAuthority(
  identity: LocalFleetIdentity | undefined,
  pane: string | undefined,
): Promise<PeerSeatAuthority | undefined> {
  if (!identity || identity.pane !== pane) return undefined;
  const read = async () => {
    // Only the trusted local listener supplies this operation. Its project
    // proof already brackets socket ownership, pane/session and private registry
    // checks; repeating broad admission adds censuses, not another boundary.
    if (identity.admittedProjectProof) return identity.admittedProjectProof();
    // Remote listeners retain their independent transport and project checks.
    if (!(await identity.validate())) return undefined;
    const proof = await identity.projectProof?.();
    return (await identity.validate()) ? proof : undefined;
  };
  const proof = await read();
  if (
    !proof ||
    proof.nativeSessionPending ||
    proof.pane !== identity.pane ||
    proof.fleet !== (identity.fleet ?? "default")
  )
    return undefined;
  return {
    proof,
    validate: async () => isDeepStrictEqual(await read(), proof),
  };
}
