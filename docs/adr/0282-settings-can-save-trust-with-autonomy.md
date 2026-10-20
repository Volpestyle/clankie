# ADR 0282: Settings can save trust with autonomy

Status: accepted for VUH-2525, 2026-10-20.

The app presents Maximum trust as the top autonomy choice. Storage and the
existing CLI switch remain independent for compatibility. An opt-in
`includeMaximumTrust=true` fleet read returns the saved trust boolean and a
revision covering both trust and fleet policy. A POST to that same URL can
change autonomy leaves and trust atomically. Trust writes require the opt-in
revision; legacy clients retain their snapshot and revision shape. Other API
writes to trust invalidate a stale opt-in save. This amends ADR 0263's UI
separation without changing the meaning of its four policy levels.

The existing hire-defaults GET accepts `includeModels=true` and returns Claude
and Codex model IDs and names from the host's model registry. It neither changes
saved defaults nor performs account actions. Legacy reads and writes omit the
catalog. The app preserves a model saved elsewhere until the user explicitly
changes it. Both opt-ins use the existing owner authorization and relay routes.
