import { readFileSync } from 'node:fs';

import { baseHints as githubHints } from './ci-github.js';
import { baseHints as gitlabHints } from './ci-gitlab.js';
import { GIT_FETCH_TIMEOUT_MS, type GitRunner } from './git.js';

export type IBaseSource = 'merge-base' | 'merge-request-target' | 'merge-request-diff-base' | 'pull-request-base' | 'first-parent' | 'override';

export interface IBase {
    commits: string[];
    source: IBaseSource;
}

export interface IBaseLogger {
    warn(message: string): void;
}

export interface IResolveBaseOptions {
    defaultBranch: string | null;
    branchName: string;
    commitHash: string;
    env: NodeJS.ProcessEnv;
    git: GitRunner;
    log: IBaseLogger;
    /** Reads the GitHub event payload; injectable for tests. */
    readFile?: (path: string) => string;
}

export const MAX_BASE_COMMITS = 50;
const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DEEPEN_STEPS = [200, 1000];
const BASE_REF_PREFIX = 'refs/remotes/pixelci-base/';

/**
 * Works out where this build's code forked from the default branch, as the nearest-first first-parent
 * ancestry of that point. The server picks the first ancestor with an accepted default-branch build.
 * Never throws: on any failure it warns and returns undefined, and the server falls back to the latest accepted build.
 */
export async function resolveBase(o: IResolveBaseOptions): Promise<IBase | undefined> {
    try {
        return await resolve(o);
    } catch (err) {
        o.log.warn(
            `Could not determine the baseline from git (${err instanceof Error ? err.message : String(err)}); comparing against the latest approved build`
        );
        return undefined;
    }
}

async function resolve(o: IResolveBaseOptions): Promise<IBase | undefined> {
    const { git, env, log } = o;
    const fallback = (reason: string) => {
        log.warn(`${reason}: comparing against the latest approved ${o.defaultBranch ?? 'default-branch'} build`);
        return undefined;
    };

    let basePoint: string | undefined;
    let source: IBaseSource | undefined;

    const override = env.PIXELCI_BASE_COMMIT?.trim();
    if (override) {
        basePoint = override;
        source = 'override';
    } else {
        if (!o.defaultBranch) return undefined; // no default branch to compare against

        if (!(await git(['--version'])).ok || !(await git(['rev-parse', '--is-inside-work-tree'])).ok) {
            return fallback('No git history available');
        }

        const target = await resolveTarget(o);
        if (!target) return fallback('Could not read the current commit from git');

        const picked = await pickBasePoint(o, target);
        if (!picked) return fallback('Could not find where this branch forked from the default branch');
        ({ basePoint, source } = picked);
    }

    const commits = await listAncestry(o, basePoint);
    const valid = [...new Set(commits.map(c => c.toLowerCase()).filter(c => COMMIT_RE.test(c)))].slice(0, MAX_BASE_COMMITS);
    if (!valid.length) return fallback(`Base commit "${basePoint}" is not a valid commit hash`);
    return { commits: valid, source };
}

/** The commit being tested: the build's commit when it is in the checkout, else HEAD. */
async function resolveTarget(o: IResolveBaseOptions): Promise<string | undefined> {
    if (o.commitHash && (await o.git(['cat-file', '-e', `${o.commitHash}^{commit}`])).ok) return o.commitHash;
    const head = await o.git(['rev-parse', 'HEAD']);
    return head.ok ? head.stdout.trim() : undefined;
}

async function pickBasePoint(o: IResolveBaseOptions, target: string): Promise<{ basePoint: string; source: IBaseSource } | undefined> {
    const { git, env } = o;
    const defaultBranch = o.defaultBranch!;

    if (o.branchName === defaultBranch) return { basePoint: target, source: 'first-parent' };

    const gl = gitlabHints(env);
    if (gl.mergeRequestTargetSha) return { basePoint: gl.mergeRequestTargetSha, source: 'merge-request-target' };

    const gh = githubHints(env);
    // Only GitHub's synthetic merge commit (the one the server recorded) has the base branch tip as its first parent. A checked-out
    // PR head can itself be a merge commit ("Update branch"), whose first parent is the feature branch's previous commit.
    if (gh.isPullRequest && target === o.commitHash) {
        // cat-file works in depth-1 clones
        const parents = await parentsOf(git, target);
        if (parents.length === 2) return { basePoint: parents[0], source: 'pull-request-base' };
    }

    if (gl.mergeRequestDiffBaseSha) return { basePoint: gl.mergeRequestDiffBaseSha, source: 'merge-request-diff-base' };

    if (gh.isPullRequest && gh.eventPath) {
        const baseSha = readPullRequestBaseSha(gh.eventPath, o.readFile ?? (p => readFileSync(p, 'utf8')));
        if (baseSha) {
            let mb = await git(['merge-base', target, baseSha]);
            if (!mb.ok) {
                await git(['fetch', '--no-tags', 'origin', baseSha], { timeoutMs: GIT_FETCH_TIMEOUT_MS });
                mb = await git(['merge-base', target, baseSha]);
            }
            if (mb.ok && mb.stdout.trim()) return { basePoint: mb.stdout.trim(), source: 'pull-request-base' };
        }
    }

    const mergeBase = await mergeBaseWithDefault(o, target);
    return mergeBase ? { basePoint: mergeBase, source: 'merge-base' } : undefined;
}

