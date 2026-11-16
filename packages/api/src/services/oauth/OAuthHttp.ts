import { HttpRequest } from '@zyno-io/ts-server-foundation';

import { OAuthError } from './OAuthErrors';

/** Reads a request body with a hard size cap (declared and actual), as text. */
export async function readLimitedBody(request: HttpRequest, limit: number): Promise<string> {
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) throw new OAuthError('invalid_request', 'Request body is too large.', 413);
    request.setBodyLimits({ maxBodyBytes: limit });
    let text: string;
    try {
        text = await request.readBodyText();
    } catch {
        throw new OAuthError('invalid_request', 'Request body could not be read.', 413);
    }
    if (Buffer.byteLength(text, 'utf8') > limit) throw new OAuthError('invalid_request', 'Request body is too large.', 413);
    return text;
}

export function contentTypeIs(request: HttpRequest, type: string): boolean {
    const header = request.headers['content-type'];
    return typeof header === 'string' && header.split(';')[0].trim().toLowerCase() === type;
}

/** Form parameters with every value kept, so a repeated parameter can be detected rather than silently collapsed. */
export class FormParams {
    private readonly values = new Map<string, string[]>();

    constructor(init: URLSearchParams | Record<string, string | string[] | undefined>) {
        if (init instanceof URLSearchParams) {
            for (const [key, value] of init) this.values.set(key, [...(this.values.get(key) ?? []), value]);
        } else {
            for (const [key, value] of Object.entries(init)) {
                if (value !== undefined) this.values.set(key, Array.isArray(value) ? value : [value]);
            }
        }
    }

    /** All values of a parameter (empty when absent). */
    all(name: string): string[] {
        return this.values.get(name) ?? [];
    }

    has(name: string): boolean {
        return this.values.has(name);
    }

    /** The single value, or undefined when absent; a repeated parameter is invalid_request (RFC 6749 section 3.1). */
    get(name: string): string | undefined {
        const all = this.all(name);
        if (all.length > 1) throw new OAuthError('invalid_request', 'A parameter was repeated.');
        return all[0];
    }

    require(name: string): string {
        const value = this.get(name);
        if (value === undefined || value === '') throw new OAuthError('invalid_request', 'A required parameter is missing.');
        return value;
    }

    /** Names of parameters that occur more than once. */
    repeated(): string[] {
        return [...this.values.entries()].filter(([, v]) => v.length > 1).map(([k]) => k);
    }
}
