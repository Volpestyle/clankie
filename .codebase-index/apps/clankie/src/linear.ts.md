# apps/clankie/src/linear.ts

Implements Clankie's Linear GraphQL port for issue search/get/create/update/comment and team listing. `createLinearPort()` resolves a brokered API key or OAuth access token, maps GraphQL nodes into small local types, and returns typed refusals for credentials and provider errors.

`resolveLinearBearer()` centralizes credential precedence; `defaultGraphql()` is the injectable HTTPS transport to `https://api.linear.app/graphql`.
