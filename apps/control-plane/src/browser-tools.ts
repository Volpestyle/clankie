import {
  BrowserToolCatalogSchema,
  CallBrowserToolResultSchema,
  type BrowserToolCatalog,
  type CallBrowserToolRequest,
  type CallBrowserToolResult,
} from "@clankie/protocol";

/**
 * Host-injected runner reader for Clankie's browser
 * ([ADR 0082](../../../docs/adr/0082-clankie-holds-the-browser.md)). The
 * control plane mediates and never owns the browser process or its profile.
 */
export interface BrowserToolPort {
  catalog(signal?: AbortSignal): Promise<BrowserToolCatalog>;
  call(request: CallBrowserToolRequest, signal?: AbortSignal): Promise<CallBrowserToolResult>;
}

export class RunnerBrowserToolClient implements BrowserToolPort {
  private readonly baseUrl: string;
  private readonly token: string;

  public constructor(options: { baseUrl: string; token: string }) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
      throw new Error("runner browser client requires an exact loopback HTTP origin");
    }
    if (!options.token) throw new Error("runner browser client requires a token");
    this.baseUrl = url.origin;
    this.token = options.token;
  }

  public async catalog(signal?: AbortSignal): Promise<BrowserToolCatalog> {
    const response = await fetch(`${this.baseUrl}/v1/browser/tools`, {
      headers: { authorization: `Bearer ${this.token}`, accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    if (response.status !== 200) throw new Error("runner_browser_catalog_failed");
    const value = (await response.json()) as { catalog?: unknown };
    return BrowserToolCatalogSchema.parse(value.catalog);
  }

  public async call(request: CallBrowserToolRequest, signal?: AbortSignal): Promise<CallBrowserToolResult> {
    const response = await fetch(`${this.baseUrl}/v1/browser/call`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      ...(signal ? { signal } : {}),
    });
    if (response.status !== 200) throw new Error("runner_browser_call_failed");
    const value = (await response.json()) as { result?: unknown };
    return CallBrowserToolResultSchema.parse(value.result);
  }
}
