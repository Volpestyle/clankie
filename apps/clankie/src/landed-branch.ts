import { z } from "zod";
import {
  mainCheckpoint,
  MainCheckpointRefused,
  type GithubApi,
  type MainCheckpointCache,
} from "@clankie/work-items";

const Sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
const Repository = z.object({ id: z.number().int().positive(), full_name: z.string() });
const Pull = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
  state: z.literal("closed"),
  merged: z.literal(true),
  merged_at: z.string().datetime(),
  merge_commit_sha: Sha,
  head: z.object({ ref: z.string(), sha: Sha, repo: Repository }),
  base: z.object({ ref: z.literal("main"), repo: Repository }),
});
export const LandedBranchProofSchema = z
  .object({
    repository: z.string(),
    repositoryId: z.number().int().positive(),
    accountId: z.number().int().positive(),
    branchRef: z.string().startsWith("refs/heads/"),
    startHead: Sha,
    hiredAt: z.string().datetime(),
    head: Sha,
    merge: Sha,
    main: Sha,
    pull: z.number().int().positive(),
    url: z.string().url(),
  })
  .strict();
type LandedBranchProof = z.infer<typeof LandedBranchProofSchema>;
export interface LandedBranchObservation {
  readonly proof: LandedBranchProof;
  /** Fresh mutable provider reads, never a cached branch or account decision. */
  revalidate(): Promise<void>;
}
const unknown = () =>
  new MainCheckpointRefused({
    reason: "main_unknown",
    failingJobs: [],
    detail: "Canonical landed branch proof unavailable or changed",
  });

/** Positive canonical evidence only. A PR URL, name match or missing ref is not proof. */
export async function observeLandedBranch(
  api: GithubApi,
  repository: string,
  launch: { branchRef: string; startHead: string; hiredAt: string },
  cache: MainCheckpointCache,
): Promise<LandedBranchObservation> {
  if (
    !/^[\w.-]+\/[\w.-]+$/u.test(repository) ||
    !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(launch.branchRef) ||
    launch.branchRef.includes("..") ||
    !Sha.safeParse(launch.startHead).success ||
    !Number.isFinite(Date.parse(launch.hiredAt))
  )
    throw unknown();
  const branch = launch.branchRef.slice("refs/heads/".length);
  const root = `repos/${repository}`;
  const refPath = `${root}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`;
  const readRef = async () => {
    const ref = z
      .object({ ref: z.literal(launch.branchRef), object: z.object({ type: z.literal("commit"), sha: Sha }) })
      .parse(await api.request("GET", refPath));
    return ref.object.sha;
  };
  const readMain = async () =>
    z.object({ sha: Sha }).parse(await api.request("GET", `${root}/commits/main`)).sha;
  const [repo, account, head, main] = await Promise.all([
    api.request("GET", root).then((x) => Repository.parse(x)),
    api.request("GET", "user").then((x) => z.object({ id: z.number().int().positive() }).parse(x)),
    readRef(),
    readMain(),
  ]);
  if (repo.full_name.toLowerCase() !== repository.toLowerCase()) throw unknown();
  const matching = (pull: z.infer<typeof Pull>) =>
    pull.head.ref === branch &&
    pull.head.sha === head &&
    pull.head.repo.id === repo.id &&
    pull.base.repo.id === repo.id &&
    pull.head.repo.full_name.toLowerCase() === repository.toLowerCase() &&
    pull.base.repo.full_name.toLowerCase() === repository.toLowerCase() &&
    Date.parse(pull.merged_at) > Date.parse(launch.hiredAt) &&
    pull.html_url === `https://github.com/${repo.full_name}/pull/${pull.number}`;
  const candidates = await api.list(
    `${root}/pulls?state=closed&base=main&head=${encodeURIComponent(`${repository.split("/")[0]}:${branch}`)}&per_page=100`,
  );
  const merged = candidates
    .flatMap((candidate) => {
      // List responses omit `merged`; the canonical pull read below must prove it.
      const item = z
        .object({
          number: z.number().int().positive(),
          merged_at: z.string().nullable(),
          head: z.object({ ref: z.string(), sha: Sha }),
        })
        .safeParse(candidate);
      return item.success &&
        item.data.merged_at &&
        item.data.head.ref === branch &&
        item.data.head.sha === head &&
        Date.parse(item.data.merged_at) > Date.parse(launch.hiredAt)
        ? [item.data]
        : [];
    })
    .sort((a, b) => Date.parse(a.merged_at!) - Date.parse(b.merged_at!));
  if (!merged.length) throw unknown();
  const pull = Pull.parse(await api.request("GET", `${root}/pulls/${merged[0]!.number}`));
  if (!matching(pull) || pull.number !== merged[0]!.number) throw unknown();
  const contains = async (ancestor: string, tip: string) => {
    const comparison = z
      .object({
        status: z.enum(["ahead", "identical"]),
        merge_base_commit: z.object({ sha: z.literal(ancestor) }),
      })
      .safeParse(await api.request("GET", `${root}/compare/${ancestor}...${tip}?per_page=1`));
    if (!comparison.success) throw unknown();
  };
  await contains(launch.startHead, head);
  await contains(pull.merge_commit_sha, main);
  const checkpoint = await mainCheckpoint(api, repository, pull.merge_commit_sha, { cache });
  if (checkpoint) throw new MainCheckpointRefused(checkpoint);
  const observation: LandedBranchObservation = {
    proof: LandedBranchProofSchema.parse({
      repository: repo.full_name,
      repositoryId: repo.id,
      accountId: account.id,
      ...launch,
      head,
      merge: pull.merge_commit_sha,
      main,
      pull: pull.number,
      url: pull.html_url,
    }),
    async revalidate() {
      const [currentRepo, currentAccount, currentPull, currentMain] = await Promise.all([
        api.request("GET", root),
        api.request("GET", "user"),
        api.request("GET", `${root}/pulls/${pull.number}`),
        readMain(),
      ]);
      const r = Repository.parse(currentRepo),
        a = z.object({ id: z.literal(account.id) }).safeParse(currentAccount),
        p = Pull.safeParse(currentPull);
      if (
        r.id !== repo.id ||
        r.full_name !== repo.full_name ||
        !a.success ||
        !p.success ||
        !matching(p.data) ||
        p.data.number !== pull.number ||
        p.data.merge_commit_sha !== pull.merge_commit_sha ||
        p.data.merged_at !== pull.merged_at ||
        currentMain !== main ||
        (await readRef()) !== head
      )
        throw unknown();
    },
  };
  return observation;
}
