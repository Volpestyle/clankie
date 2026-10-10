# Tool grants

Clankie lends a connected service's tools through his worker MCP. A grant names
one connected server and only the tools the task needs, for at most 900
seconds, and is issued with the operator credential.

```bash
cat > req.json <<'EOF'
{"principalId":"<you or your session>","workId":"<the task>","server":"linear",
 "tools":[{"name":"list_issues"},{"name":"get_issue"},{"name":"save_issue"}],
 "ttlSeconds":900}
EOF
clankie access issue req.json --out grant.json   # 0600; never print the token
```

A tool rule can pin exact arguments (`"arguments": {"teamId": "..."}`) or forbid
some (`"forbiddenArguments": ["..."]`), enforced on every call. Narrow is the
default: grant a read tool for a read.

`grant.json` holds the endpoint (`<host>/v1/worker-mcp`) and a bearer token. A
harness with an HTTP MCP client can use it directly. Without one, call it with
[`call-grant.mjs`](call-grant.mjs):

```bash
node call-grant.mjs grant.json --list                       # tools, prefixed by server
node call-grant.mjs grant.json linear_list_issues '{"query":"tray"}'
```

When the task is done, or before handing off:

```bash
clankie access revoke "$(node -p 'require("./grant.json").grant.grantId')"
rm grant.json
```

Re-issue an expired grant rather than reusing one. `clankie access linear
verify` re-checks the Linear app connection itself.
