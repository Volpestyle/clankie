export interface EvidencePushReceipt {
  readonly receiptId: string;
  readonly state: "applied" | "pending" | "refused";
  readonly sha256: string;
  readonly size: number;
  readonly url: string;
  readonly uploadUrl?: string | undefined;
  readonly refusal?: string | undefined;
}
export interface EvidencePushClient {
  upload(
    request: Record<string, unknown> & { idempotencyKey: string; sha256: string },
  ): Promise<EvidencePushReceipt>;
  receipt(receiptId: string): Promise<EvidencePushReceipt | undefined>;
  putBlob(uploadUrl: string, file: string, size: number): Promise<EvidencePushReceipt>;
}
export interface EvidencePushInput {
  path?: string;
  issueKey?: string;
  caption?: string;
  project?: string;
  repo?: string;
  model?: string;
  outcome?: string;
}
export interface EvidencePushResult {
  readonly ok: boolean;
  readonly manifest?: string;
  readonly issueKey?: string;
  readonly issueSource?: string;
  readonly manifestChanged: boolean;
  readonly uploaded: number;
  readonly added: readonly { path: string; url: string }[];
  readonly changed: readonly { path: string; url: string }[];
  readonly moved: readonly { from: string; to: string }[];
  readonly receipts: readonly { path: string; receiptId: string; state: string }[];
  readonly failures: readonly { path: string; reason: string }[];
  readonly summary: string;
}
export const MANIFEST: string;
export const MIRROR: string;
export const EVIDENCE_PUSH_TOOL: { name: string; description: string; inputSchema: object };
export function callEvidencePush(
  args: unknown,
  client: () => Promise<EvidencePushClient>,
): Promise<{ isError?: boolean; content: { type: "text"; text: string }[] }>;
export function repoRootOf(cwd: string): Promise<string>;
export function evidenceRoots(repo: string): Promise<readonly string[]>;
export function posix(path: string): string;
export function sha256File(path: string): Promise<string>;
export function exists(path: string): Promise<boolean>;
export function inside(parent: string, child: string): boolean;
export function refusal(repoRelative: string, roots: readonly string[]): Error;
export function pushEvidence(
  input: EvidencePushInput,
  options: {
    cwd?: string;
    client: () => Promise<EvidencePushClient>;
    issueKeys?: {
      teams(repo: string): Promise<readonly string[]>;
      fromText(text: string, teams: readonly string[]): string[];
      fromReadme(text: string, teams: readonly string[]): string[];
    };
  },
): Promise<EvidencePushResult>;
export function linkEvidenceClient(options: {
  origin: string;
  request: (route: string, suffix?: string, init?: RequestInit) => Promise<Response>;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}): EvidencePushClient;
