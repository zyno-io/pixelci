import { appendFileSync } from 'fs';

import type { ICIJobInfo } from './ci.js';

import { AppError } from './error.js';
import { PASSING, outcomeFor } from './status.js';

function isGitHubActions(): boolean {
    return process.env.GITHUB_ACTIONS === 'true';
}

/**
 * In GitHub Actions, requests an OIDC ID token (audience = the PixelCI API URL) and uses it
 * as the CI token. Returns null when not running in GitHub Actions.
 */
export async function getGitHubCiInfo(audience: string): Promise<ICIJobInfo | null> {
    if (!isGitHubActions()) return null;

    const { ACTIONS_ID_TOKEN_REQUEST_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN, GITHUB_SERVER_URL, GITHUB_REPOSITORY } = process.env;
    if (!ACTIONS_ID_TOKEN_REQUEST_URL || !ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
        throw new AppError(
            'GitHub Actions OIDC token is unavailable. The workflow (or job) must set "permissions: id-token: write". ' +
                'Note that pull_request runs from forks do not receive an OIDC token.'
        );
    }

    const separator = ACTIONS_ID_TOKEN_REQUEST_URL.includes('?') ? '&' : '?';
    const url = `${ACTIONS_ID_TOKEN_REQUEST_URL}${separator}audience=${encodeURIComponent(audience)}`;

    let response: Response;
    try {
        response = await fetch(url, { headers: { Authorization: `Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } });
    } catch (err) {
        throw new AppError(`Failed to request GitHub Actions OIDC token: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!response.ok) {
        throw new AppError(`Failed to request GitHub Actions OIDC token: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json().catch(() => undefined)) as { value?: unknown } | undefined;
    if (!data || typeof data.value !== 'string' || !data.value) {
        throw new AppError('GitHub Actions OIDC token response did not include a token');
    }

    return {
        projectUrl: `${GITHUB_SERVER_URL ?? 'https://github.com'}/${GITHUB_REPOSITORY}`,
        ciToken: data.value
    };
}

function escapeAnnotation(message: string): string {
    return message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/**
 * Surfaces the final build status in GitHub Actions: an error annotation for statuses that
 * fail the job, and a section in the job summary for every final status.
 */
export function reportGitHubResult(status: string, buildUrl: string): void {
    if (!isGitHubActions()) return;

    if (!PASSING.has(status)) {
        const msg = `${outcomeFor(status).message} (status: ${status}). See ${buildUrl}`;
        console.log(`::error title=PixelCI::${escapeAnnotation(msg)}`);
    }

    const summaryFile = process.env.GITHUB_STEP_SUMMARY;
    if (summaryFile) {
        try {
            appendFileSync(summaryFile, `## PixelCI\n\nBuild status: **${status}**\n\n[View build](${buildUrl})\n\n`);
        } catch (err) {
            console.warn(`Failed to write GitHub step summary: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
