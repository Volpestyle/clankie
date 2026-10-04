# Signed owner questions through the legacy relay

2026-10-04 source checkpoint. This extends the public conversation preference
foundation with a relay transport. The app's question UI and project confirmation
remain separate work.

A currently paired device with Take Control can send an owner workspace turn,
read a preference question, answer it, or cancel it through the relay's existing
`POST /operator/v1/dispatch` endpoint. The operations are `send`, `input_get`,
`input_answer`, and `input_cancel`, with the existing public protocol schemas and
shared client methods. The CLI's question commands and TUI `/question` continue
to use the same service contract. No new setting or command is required.

The relay forwards the original signed device token to the same direct control
service that answers its `/v1/devices/self` authorization checks. Local devices
use the control service's dispatch endpoint. When current device authorization
reports a hosted scope, the relay uses `/v1/hosted/operator`, whose existing
checks require a device minted for the hosted account operator. The service
reauthenticates the original token and current grants. Request fields, device
names, option labels and captain credentials cannot claim owner authority.

The relay checks current grants before dispatch and before releasing a result.
A chat-only device retains ordinary captain-backed sending without the question
tool capability. Question operations require Take Control. An owner route that
is unavailable or refused fails without falling back to captain authority. The
new hop accepts a direct HTTP(S) control origin; public gateway `/h/...` URLs are
not direct control origins and cannot be configured as this hop. Existing
public transport decrypts on the host before forwarding to the local relay.

An answer supplies the displayed immutable request ID, conversation incarnation,
revision and option ID or bounded text. These are preferences and context, never
project enrollment, configuration approval or a native-seat permission. Typed
`input_get` snapshots own pending and terminal details. Existing lifecycle event
shapes remain unchanged for older clients.

## Delivery and recovery

The relay does not cache or retry question mutations. The service stores an
answer and its original continuation run ID together. A duplicate answer
reconciles that receipt. A stored answer does not prove that the model has seen
it or completed its continuation.

Caller disconnect and the finite upstream timeout stop question/send HTTP work. They do
not cancel an answer or run already accepted by the service. After uncertain
delivery, read the exact request ID using `input_get`; do not automatically
resubmit the answer. Explicit `input_cancel` operates on the question and cannot
undo a stored answer. Restart never replays question continuations.

Ordinary send keeps its existing bounded relay deduplication key: device ID plus
exact request. A grant change or token refresh does not create a new send key.
The retained result is still subject to fresh authorization. This relay cache
is not durable exactly-once delivery: a failed or aborted first dispatch removes
the in-flight entry, and a later explicit send may be uncertain. The relay never
automatically resubmits it.

Responses are schema validated, redacted and marked no-store. Owner upstream
authorization refusals retain their HTTP status with a static error; upstream
bodies and credentials are omitted from errors and logs. The signed-token hop
refuses redirects and cannot target arbitrary operations.

## Verification scope

Focused fixtures use temporary signed device sessions, the production control
service, conversation store, relay handler, upstream dispatchers and public
client. A local encrypted transport fixture uses the existing public encryption
host and client. Stub runners request a preference and record the continuation;
no model, provider, owner settings or native-agent action is involved.

These fixtures do not establish mobile rendering or hosted production acceptance.
The app still needs exact-ID snapshot reconciliation and choice/text submission,
including its iPhone and iPad checks. Typed project CREATE confirmation remains a
separate owner operation. Native, room and authority-changing questions remain
outside this preference tool.
