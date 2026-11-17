import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GitRunner, IGitResult } from './git.js';

import { resolveBase, type IResolveBaseOptions } from './base.js';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const T = sha(1); // target
const B = sha(2); // base point
const OK = (stdout = ''): IGitResult => ({ ok: true, stdout, stderr: '' });
const FAIL: IGitResult = { ok: false, stdout: '', stderr: 'fatal' };

type Handler = (args: string[]) => IGitResult | undefined;

/** Fake git: the first handler returning a result wins; unmatched commands fail. */
function fakeGit(...handlers: Handler[]) {
    const calls: string[][] = [];
    const git: GitRunner = async args => {
        calls.push(args);
        for (const h of handlers) {
            const r = h(args);
            if (r) return r;
        }
        return FAIL;
    };
    return { git, calls, has: (prefix: string) => calls.some(c => c.join(' ').startsWith(prefix)) };
}

const is =
    (prefix: string, result: IGitResult): Handler =>
    args =>
        args.join(' ').startsWith(prefix) ? result : undefined;

const base: Handler[] = [
    is('--version', OK('git version 2.50')),
    is('rev-parse --is-inside-work-tree', OK('true')),
    is(`cat-file -e ${T}^{commit}`, OK()),
    is('rev-parse --is-shallow-repository', OK('false')),
    args => (args[0] === 'rev-list' ? OK(`${args[3]}\n${sha(90)}\n`) : undefined)
];

function setup(handlers: Handler[], over: Partial<IResolveBaseOptions> = {}) {
    const g = fakeGit(...handlers, ...base);
    const warnings: string[] = [];
    const opts: IResolveBaseOptions = {
        defaultBranch: 'main',
        branchName: 'feature',
        commitHash: T,
        env: {},
        git: g.git,
        log: { warn: m => warnings.push(m) },
        ...over
    };
    return { ...g, warnings, run: () => resolveBase(opts) };
}