async function mergeBaseWithDefault(o: IResolveBaseOptions, target: string): Promise<string | undefined> {
    const { git } = o;
    const defaultBranch = o.defaultBranch!;
    const ref = `${BASE_REF_PREFIX}${defaultBranch}`;
    const refspec = `+refs/heads/${defaultBranch}:${ref}`;
    const shallow = async () => (await git(['rev-parse', '--is-shallow-repository'])).stdout.trim() === 'true';

    const tryMergeBase = async (): Promise<string | undefined> => {
        const r = await git(['merge-base', target, ref]);
        return r.ok && r.stdout.trim() ? r.stdout.trim() : undefined;
    };

    if (o.env.PIXELCI_GIT_FETCH?.trim().toLowerCase() !== 'false') {
        const args = ['fetch', '--no-tags', ...((await shallow()) ? [`--depth=${MAX_BASE_COMMITS}`] : []), 'origin', refspec];
        await git(args, { timeoutMs: GIT_FETCH_TIMEOUT_MS });
    }

    let mb = await tryMergeBase();
    if (mb) return mb;

    // local fallback when the fetch was skipped or failed, e.g. a clone with refs/remotes/origin/<default>
    const originRef = `refs/remotes/origin/${defaultBranch}`;
    const viaOrigin = await git(['merge-base', target, originRef]);
    if (viaOrigin.ok && viaOrigin.stdout.trim()) return viaOrigin.stdout.trim();

    if (o.env.PIXELCI_GIT_FETCH?.trim().toLowerCase() === 'false' || !(await shallow())) return undefined;

    for (const depth of DEEPEN_STEPS) {
        let r = await git(['fetch', '--no-tags', `--deepen=${depth}`, 'origin', target, refspec], { timeoutMs: GIT_FETCH_TIMEOUT_MS });
        // the target may not exist on the remote (a local-only commit): deepen what we have instead
        if (!r.ok) r = await git(['fetch', '--no-tags', `--deepen=${depth}`, 'origin', refspec], { timeoutMs: GIT_FETCH_TIMEOUT_MS });
        if (!r.ok) continue;
        mb = await tryMergeBase();
        if (mb) return mb;
    }
    return undefined;
}

/**
 * First-parent ancestry of `basePoint`, nearest first, capped at 50. Fetches the commit if it is missing locally, and deepens a
 * shallow clone (where rev-list succeeds with just the visible commits) so a default-branch build has ancestors to match.
 */
async function listAncestry(o: IResolveBaseOptions, basePoint: string): Promise<string[]> {
    const { git } = o;
    const fetchAllowed = o.env.PIXELCI_GIT_FETCH?.trim().toLowerCase() !== 'false';
    const list = () => git(['rev-list', '--first-parent', `--max-count=${MAX_BASE_COMMITS}`, basePoint]);
    const parse = (stdout: string) =>
        stdout
            .split('\n')
            .map(l => l.trim())
            .filter(Boolean);
    let r = await list();
    if (!r.ok) {
        await git(['fetch', '--no-tags', `--depth=${MAX_BASE_COMMITS}`, 'origin', basePoint], { timeoutMs: GIT_FETCH_TIMEOUT_MS });
        r = await list();
    }
    if (!r.ok) return [basePoint];
    let lines = parse(r.stdout);

    if (lines.length < MAX_BASE_COMMITS && fetchAllowed && (await git(['rev-parse', '--is-shallow-repository'])).stdout.trim() === 'true') {
        let d = await git(['fetch', '--no-tags', `--deepen=${MAX_BASE_COMMITS}`, 'origin', basePoint], { timeoutMs: GIT_FETCH_TIMEOUT_MS });
        // the commit may not exist on the remote (a local-only commit): deepen via the default branch instead
        if (!d.ok && o.defaultBranch) {
            d = await git(
                [
                    'fetch',
                    '--no-tags',
                    `--deepen=${MAX_BASE_COMMITS}`,
                    'origin',
                    `+refs/heads/${o.defaultBranch}:${BASE_REF_PREFIX}${o.defaultBranch}`
                ],
                {
                    timeoutMs: GIT_FETCH_TIMEOUT_MS
                }
            );
        }
        if (d.ok) {
            const again = await list();
            if (again.ok && parse(again.stdout).length > lines.length) lines = parse(again.stdout);
        }
    }
    return lines.length ? lines : [basePoint];
}

async function parentsOf(git: GitRunner, commit: string): Promise<string[]> {
    const r = await git(['cat-file', '-p', commit]);
    if (!r.ok) return [];
    const parents: string[] = [];
    for (const line of r.stdout.split('\n')) {
        if (line === '') break; // end of headers
        const m = /^parent ([0-9a-f]+)$/.exec(line);
        if (m) parents.push(m[1]);
    }
    return parents;
}

function readPullRequestBaseSha(eventPath: string, read: (path: string) => string): string | undefined {
    try {
        const sha = (JSON.parse(read(eventPath)) as { pull_request?: { base?: { sha?: unknown } } }).pull_request?.base?.sha;
        return typeof sha === 'string' && COMMIT_RE.test(sha) ? sha : undefined;
    } catch {
        return undefined;
    }
}
