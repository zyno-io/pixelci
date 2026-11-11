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
    // The API reports errors as `{ error: string }`.
    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' && body.error) return body.error;
    return "You don't have access to this.";
}

/**
 * Clears the session to switch account; the app shell then shows the login screen in place, so the
 * URL is kept. The provider picker is shown even with a single provider: auto-redirecting would sign
 * the same account straight back in.
 */
export function signOut() {
    const store = useStore();
    store.showProviderPicker = true;
    store.sessionUser = null;
    localStorage.removeItem(LOCAL_STORAGE_AUTH_KEY);
}
