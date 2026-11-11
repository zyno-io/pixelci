import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import {
    assertSecretsConfig,
    parseKeyring,
    SEALED_PREFIX,
    SecretBox,
    SecretKeyUnavailableError,
    SecretUnreadableError
} from '../../src/services/secrets/SecretBox';

const key = () => randomBytes(32).toString('base64');
const CTX = 'vcsIntegrations/abc/clientSecret';

describe('SecretBox', () => {
    it('round-trips and uses the sealed format', () => {
        const box = new SecretBox(`k1:${key()}`);
        const sealed = box.seal('hunter2', CTX);
        assert.ok(sealed.startsWith(`${SEALED_PREFIX}k1:`));
        assert.ok(!sealed.includes('hunter2'));
        assert.equal(box.open(sealed, CTX), 'hunter2');
        assert.notEqual(box.seal('hunter2', CTX), sealed, 'fresh IV each time');
    });

    it('fails on AAD mismatch, tampering and truncation', () => {
        const box = new SecretBox(`k1:${key()}`);
        const sealed = box.seal('hunter2', CTX);
        assert.throws(() => box.open(sealed, 'vcsIntegrations/other/clientSecret'));

        const payload = Buffer.from(sealed.split(':')[3], 'base64url');
        payload[payload.length - 1] ^= 1;
        assert.throws(() => box.open(`${SEALED_PREFIX}k1:${payload.toString('base64url')}`, CTX));

        assert.throws(() => box.open(`${SEALED_PREFIX}k1:AAAA`, CTX), /Malformed/);
        assert.throws(() => box.open(`${SEALED_PREFIX}k1`, CTX), /Malformed/);
    });

    it('raises SecretUnreadableError for a different key under the same id, and for malformed input', () => {
        const sealed = new SecretBox(`k1:${key()}`).seal('x', CTX);
        assert.throws(() => new SecretBox(`k1:${key()}`).open(sealed, CTX), SecretUnreadableError);
        assert.throws(() => new SecretBox(`k1:${key()}`).open(`${SEALED_PREFIX}k1:AAAA`, CTX), SecretUnreadableError);
        assert.ok(new SecretKeyUnavailableError('k1') instanceof SecretUnreadableError);
    });

    it('does not leak plaintext or sealed values in error messages', () => {
        const box = new SecretBox(`k1:${key()}`);
        const sealed = box.seal('hunter2', CTX);
        try {
            box.open(sealed, 'wrong');
            assert.fail('should throw');
        } catch (err) {
            const msg = (err as Error).message;
            assert.ok(!msg.includes('hunter2') && !msg.includes(sealed.slice(SEALED_PREFIX.length)));
        }
    });

    it('raises a typed error for an unknown key id', () => {
        const sealed = new SecretBox(`k1:${key()}`).seal('x', CTX);
        const other = new SecretBox(`k9:${key()}`);
        assert.throws(
            () => other.open(sealed, CTX),
            err => err instanceof SecretKeyUnavailableError && err.keyId === 'k1'
        );
        assert.throws(() => new SecretBox().open(sealed, CTX), SecretKeyUnavailableError);
    });

    it('passes plaintext through on open', () => {
        const box = new SecretBox(`k1:${key()}`);
        assert.equal(box.open('legacy-plain', CTX), 'legacy-plain');
        assert.equal(new SecretBox().open('legacy-plain', CTX), 'legacy-plain');
    });

    it('is a no-op when disabled', () => {
        const box = new SecretBox();
        assert.equal(box.enabled, false);
        assert.equal(box.seal('plain', CTX), 'plain');
        assert.equal(box.needsReseal('plain'), false);
    });

    it('leaves empty strings alone', () => {
        const box = new SecretBox(`k1:${key()}`);
        assert.equal(box.seal('', CTX), '');
        assert.equal(box.needsReseal(''), false);
    });

    it('needsReseal covers plaintext and non-active keys', () => {
        const k1 = key();
        const k2 = key();
        const old = new SecretBox(`k1:${k1}`);
        const sealedOld = old.seal('v', CTX);
        const rotated = new SecretBox(`k2:${k2},k1:${k1}`);
        assert.equal(old.needsReseal(sealedOld), false);
        assert.equal(rotated.needsReseal(sealedOld), true);
        assert.equal(rotated.needsReseal('plain'), true);
        const resealed = rotated.seal(rotated.open(sealedOld, CTX), CTX);
        assert.ok(resealed.startsWith(`${SEALED_PREFIX}k2:`));
        assert.equal(rotated.needsReseal(resealed), false);
        assert.equal(new SecretBox(`k2:${k2}`).open(resealed, CTX), 'v');
    });
});

describe('parseKeyring', () => {
    it('keeps order; first key is active', () => {
        const ring = parseKeyring(`k2:${key()}, k1:${key()}`);
        assert.equal(ring.activeId, 'k2');
        assert.deepEqual([...ring.keys.keys()], ['k2', 'k1']);
    });

    it('rejects malformed specs', () => {
        assert.throws(() => parseKeyring(''), /empty/);
        assert.throws(() => parseKeyring(key()), /<id>:<base64 key>/);
        assert.throws(() => parseKeyring(`K1:${key()}`), /<id>:<base64 key>/);
        assert.throws(() => parseKeyring(`${'a'.repeat(17)}:${key()}`), /<id>:<base64 key>/);
        assert.throws(() => parseKeyring(`k1:${key()},k1:${key()}`), /duplicate/);
        assert.throws(() => parseKeyring(`k1:${randomBytes(16).toString('base64')}`), /32 bytes/);
        assert.throws(() => parseKeyring('k1:!!!notbase64'), /base64/);
    });
});

describe('assertSecretsConfig', () => {
    it('requires keys in production only', () => {
        assert.throws(() => assertSecretsConfig({ APP_ENV: 'production' }), /required when APP_ENV=production/);
        assert.doesNotThrow(() => assertSecretsConfig({ APP_ENV: 'production', SECRETS_ENCRYPTION_KEYS: `k1:${key()}` }));
        assert.doesNotThrow(() => assertSecretsConfig({ APP_ENV: 'development' }));
        assert.doesNotThrow(() => assertSecretsConfig({ APP_ENV: 'test' }));
    });

    it('throws on a malformed keyring in any environment', () => {
        assert.throws(() => assertSecretsConfig({ APP_ENV: 'development', SECRETS_ENCRYPTION_KEYS: 'garbage' }));
    });
});
