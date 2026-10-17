import { HttpSettingsSchema } from "@clankie/protocol/owner-settings";

const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
const requestHeaders = new Set([
  "accept",
  "authorization",
  "cache-control",
  "content-type",
  "if-match",
  "if-none-match",
  "last-event-id",
  "range",
  "prefer",
  "x-clankie-conversation-id",
]);

/** Shared core/relay browser boundary. CORS is never authentication or native-loopback provenance. */
export async function httpCors(input: {
  path: string;
  method: string;
  headers: Headers;
  settings: () => Promise<unknown>;
}): Promise<{ headers: Record<string, string>; status?: 204 | 400 | 403 | 503 }> {
  if (!["/v1", "/operator/v1"].some((prefix) => input.path === prefix || input.path.startsWith(`${prefix}/`)))
    return { headers: {} };
  const headers: Record<string, string> = { vary: "Origin" };
  const origin = input.headers.get("origin");
  if (origin === null) return { headers };
  let allowed: string[];
  try {
    allowed = HttpSettingsSchema.parse(await input.settings()).allowedOrigins;
  } catch {
    return { headers, status: 503 };
  }
  if (!allowed.includes(origin)) return { headers, status: 403 };
  if (input.method === "OPTIONS") {
    headers.vary = "Origin, Access-Control-Request-Method, Access-Control-Request-Headers";
    const method = input.headers.get("access-control-request-method");
    const rawHeaders = input.headers.get("access-control-request-headers");
    const requested = rawHeaders === null ? [] : rawHeaders.split(",").map((h) => h.trim().toLowerCase());
    if (!method || !methods.includes(method) || requested.some((h) => !requestHeaders.has(h)))
      return { headers, status: 400 };
    return {
      status: 204,
      headers: {
        ...headers,
        "access-control-allow-origin": origin,
        "access-control-allow-methods": method,
        ...(requested.length ? { "access-control-allow-headers": requested.join(", ") } : {}),
        "access-control-max-age": "300",
      },
    };
  }
  return {
    headers: {
      ...headers,
      "access-control-allow-origin": origin,
      "access-control-expose-headers":
        "content-disposition, etag, location, retry-after, x-clankie-request-id",
    },
  };
}
