# packages/credential-broker/src/stored-bearer.ts

Shared implementation for strongly generated local bearer credentials stored in the canonical credential store. `mintStoredBearer`, `resolveStoredBearer`, and `ensureStoredBearer` centralize entropy validation, stored-shape checks, bootstrap persistence, and typed missing/store-unavailable errors for the individual principal modules.
