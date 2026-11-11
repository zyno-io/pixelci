import { OpenApiError } from '@zyno-io/openapi-client-codegen';

import { LOCAL_STORAGE_AUTH_KEY } from '@/openapi-client';
import { useStore } from '@/store';

/**
 * The API's explanation when a request was refused with 403 (e.g. signed in through a different
 * VCS provider than the app's), or null for any other failure.
 */
export function accessDeniedMessage(err: unknown): string | null {
    if (!(err instanceof OpenApiError) || err.response?.status !== 403) return null;
    const body = err.body;
    if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string' && body.message) return body.message;
    return "You don't have access to this.";
}

/** Clears the session; the app shell then shows the login screen in place, so the URL is kept. */
export function signOut() {
    useStore().sessionUser = null;
    localStorage.removeItem(LOCAL_STORAGE_AUTH_KEY);
}
