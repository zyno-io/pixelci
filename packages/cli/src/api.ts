import { assert, type ReceiveType } from '@zyno-io/ts-reflection';
import { randomUUID } from 'crypto';
import { openAsBlob } from 'fs';

import type { IScreenManifest } from './manifest.js';
import type { IShard } from './options.js';

import { ICIJobInfo } from './ci.js';
import { AppError } from './error.js';

const MAX_ATTEMPTS = 7;
const BACKOFF_SECONDS = [1, 2, 4, 8, 16, 30];
const MAX_RETRY_AFTER_MS = 60_000;
const JSON_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Backoff before the retry following failed attempt `attempt` (1-based), with +-20% jitter. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
    const base = BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length) - 1] * 1000;
    return Math.round(base * (0.8 + random() * 0.4));
}

function parseRetryAfter(value: string | null): number | undefined {
    if (!value) return undefined;
    const secs = Number(value);
    const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(value) - Date.now();
    if (!Number.isFinite(ms)) return undefined;
    return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

function extractMessage(text: string): string {
    try {
        const parsed = JSON.parse(text) as { message?: unknown };
        if (typeof parsed?.message === 'string') return parsed.message;
    } catch {
        // not JSON
    }
    return text;
}

// fetch rejections (network errors, AbortSignal.timeout) are transient; anything else is a bug
function isTransientError(err: unknown): boolean {
    return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError' || err instanceof TypeError);
}

export type IBuildStatus = 'draft' | 'processing' | 'no changes' | 'needs review' | 'changes approved' | 'changes rejected' | 'failed';

export function getApiUrl(): string {
    const apiUrl = process.env.PIXELCI_API_URL;
    if (!apiUrl) {
        throw new AppError('PIXELCI_API_URL environment variable is not set');
    }
    return apiUrl.replace(/\/+$/, '');
}

export function getApi(jobInfo: ICIJobInfo): PixelCiApi {
    const apiUrl = getApiUrl();

    const appId = process.env.PIXELCI_APP_ID;
    if (!appId) {
        throw new AppError('PIXELCI_APP_ID environment variable is not set');
    }

    return new PixelCiApi(apiUrl, appId, jobInfo);
}

export class PixelCiApi {
    private serverUrl: string;
    private appId: string;
    private ciToken: string;
    private projectUrl: string;
    // one per CLI run; reused by create retries so the server can tell a retry from a new run
    private runId = randomUUID();

    constructor(serverUrl: string, appId: string, jobInfo: ICIJobInfo) {
        this.serverUrl = serverUrl.replace(/\/+$/, '');
        this.appId = appId;
        this.ciToken = jobInfo.ciToken;
        this.projectUrl = jobInfo.projectUrl;
    }

    private async request<T>(
        method: string,
        path: string,
        bodyFactory: (() => Promise<Record<string, unknown> | FormData> | Record<string, unknown> | FormData) | undefined,
        timeoutMs: number,
        type?: ReceiveType<T>
    ): Promise<T> {
        let lastError = 'unknown error';
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            let retryAfterMs: number | undefined;
            let validated = false;
            let result: unknown;
            try {
                // rebuilt per attempt: a FormData/Blob body can't be reliably re-sent
                const body = bodyFactory ? await bodyFactory() : undefined;
                const isJsonBody = body !== undefined && !(body instanceof FormData);
                const response = await fetch(`${this.serverUrl}/api/${path}`, {
                    method,
                    headers: {
                        Authorization: `Bearer ${this.ciToken}`,
                        ...(isJsonBody && { 'Content-Type': 'application/json' })
                    },
                    body: isJsonBody ? JSON.stringify(body) : (body as FormData | undefined),
                    signal: AbortSignal.timeout(timeoutMs)
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    const message = `API request failed (${response.status ?? '?'} ${response.statusText}): ${extractMessage(errorText)}`;
                    if (!RETRYABLE_STATUSES.has(response.status)) throw new AppError(message);
                    lastError = message;
                    retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after') ?? null);
                } else {
                    const data = await response.json();
                    validated = true;
                    result = data;
                }
            } catch (err) {
                if (err instanceof AppError) throw err;
                if (!isTransientError(err)) throw err;
                lastError = err instanceof Error ? err.message : String(err);
            }

            if (validated) {
                assert<T>(result, undefined, type);
                return result as T;
            }

            if (attempt < MAX_ATTEMPTS) {
                const delay = retryAfterMs ?? backoffMs(attempt);
                console.warn(
                    `Request ${method} ${path} failed (${lastError}); retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${MAX_ATTEMPTS})...`
                );
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        throw new AppError(`API request ${method} ${path} failed after ${MAX_ATTEMPTS} attempts: ${lastError}`);
    }

    getBuildUserUrl(buildId: string): string {
        return `${this.serverUrl}/apps/${this.appId}/builds/${buildId}`;
    }

    async createBuild(opts: { screens: IScreenManifest; shard?: IShard }): Promise<{ buildId: string; status: string; shard?: IShard }> {
        const response = await this.request<{ id: string; status: string; shard?: { index: number; total: number } }>(
            'POST',
            `apps/${this.appId}/builds`,
            () => ({ projectUrl: this.projectUrl, runId: this.runId, screens: opts.screens, ...(opts.shard && { shard: opts.shard }) }),
            JSON_TIMEOUT_MS
        );

        return {
            buildId: response.id,
            status: response.status,
            shard: response.shard
        };
    }

    async uploadScreen(buildId: string, imageFile: string, screenName: string): Promise<void> {
        const response = await this.request<{ id: string; name?: string }>(
            'POST',
            `apps/${this.appId}/builds/${buildId}/screens`,
            async () => {
                const blob = await openAsBlob(imageFile, { type: 'image/png' });
                const formData = new FormData();
                // the multipart filename is mangled server-side (latin1, quotes, backslashes), so send
                // the name as its own text field, before the file part
                formData.append('name', screenName);
                formData.append('image', blob, `${screenName}.png`);
                return formData;
            },
            UPLOAD_TIMEOUT_MS
        );
        if (response.name !== undefined && response.name !== screenName) {
            throw new AppError(
                `Server stored screen '${screenName}' as '${response.name}'; this server version can't handle that name. Rename the screenshot or upgrade PixelCI`
            );
        }
    }

    async processBuild(buildId: string, screens: IScreenManifest): Promise<void> {
        await this.request<{ ok: true }>('POST', `apps/${this.appId}/builds/${buildId}/process`, () => ({ screens }), JSON_TIMEOUT_MS);
    }

    async getBuildStatus(buildId: string): Promise<string> {
        const response = await this.request<{ status: string }>('GET', `apps/${this.appId}/builds/${buildId}/status`, undefined, JSON_TIMEOUT_MS);
        return response.status;
    }
}
