# ADR 0001: Local-first execution plane

Status: accepted.

The runner executes on the user-controlled machine and makes outbound connections to optional hosted services. This keeps source, native provider sessions, local subscription authentication, terminals, and credentials near the user and makes the most sensitive component open and inspectable. Hosted services synchronize state and collaboration; they do not require inbound exposure of local PTYs.
