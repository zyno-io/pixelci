/** The only build statuses that let the CLI exit 0. Everything else fails. */
export const PASSING: ReadonlySet<string> = new Set(['no changes', 'changes approved']);

export interface IOutcome {
    code: 0 | 1;
    message: string;
}

export function outcomeFor(status: string): IOutcome {
    if (PASSING.has(status)) {
        return { code: 0, message: status === 'no changes' ? 'No visual changes.' : 'Visual changes were approved.' };
    }
    switch (status) {
        case 'needs review':
            return { code: 1, message: 'Visual changes require review.' };
        case 'changes rejected':
            return { code: 1, message: 'Visual changes were rejected during review.' };
        case 'failed':
            return { code: 1, message: 'Build failed during processing.' };
        default:
            return { code: 1, message: `Unexpected build status '${status}'; failing to be safe. Upgrade @zyno-io/pixelci-cli.` };
    }
}

/** The reference is `latest` when no ancestor of the commit had an accepted default-branch build. */
export function referenceWarning(referenceSource: string | undefined): string | undefined {
    if (referenceSource !== 'latest') return undefined;
    return 'No accepted default-branch build was found at or before where this branch forked; compared against the latest approved build instead. Unrelated changes from the default branch may show up as differences.';
}
