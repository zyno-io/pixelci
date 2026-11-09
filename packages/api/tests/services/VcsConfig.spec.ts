import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import { inferTokenPlatform } from '../../src/accessories/AuthMiddleware.accessory';
import { IGitHubConfig } from '../../src/entities/VcsIntegration.entity';
import { mergeConfigUpdate, normalizeCreateConfig, redactConfig } from '../../src/services/VcsConfig';

const KEY = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
}).privateKey;

const ghInput = (config: Record<string, unknown> = {}) =>
    ({
        name: 'gh',
        platform: 'github',
        config: { clientId: 'c', clientSecret: 's', appId: '1', privateKey: KEY, oidcAudience: 'https://p.example.com/', ...config }
    }) as Parameters<typeof normalizeCreateConfig>[0];

describe('VcsConfig', () => {
    it('normalizes GitHub create input', () => {
        const { platform, config } = normalizeCreateConfig(ghInput({ url: ' https://github.com/ ' }));
        assert.equal(platform, 'github');
        const c = config as IGitHubConfig;
        assert.equal(c.oidcAudience, 'https://p.example.com');
        assert.equal(c.url, undefined);
        assert.equal(c.appId, '1');
    });

    it('keeps Enterprise url (trailing slash stripped)', () => {
        const c = normalizeCreateConfig(ghInput({ url: 'https://ghe.example.com/' })).config as IGitHubConfig;
        assert.equal(c.url, 'https://ghe.example.com');
    });

    it('rejects invalid GitHub config', () => {
        assert.throws(() => normalizeCreateConfig(ghInput({ privateKey: 'nope' })));
        assert.throws(() => normalizeCreateConfig(ghInput({ appId: 'x1' })));
        assert.throws(() => normalizeCreateConfig(ghInput({ appId: '' })));
        assert.throws(() => normalizeCreateConfig(ghInput({ url: 'ftp://x' })));
    });

    it('stores GitLab config untouched', () => {
        const config = { url: 'https://gl.example.com', clientId: 'a', clientSecret: 'b' };
        assert.deepEqual(normalizeCreateConfig({ name: 'x', platform: 'gitlab', config }).config, config);
    });

    it('merges GitHub updates: absent keeps, blank secrets keep, blank url removes', () => {
        const stored = normalizeCreateConfig(ghInput({ url: 'https://ghe.example.com' })).config;
        const merged = mergeConfigUpdate('github', stored, {
            oidcAudience: 'https://n.example.com/',
            clientSecret: '',
            privateKey: '',
            url: ''
        }) as IGitHubConfig;
        assert.equal(merged.oidcAudience, 'https://n.example.com');
        assert.equal(merged.clientSecret, 's');
        assert.equal(merged.privateKey, KEY.trim());
        assert.equal(merged.url, undefined);
        assert.equal(merged.appId, '1');
    });

    it('merges GitLab updates', () => {
        const merged = mergeConfigUpdate('gitlab', { url: 'u', clientId: 'a', clientSecret: 'b' }, { clientId: 'z', clientSecret: '' });
        assert.deepEqual(merged, { url: 'u', clientId: 'z', clientSecret: 'b' });
    });

    it('redacts secrets', () => {
        const gh = redactConfig('github', 'i', 'n', normalizeCreateConfig(ghInput()).config);
        assert.deepEqual(gh, {
            id: 'i',
            name: 'n',
            platform: 'github',
            config: { clientId: 'c', oidcAudience: 'https://p.example.com', hasPrivateKey: true, appId: '1' }
        });
        const gl = redactConfig('gitlab', 'i', 'n', { url: 'u', clientId: 'a', clientSecret: 'b' });
        assert.deepEqual(gl, { id: 'i', name: 'n', platform: 'gitlab', config: { url: 'u', clientId: 'a' } });
    });

    it('infers token platform from prefix', () => {
        for (const t of ['ghp_x', 'gho_x', 'ghu_x', 'ghs_x', 'ghr_x', 'github_pat_x']) assert.equal(inferTokenPlatform(t), 'github');
        for (const t of ['glpat-x', 'abc', '']) assert.equal(inferTokenPlatform(t), 'gitlab');
    });
});
