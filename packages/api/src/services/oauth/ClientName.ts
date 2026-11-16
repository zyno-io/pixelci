import { OAUTH_DEFAULT_CLIENT_NAME, OAUTH_MAX_CLIENT_NAME_LENGTH } from './OAuthConstants';

/** Control, bidi-override and zero-width characters: never shown in a client name. */
// oxlint-disable-next-line no-control-regex
const NAME_STRIP_RE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

/** A client name safe to display, or '' when nothing displayable is left: control, bidi and zero-width characters removed, whitespace collapsed, capped. */
export function cleanClientName(value: unknown): string {
    if (typeof value !== 'string') return '';
    const cleaned = value.replace(/\s+/g, ' ').replace(NAME_STRIP_RE, '').trim();
    return Array.from(cleaned).slice(0, OAUTH_MAX_CLIENT_NAME_LENGTH).join('').trim();
}

/** cleanClientName with the default name standing in for an empty result. */
export function sanitizeClientName(value: unknown): string {
    return cleanClientName(value) || OAUTH_DEFAULT_CLIENT_NAME;
}
