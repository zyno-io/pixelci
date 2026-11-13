import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import { assertSecretsConfig, SecretBox, SecretUnreadableError } from '../../src/services/secrets/SecretBox';

const key = () => randomBytes(32).toString('hex');

describe('SecretBox', () => {
    it('round-trips without exposing the plaintext', () => {
        const box = new SecretBox(key());
        const sealed = box.seal('hunter2');
        assert.ok(!sealed.includes('hunter2'));
        assert.equal(box.open(sealed), 'hunter2');
    });

    it('encrypts empty strings too', () => {
        const box = new SecretBox(key());
        const sealed = box.seal('');
        assert.notEqual(sealed, '');
        assert.equal(box.open(sealed), '');
    });

    it('produces different ciphertexts for the same plaintext', () => {
        const box = new SecretBox(key());
        assert.notEqual(box.seal('hunter2'), box.seal('hunter2'));
    });

    it('raises SecretUnreadableError for a different key', () => {
        const sealed = new SecretBox(key()).seal('x');
        assert.throws(() => new SecretBox(key()).open(sealed), SecretUnreadableError);
    });

    it('raises SecretUnreadableError for garbage and tampered values', () => {
        const box = new SecretBox(key());
        assert.throws(() => box.open('AAAA'), SecretUnreadableError);
        assert.throws(() => box.open(''), SecretUnreadableError);
        const raw = Buffer.from(box.seal('hunter2'), 'base64');
        raw[raw.length - 1] ^= 1;
        assert.throws(() => box.open(raw.toString('base64')), SecretUnreadableError);
    });

    it('does not pass plaintext through', () => {
        assert.throws(() => new SecretBox(key()).open('legacy-plain'), SecretUnreadableError);
    });

    it('raises SecretUnreadableError for a missing (non-string) stored value', () => {
        assert.throws(() => new SecretBox(key()).open(undefined as unknown as string), SecretUnreadableError);
        assert.throws(() => new SecretBox(key()).open(null as unknown as string), SecretUnreadableError);
    });

    it('does not leak plaintext or ciphertext in error messages', () => {
        const sealed = new SecretBox(key()).seal('hunter2');
        try {
            new SecretBox(key()).open(sealed);
            assert.fail('should throw');
        } catch (err) {
            const msg = (err as Error).message;
            assert.ok(!msg.includes('hunter2') && !msg.includes(sealed));
        }
    });

    it('throws on a missing or invalid secret', () => {
        assert.throws(() => new SecretBox(), /CRYPTO_SECRET is required/);
        assert.throws(() => new SecretBox(''), /CRYPTO_SECRET is required/);
        assert.throws(() => new SecretBox('too-short'));
        assert.throws(() => new SecretBox('z'.repeat(64)));
    });
});

describe('assertSecretsConfig', () => {
    it('requires a secret', () => {
        assert.throws(() => assertSecretsConfig({}), /CRYPTO_SECRET is required \(generate one with: openssl rand -hex 32\)/);
        assert.doesNotThrow(() => assertSecretsConfig({ CRYPTO_SECRET: key() }));
    });

    it('throws on a malformed secret', () => {
        assert.throws(() => assertSecretsConfig({ CRYPTO_SECRET: 'garbage' }));
    });
});
