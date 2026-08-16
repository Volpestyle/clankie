# docs/adr/0051-layered-character-register-and-reply-policy.md

Decision to separate stable character identity, operating constraints, conversational register, and channel reply policy. Owners author these layers in settings/persona files; callers and untrusted room content cannot rewrite them.
