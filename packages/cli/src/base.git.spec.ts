import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { resolveBase } from './base.js';
import { createGitRunner } from './git.js';

const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null'
};

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'safe.directory=*', '-c', 'protocol.file.allow=always', ...args], {
        cwd,
        env: GIT_ENV,
        encoding: 'utf8'
    }).trim();
}

describe('resolveBase with real git', () => {
    let root: string;
    let origin: string;
    const mainShas: string[] = [];
    let forkPoint: string;
    let featureTip: string;

    function commit(cwd: string, name: string): string {
        writeFileSync(join(cwd, `${name}.txt`), name);
        git(cwd, 'add', '.');
        git(cwd, 'commit', '-m', name);
        return git(cwd, 'rev-parse', 'HEAD');
    }

    before(() => {
        root = mkdtempSync(join(tmpdir(), 'pixelci-base-'));
        origin = join(root, 'origin.git');
        const work = join(root, 'work');
        git(root, 'init', '--bare', '-b', 'main', origin);
        git(root, 'init', '-b', 'main', work);
        git(work, 'remote', 'add', 'origin', origin);

        for (let i = 0; i < 6; i++) mainShas.push(commit(work, `main-${i}`));
        forkPoint = mainShas[5];
        git(work, 'checkout', '-b', 'feature');
        for (let i = 0; i < 3; i++) featureTip = commit(work, `feature-${i}`);
        git(work, 'checkout', 'main');
        // main moves on after the fork, as it does in real life
        for (let i = 6; i < 14; i++) mainShas.push(commit(work, `main-${i}`));
        git(work, 'push', 'origin', 'main', 'feature');
    });

    after(() => rmSync(root, { recursive: true, force: true }));

    function shallowClone(name: string, branch: string): string {
        const dir = join(root, name);
        git(root, 'clone', '--depth', '1', '--branch', branch, '--no-tags', `file://${origin}`, dir);
        return dir;
    }

    const run = (dir: string, env: NodeJS.ProcessEnv = {}, over: { branchName?: string; commitHash?: string } = {}) => {
        const warnings: string[] = [];
        return resolveBase({
            defaultBranch: 'main',
            branchName: over.branchName ?? 'feature',
            commitHash: over.commitHash ?? featureTip,
            env,
            git: createGitRunner(dir),
            log: { warn: m => warnings.push(m) }
        }).then(base => ({ base, warnings }));
    };

    it('depth-1 clone of a feature branch: fetches and deepens to find the fork point', async () => {
        const dir = shallowClone('c1', 'feature');
        assert.equal(git(dir, 'rev-parse', '--is-shallow-repository'), 'true');
        const { base, warnings } = await run(dir);
        assert.equal(base?.source, 'merge-base');
        assert.equal(base?.commits[0], forkPoint);
        assert.equal(base?.commits[1], mainShas[4]);
        assert.deepEqual(warnings, []);
    });

    it('PIXELCI_GIT_FETCH=false on a depth-1 clone: no network, warns and falls back', async () => {
        const dir = shallowClone('c2', 'feature');
        const { base, warnings } = await run(dir, { PIXELCI_GIT_FETCH: 'false' });
        assert.equal(base, undefined);
        assert.equal(warnings.length, 1);
    });

    it('full clone: finds the fork point with a single fetch', async () => {
        const dir = join(root, 'c3');
        git(root, 'clone', '--branch', 'feature', `file://${origin}`, dir);
        const { base } = await run(dir);
        assert.equal(base?.commits[0], forkPoint);
        assert.equal(base?.source, 'merge-base');
    });

    it('full clone with PIXELCI_GIT_FETCH=false: uses the existing remote-tracking ref', async () => {
        const dir = join(root, 'c4');
        git(root, 'clone', '--branch', 'feature', `file://${origin}`, dir);
        const { base } = await run(dir, { PIXELCI_GIT_FETCH: 'false' });
        assert.equal(base?.commits[0], forkPoint);
    });

    it('default branch build: first-parent ancestry from the commit, capped at 50', async () => {
        const dir = shallowClone('c5', 'main');
        const tip = mainShas[mainShas.length - 1];
        const { base } = await run(dir, {}, { branchName: 'main', commitHash: tip });
        assert.equal(base?.source, 'first-parent');
        assert.equal(base?.commits[0], tip);
        // depth-1 clone: only the tip is reachable until the base is fetched
        assert.ok(base!.commits.length >= 1 && base!.commits.length <= 50);
    });

    it('override of an ancestor missing from a shallow clone is fetched', async () => {
        const dir = shallowClone('c6', 'feature');
        const { base } = await run(dir, { PIXELCI_BASE_COMMIT: mainShas[3] });
        assert.equal(base?.source, 'override');
        assert.equal(base?.commits[0], mainShas[3]);
    });

    it('outside a git repository: warns and returns undefined', async () => {
        const dir = mkdtempSync(join(root, 'nogit-'));
        const { base, warnings } = await run(dir, {}, { commitHash: featureTip });
        assert.equal(base, undefined);
        assert.equal(warnings.length, 1);
    });
});
