import { execFile } from 'node:child_process';

export const GIT_TIMEOUT_MS = 10_000;
export const GIT_FETCH_TIMEOUT_MS = 120_000;

export interface IGitResult {
    ok: boolean;
    stdout: string;
    stderr: string;
}

/** Never rejects: a failure (non-zero exit, timeout, git missing) is `ok: false`. */
export type GitRunner = (args: string[], opts?: { timeoutMs?: number }) => Promise<IGitResult>;

/** Runs git without a shell, never prompting for credentials, trusting any repo owner (CI checkouts often are not owned by the job user). */
export function createGitRunner(cwd: string = process.cwd()): GitRunner {
    return (args, opts) =>
        new Promise(resolve => {
            execFile(
                'git',
                ['-c', 'safe.directory=*', ...args],
                {
                    cwd,
                    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
                    timeout: opts?.timeoutMs ?? GIT_TIMEOUT_MS,
                    maxBuffer: 16 * 1024 * 1024,
                    windowsHide: true
                },
                (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
            );
        });
}

export const runGit: GitRunner = (args, opts) => createGitRunner()(args, opts);