describe('resolveBase', () => {
    it('default branch: first-parent ancestry of the commit itself', async () => {
        const s = setup([], { branchName: 'main' });
        const r = await s.run();
        assert.deepEqual(r, { commits: [T, sha(90)], source: 'first-parent' });
        assert.equal(s.has('fetch'), false);
    });

    it('default branch in a shallow clone: deepens and re-lists the ancestry', async () => {
        let deepened = false;
        const s = setup(
            [
                is('rev-parse --is-shallow-repository', OK('true')),
                args => {
                    if (args[0] === 'fetch' && args.includes('--deepen=50')) {
                        deepened = true;
                        return OK();
                    }
                    if (args[0] === 'rev-list') return OK(deepened ? `${T}\n${sha(90)}\n${sha(91)}\n` : `${T}\n`);
                }
            ],
            { branchName: 'main' }
        );
        assert.deepEqual((await s.run())?.commits, [T, sha(90), sha(91)]);
    });

    it('default branch in a shallow clone with PIXELCI_GIT_FETCH=false: no deepening', async () => {
        const s = setup([is('rev-parse --is-shallow-repository', OK('true')), args => (args[0] === 'rev-list' ? OK(`${T}\n`) : undefined)], {
            branchName: 'main',
            env: { PIXELCI_GIT_FETCH: 'false' }
        });
        assert.deepEqual((await s.run())?.commits, [T]);
        assert.equal(s.has('fetch'), false);
    });

    it('uses HEAD when the build commit is not in the checkout', async () => {
        const s = setup([is(`cat-file -e ${T}^{commit}`, FAIL), is('rev-parse HEAD', OK(`${sha(7)}\n`))], { branchName: 'main' });
        assert.equal((await s.run())?.commits[0], sha(7));
    });

    it('GitLab merged results: uses the target branch sha', async () => {
        const s = setup([], { env: { CI_MERGE_REQUEST_EVENT_TYPE: 'merged_result', CI_MERGE_REQUEST_TARGET_BRANCH_SHA: B } });
        assert.deepEqual(await s.run(), { commits: [B, sha(90)], source: 'merge-request-target' });
        assert.equal(s.has('fetch'), false);
    });

    it('GitLab merge train also counts as merged results', async () => {
        const s = setup([], { env: { CI_MERGE_REQUEST_EVENT_TYPE: 'merge_train', CI_MERGE_REQUEST_TARGET_BRANCH_SHA: B } });
        assert.equal((await s.run())?.source, 'merge-request-target');
    });

    it('GitLab detached MR pipeline: uses the diff base sha', async () => {
        const s = setup([], {
            env: { CI_MERGE_REQUEST_EVENT_TYPE: 'detached', CI_MERGE_REQUEST_TARGET_BRANCH_SHA: sha(5), CI_MERGE_REQUEST_DIFF_BASE_SHA: B }
        });
        assert.deepEqual(await s.run(), { commits: [B, sha(90)], source: 'merge-request-diff-base' });
    });

    it('GitHub PR merge commit: first parent', async () => {
        const s = setup([is(`cat-file -p ${T}`, OK(`tree abc\nparent ${B}\nparent ${sha(3)}\nauthor x\n\nparent ${sha(4)}\n`))], {
            env: { GITHUB_EVENT_NAME: 'pull_request' }
        });
        assert.deepEqual(await s.run(), { commits: [B, sha(90)], source: 'pull-request-base' });
    });

    it('GitHub PR whose checked-out head is itself a merge commit: ignores its parents, uses the event base sha', async () => {
        const H = sha(7);
        const s = setup(
            [
                is(`cat-file -e ${T}^{commit}`, FAIL),
                is('rev-parse HEAD', OK(`${H}\n`)),
                is(`cat-file -p ${H}`, OK(`tree abc\nparent ${sha(3)}\nparent ${sha(4)}\n\n`)),
                is(`merge-base ${H} ${sha(8)}`, OK(`${B}\n`))
            ],
            {
                env: { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: '/event.json' },
                readFile: () => JSON.stringify({ pull_request: { base: { sha: sha(8) } } })
            }
        );
        assert.deepEqual(await s.run(), { commits: [B, sha(90)], source: 'pull-request-base' });
    });

    it('GitHub PR with head checked out: merge-base with the event base sha', async () => {
        const s = setup([is(`cat-file -p ${T}`, OK(`tree abc\nparent ${sha(3)}\n\n`)), is(`merge-base ${T} ${sha(8)}`, OK(`${B}\n`))], {
            env: { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: '/event.json' },
            readFile: () => JSON.stringify({ pull_request: { base: { sha: sha(8) } } })
        });
        assert.deepEqual(await s.run(), { commits: [B, sha(90)], source: 'pull-request-base' });
    });

    it('GitHub PR: fetches the base sha when it is missing, then merge-bases', async () => {
        let fetched = false;
        const s = setup(
            [
                is(`cat-file -p ${T}`, OK(`tree abc\nparent ${sha(3)}\n\n`)),
                args => {
                    if (args[0] === 'fetch') {
                        fetched = true;
                        return OK();
                    }
                    if (args[0] === 'merge-base') return fetched ? OK(`${B}\n`) : FAIL;
                }
            ],
            {
                env: { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: '/e' },
                readFile: () => JSON.stringify({ pull_request: { base: { sha: sha(8) } } })
            }
        );
        assert.equal((await s.run())?.source, 'pull-request-base');
        assert.ok(s.has(`fetch --no-tags origin ${sha(8)}`));
    });

    it('plain branch: fetches the default branch then merge-base', async () => {
        const ref = 'refs/remotes/pixelci-base/main';
        const s = setup([is('fetch', OK()), is(`merge-base ${T} ${ref}`, OK(`${B}\n`))]);
        assert.deepEqual(await s.run(), { commits: [B, sha(90)], source: 'merge-base' });
        assert.ok(s.has(`fetch --no-tags origin +refs/heads/main:${ref}`));
        assert.equal(s.has('fetch --no-tags --depth'), false);
    });

    it('shallow clone: depth-limited fetch, then deepens until merge-base is found', async () => {
        let deepened = 0;
        const s = setup([
            is('rev-parse --is-shallow-repository', OK('true')),
            args => {
                if (args.some(a => a.startsWith('--deepen='))) {
                    if (args.includes('--deepen=50')) return OK(); // the ancestry listing deepens too
                    deepened++;
                    return OK();
                }
                if (args[0] === 'fetch') return OK();
                if (args[0] === 'merge-base') return deepened >= 2 ? OK(`${B}\n`) : FAIL;
            }
        ]);
        assert.equal((await s.run())?.source, 'merge-base');
        assert.equal(deepened, 2);
        assert.ok(s.has('fetch --no-tags --depth=50 origin +refs/heads/main'));
        assert.ok(s.has(`fetch --no-tags --deepen=200 origin ${T} +refs/heads/main`));
        assert.ok(s.has(`fetch --no-tags --deepen=1000 origin ${T}`));
    });

    it('shallow clone: deepens without the target when the target is not on the remote', async () => {
        let deepened = false;
        const s = setup([
            is('rev-parse --is-shallow-repository', OK('true')),
            args => {
                if (args.some(a => a.startsWith('--deepen='))) {
                    if (args.includes(T)) return FAIL;
                    deepened = true;
                    return OK();
                }
                if (args[0] === 'fetch') return OK();
                if (args[0] === 'merge-base') return deepened ? OK(`${B}\n`) : FAIL;
            }
        ]);
        assert.equal((await s.run())?.source, 'merge-base');
    });

    it('shallow clone: gives up after the last deepen with a warning', async () => {
        const s = setup([is('rev-parse --is-shallow-repository', OK('true')), is('fetch', OK())]);
        assert.equal(await s.run(), undefined);
        assert.equal(s.calls.filter(c => c.some(a => a.startsWith('--deepen='))).length, 2);
        assert.match(s.warnings[0], /latest approved main build/);
    });

    it('not shallow and no merge-base: no deepen attempts', async () => {
        const s = setup([is('fetch', OK())]);
        assert.equal(await s.run(), undefined);
        assert.equal(s.has('fetch --no-tags --deepen'), false);
        assert.equal(s.warnings.length, 1);
    });

    it('git missing: warns and returns undefined', async () => {
        const s = setup([is('--version', FAIL)]);
        assert.equal(await s.run(), undefined);
        assert.match(s.warnings[0], /No git history available.*latest approved main build/);
    });

    it('not inside a work tree: warns and returns undefined', async () => {
        const s = setup([is('rev-parse --is-inside-work-tree', FAIL)]);
        assert.equal(await s.run(), undefined);
        assert.equal(s.warnings.length, 1);
    });

    it('PIXELCI_GIT_FETCH=false: never fetches, uses a local merge-base', async () => {
        const s = setup([is(`merge-base ${T} refs/remotes/pixelci-base/main`, FAIL), is(`merge-base ${T} refs/remotes/origin/main`, OK(`${B}\n`))], {
            env: { PIXELCI_GIT_FETCH: 'false' }
        });
        assert.deepEqual(await s.run(), { commits: [B, sha(90)], source: 'merge-base' });
        assert.equal(s.has('fetch'), false);
    });

    it('PIXELCI_GIT_FETCH=false: no merge-base means no deepening either', async () => {
        const s = setup([is('rev-parse --is-shallow-repository', OK('true'))], { env: { PIXELCI_GIT_FETCH: 'false' } });
        assert.equal(await s.run(), undefined);
        assert.equal(s.has('fetch'), false);
    });

    it('PIXELCI_BASE_COMMIT overrides everything, even a missing git', async () => {
        const s = setup([is('--version', FAIL), is('rev-list', FAIL)], { env: { PIXELCI_BASE_COMMIT: B.toUpperCase() } });
        assert.deepEqual(await s.run(), { commits: [B], source: 'override' });
    });

    it('PIXELCI_BASE_COMMIT: expands to ancestry when git can', async () => {
        const s = setup([], { env: { PIXELCI_BASE_COMMIT: B } });
        assert.deepEqual(await s.run(), { commits: [B, sha(90)], source: 'override' });
    });

    it('PIXELCI_BASE_COMMIT that is not a full hash: warns and returns undefined', async () => {
        const s = setup([is('rev-list', FAIL)], { env: { PIXELCI_BASE_COMMIT: 'main' } });
        assert.equal(await s.run(), undefined);
        assert.equal(s.warnings.length, 1);
    });

    it('missing base commit: fetches it, then lists ancestry', async () => {
        let fetched = false;
        const s = setup(
            [
                args => {
                    if (args[0] === 'fetch') {
                        fetched = true;
                        return OK();
                    }
                    if (args[0] === 'rev-list') return fetched ? OK(`${B}\n`) : FAIL;
                }
            ],
            { env: { PIXELCI_BASE_COMMIT: B } }
        );
        assert.deepEqual(await s.run(), { commits: [B], source: 'override' });
        assert.ok(s.has(`fetch --no-tags --depth=50 origin ${B}`));
    });

    it('caps ancestry at 50 commits, validates and de-duplicates', async () => {
        const many = Array.from({ length: 80 }, (_, i) => sha(100 + i));
        const s = setup([args => (args[0] === 'rev-list' ? OK([...many, many[0], 'garbage'].join('\n')) : undefined)], { branchName: 'main' });
        const r = await s.run();
        assert.equal(r?.commits.length, 50);
        assert.ok(s.calls.some(c => c.includes('--max-count=50')));
        assert.deepEqual(r?.commits, many.slice(0, 50));
    });

    it('no default branch: returns undefined without touching git', async () => {
        const s = setup([], { defaultBranch: null });
        assert.equal(await s.run(), undefined);
        assert.equal(s.calls.length, 0);
    });

    it('never throws', async () => {
        const warnings: string[] = [];
        const r = await resolveBase({
            defaultBranch: 'main',
            branchName: 'f',
            commitHash: T,
            env: {},
            git: async () => {
                throw new Error('boom');
            },
            log: { warn: m => warnings.push(m) }
        });
        assert.equal(r, undefined);
        assert.match(warnings[0], /boom/);
    });
});
