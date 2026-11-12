import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import { assertSecretsConfig, SEALED_PREFIX, SecretBox, SecretUnreadableError } from '../../src/services/secrets/SecretBox';

const key = () => randomBytes(32).toString('hex');

describe('SecretBox', () => {
    it('round-trips and uses the sealed format', () => {
        const box = new SecretBox(key());
        const sealed = box.seal('hunter2');
        assert.ok(sealed.startsWith(SEALED_PREFIX));
        assert.ok(!sealed.includes('hunter2'));
        assert.equal(box.open(sealed), 'hunter2');
    });

    it('produces different ciphertexts for the same plaintext', () => {
        const box = new SecretBox(key());
        assert.notEqual(box.seal('hunter2'), box.seal('hunter2'));
    });

    it('raises SecretUnreadableError for a different key', () => {
        const sealed = new SecretBox(key()).seal('x');
        assert.throws(() => new SecretBox(key()).open(sealed), SecretUnreadableError);
    });

    it('raises SecretUnreadableError for malformed or tampered prefixed values', () => {
        const box = new SecretBox(key());
        assert.throws(() => box.open(`${SEALED_PREFIX}AAAA`), SecretUnreadableError);
        assert.throws(() => box.open(SEALED_PREFIX), SecretUnreadableError);
        const raw = Buffer.from(box.seal('hunter2').slice(SEALED_PREFIX.length), 'base64');
        raw[raw.length - 1] ^= 1;
        assert.throws(() => box.open(SEALED_PREFIX + raw.toString('base64')), SecretUnreadableError);
    });

    it('raises SecretUnreadableError for a prefixed value when disabled', () => {
        const sealed = new SecretBox(key()).seal('x');
        assert.throws(() => new SecretBox().open(sealed), SecretUnreadableError);
    });

    it('does not leak plaintext or sealed values in error messages', () => {
        const sealed = new SecretBox(key()).seal('hunter2');
        try {
            new SecretBox(key()).open(sealed);
            assert.fail('should throw');
        } catch (err) {
            const msg = (err as Error).message;
            assert.ok(!msg.includes('hunter2') && !msg.includes(sealed.slice(SEALED_PREFIX.length)));
        }
    });

    it('passes legacy plaintext through on open', () => {
        assert.equal(new SecretBox(key()).open('legacy-plain'), 'legacy-plain');
        assert.equal(new SecretBox().open('legacy-plain'), 'legacy-plain');
    });

    it('raises SecretUnreadableError for a missing (non-string) stored value', () => {
        assert.throws(() => new SecretBox(key()).open(undefined as unknown as string), SecretUnreadableError);
        assert.throws(() => new SecretBox().open(null as unknown as string), SecretUnreadableError);
    });

    it('seal is the identity when disabled', () => {
        const box = new SecretBox();
        assert.equal(box.enabled, false);
        assert.equal(box.seal('plain'), 'plain');
        assert.equal(box.needsSeal('plain'), false);
    });

    it('leaves empty strings alone', () => {
        const box = new SecretBox(key());
        assert.equal(box.seal(''), '');
        assert.equal(box.needsSeal(''), false);
    });

    it('needsSeal is true only for non-empty plaintext when enabled', () => {
        const box = new SecretBox(key());
        assert.equal(box.enabled, true);
        assert.equal(box.needsSeal('plain'), true);
        assert.equal(box.needsSeal(box.seal('plain')), false);
        assert.equal(box.needsSeal(''), false);
    });

    it('throws on an invalid secret', () => {
        assert.throws(() => new SecretBox('too-short'));
        assert.throws(() => new SecretBox('z'.repeat(64)));
    });
});

describe('assertSecretsConfig', () => {
    it('requires a secret in production only', () => {
        assert.throws(() => assertSecretsConfig({ APP_ENV: 'production' }), /CRYPTO_SECRET is required when APP_ENV=production/);
        assert.doesNotThrow(() => assertSecretsConfig({ APP_ENV: 'production', CRYPTO_SECRET: key() }));
        assert.doesNotThrow(() => assertSecretsConfig({ APP_ENV: 'development' }));
        assert.doesNotThrow(() => assertSecretsConfig({ APP_ENV: 'test' }));
    });

    it('throws on a malformed secret in any environment', () => {
        assert.throws(() => assertSecretsConfig({ APP_ENV: 'development', CRYPTO_SECRET: 'garbage' }));
    });
});
