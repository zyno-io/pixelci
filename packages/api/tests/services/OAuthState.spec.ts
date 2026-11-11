import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createOAuthState, deriveStateKey, OAUTH_STATE_TTL_MS, sanitizeReturnTo, verifyOAuthState } from '../../src/services/OAuthState';

const KEY = deriveStateKey({ AUTH_JWT_SECRET: 'secret-a' });
const NOW = 1_700_000_000_000;

describe('OAuthState', () => {
    it('round trips', () => {
        const state = createOAuthState({ providerId: 'p1', returnTo: '/apps/1?x=y' }, KEY, NOW);
        assert.deepEqual(verifyOAuthState(state, KEY, NOW + 1000), { providerId: 'p1', returnTo: '/apps/1?x=y' });
    });

    it('issues a unique state each time', () => {
        const a = createOAuthState({ providerId: 'p1', returnTo: '/' }, KEY, NOW);
        const b = createOAuthState({ providerId: 'p1', returnTo: '/' }, KEY, NOW);
        assert.notEqual(a, b);
    });

    it('rejects tampered payloads and signatures', () => {
        const state = createOAuthState({ providerId: 'p1', returnTo: '/' }, KEY, NOW);
        const [body, sig] = state.split('.');
        const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), p: 'p2' })).toString('base64url');
        assert.equal(verifyOAuthState(`${forged}.${sig}`, KEY, NOW), null);
        assert.equal(verifyOAuthState(`${body}.${sig.slice(0, -2)}AA`, KEY, NOW), null);
        assert.equal(verifyOAuthState(`${body}.`, KEY, NOW), null);
        assert.equal(verifyOAuthState(body, KEY, NOW), null);
    });

    it('rejects garbage and non-strings', () => {
        for (const v of [undefined, null, 5, '', '.', 'a.b.c', 'garbage']) assert.equal(verifyOAuthState(v, KEY, NOW), null);
    });

    it('rejects expired states', () => {
        const state = createOAuthState({ providerId: 'p1', returnTo: '/' }, KEY, NOW);
        assert.ok(verifyOAuthState(state, KEY, NOW + OAUTH_STATE_TTL_MS - 1));
        assert.equal(verifyOAuthState(state, KEY, NOW + OAUTH_STATE_TTL_MS + 1), null);
    });

    it('rejects a different key', () => {
        const state = createOAuthState({ providerId: 'p1', returnTo: '/' }, KEY, NOW);
        assert.equal(verifyOAuthState(state, deriveStateKey({ AUTH_JWT_SECRET: 'secret-b' }), NOW), null);
    });

    it('sanitises returnTo on create', () => {
        const state = createOAuthState({ providerId: 'p1', returnTo: '//evil.example' }, KEY, NOW);
        assert.equal(verifyOAuthState(state, KEY, NOW)?.returnTo, '/');
    });

    it('sanitizeReturnTo', () => {
        assert.equal(sanitizeReturnTo('/apps/1?a=b#c'), '/apps/1?a=b#c');
        assert.equal(sanitizeReturnTo('/'), '/');
        for (const bad of ['//evil', 'https://evil.example', '/\\evil', '/a b', 'apps', '', undefined, 5, `/${'a'.repeat(2048)}`]) {
            assert.equal(sanitizeReturnTo(bad), '/', String(bad));
        }
    });

    it('derives a key from any of the three secrets, and throws when none is set', () => {
        const a = deriveStateKey({ AUTH_JWT_ED_SECRET: 'ed' });
        assert.equal(a.length, 32);
        assert.notDeepEqual(deriveStateKey({ AUTH_JWT_SECRET_B64: 'x' }), deriveStateKey({ AUTH_JWT_SECRET: 'y' }));
        assert.throws(() => deriveStateKey({}));
    });
});
