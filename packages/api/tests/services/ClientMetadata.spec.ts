import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    cacheTtlSeconds,
    describeClientIdentity,
    isSharedHostingHost,
    registrableDomain,
    parseClientIdUrl,
    validateClientMetadataDocument
} from '../../src/services/oauth/ClientMetadata';
import { ipBucket } from '../../src/services/oauth/ClientMetadataResolver.service';
import { publisherOf } from '../../src/services/oauth/OAuthServer.service';

const ID = 'https://app.example.com/oauth/client.json';

const doc = (extra: Record<string, unknown> = {}) => ({
    client_id: ID,
    client_name: 'Example App',
    redirect_uris: ['https://app.example.com/cb'],
    ...extra
});

const valid = (extra: Record<string, unknown> = {}) => validateClientMetadataDocument(doc(extra), ID).ok;

describe('parseClientIdUrl', () => {
    it('accepts canonical https URLs with a path', () => {
        for (const ok of [ID, 'https://example.com/a', 'https://sub.example.co.uk/x/y%7Ez', 'https://xn--bcher-kva.example/m.json']) {
            assert.equal(parseClientIdUrl(ok).ok, true, ok);
        }
    });

    it('rejects what is not already canonical', () => {
        for (const bad of ['https://EXAMPLE.com/a', 'https://example.com:443/a', 'https://example.com//a/../b']) {
            assert.equal(parseClientIdUrl(bad).ok, false, bad);
        }
    });

    it('rejects root path, dot segments, query, fragment, userinfo', () => {
        for (const bad of [
            'https://example.com',
            'https://example.com/',
            'https://example.com/a/./b',
            'https://example.com/a/../b',
            'https://example.com/a/%2e%2e/b',
            'https://example.com/a?x=1',
            'https://example.com/a?',
            'https://example.com/a#f',
            'https://user@example.com/a',
            'https://user:pw@example.com/a'
        ]) {
            assert.equal(parseClientIdUrl(bad).ok, false, bad);
        }
    });

    it('rejects IP literals and internal names', () => {
        for (const bad of [
            'https://127.0.0.1/a',
            'https://10.0.0.1/a',
            'https://[::1]/a',
            'https://[2606:4700:4700::1111]/a',
            'https://localhost/a',
            'https://foo.localhost/a',
            'https://printer.local/a',
            'https://db.internal/a',
            'https://svc.cluster.local/a',
            'https://api.default.svc/a',
            'https://intranet/a',
            'https://example.com./a'
        ]) {
            assert.equal(parseClientIdUrl(bad).ok, false, bad);
        }
    });

    it('rejects non-443 ports, other schemes, odd characters and non-strings', () => {
        for (const bad of [
            'https://example.com:8443/a',
            'http://example.com/a',
            'ftp://example.com/a',
            'https://example.com/a b',
            'https://example.com/a\\b',
            'https://example.com/a\u0000',
            'https://example.com/' + 'a'.repeat(2048),
            '',
            'not a url'
        ]) {
            assert.equal(parseClientIdUrl(bad).ok, false, bad);
        }
        assert.equal(parseClientIdUrl(undefined).ok, false);
        assert.equal(parseClientIdUrl(42).ok, false);
    });
});

describe('validateClientMetadataDocument', () => {
    it('accepts a minimal document', () => {
        assert.deepEqual(validateClientMetadataDocument(doc(), ID), { ok: true, name: 'Example App', redirectUris: ['https://app.example.com/cb'] });
    });

    it('requires client_id to match the fetch URL exactly', () => {
        assert.equal(valid({ client_id: ID + '/' }), false);
        assert.equal(valid({ client_id: undefined }), false);
        assert.equal(valid({ client_id: 5 }), false);
    });

    it('rejects non-objects', () => {
        for (const v of [null, 'x', 1, [], undefined]) assert.equal(validateClientMetadataDocument(v, ID).ok, false);
    });

    it('rejects secrets and shared-secret or key-based auth', () => {
        assert.equal(valid({ client_secret: 's' }), false);
        assert.equal(valid({ client_secret_expires_at: 0 }), false);
        for (const m of ['client_secret_basic', 'client_secret_post', 'client_secret_jwt', 'private_key_jwt', 'weird']) {
            assert.equal(valid({ token_endpoint_auth_method: m }), false, m);
        }
        assert.equal(valid({ token_endpoint_auth_method: 7 }), false);
        assert.equal(valid({ token_endpoint_auth_methods_supported: ['private_key_jwt'] }), false);
        assert.equal(valid({ token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'] }), false);
        assert.equal(valid({ token_endpoint_auth_methods_supported: [] }), false);
        assert.equal(valid({ token_endpoint_auth_methods_supported: 'none' }), false);
    });

    it('accepts none, declared either way, or nothing declared', () => {
        assert.equal(valid({ token_endpoint_auth_method: 'none' }), true);
        assert.equal(valid({ token_endpoint_auth_methods_supported: ['none'] }), true);
        assert.equal(valid({ token_endpoint_auth_methods_supported: ['private_key_jwt', 'none'] }), true);
    });

    it('requires client_name and usable redirect_uris', () => {
        assert.equal(valid({ client_name: undefined }), false);
        assert.equal(valid({ client_name: '' }), false);
        assert.equal(valid({ client_name: '‮​' }), false);
        assert.equal(valid({ client_name: 9 }), false);
        assert.equal(valid({ redirect_uris: undefined }), false);
        assert.equal(valid({ redirect_uris: 'https://a.example/cb' }), false);
        assert.equal(valid({ redirect_uris: [] }), false);
        assert.equal(valid({ redirect_uris: ['myapp://cb', 'javascript:alert(1)', 'http://evil.example/cb', 5] }), false);
    });

    it('drops unusable redirect URIs and keeps the rest', () => {
        const r = validateClientMetadataDocument(
            doc({
                redirect_uris: [
                    'myapp://cb',
                    'https://app.example.com/cb',
                    'http://127.0.0.1/cb',
                    'https://app.example.com/cb',
                    'http://evil.example/x'
                ]
            }),
            ID
        );
        assert.deepEqual(r.ok && r.redirectUris, ['https://app.example.com/cb', 'http://127.0.0.1/cb']);
    });

    it('rejects more than 50 usable redirect URIs', () => {
        const many = Array.from({ length: 51 }, (_, i) => 'https://app.example.com/cb' + i);
        assert.equal(valid({ redirect_uris: many }), false);
        assert.equal(valid({ redirect_uris: many.slice(0, 50) }), true);
    });

    it('filters grant_types and response_types to what is supported', () => {
        assert.equal(valid({ grant_types: ['authorization_code', 'implicit'] }), true);
        assert.equal(valid({ grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }), true);
        assert.equal(valid({ grant_types: ['refresh_token'] }), false);
        assert.equal(valid({ grant_types: ['implicit'] }), false);
        assert.equal(valid({ grant_types: 'authorization_code' }), false);
        assert.equal(valid({ response_types: ['token'] }), false);
        assert.equal(valid({ response_types: ['code', 'token'] }), true);
    });

    it('sanitizes the name and ignores unrelated fields', () => {
        const r = validateClientMetadataDocument(
            doc({ client_name: '  Claude‮ Code\n ', logo_uri: 'https://x.example/l.png', jwks_uri: 'https://x.example/k', scope: 'a b' }),
            ID
        );
        assert.equal(r.ok && r.name, 'Claude Code');
    });
});

describe('cacheTtlSeconds', () => {
    it('clamps max-age to 5 minutes..24 hours with a 1 hour default', () => {
        assert.equal(cacheTtlSeconds(undefined), 3600);
        assert.equal(cacheTtlSeconds('max-age=7200'), 7200);
        assert.equal(cacheTtlSeconds('public, max-age=600'), 600);
        assert.equal(cacheTtlSeconds('max-age=0'), 300);
        assert.equal(cacheTtlSeconds('max-age=10'), 300);
        assert.equal(cacheTtlSeconds('no-store'), 300);
        assert.equal(cacheTtlSeconds('no-cache, max-age=9999'), 300);
        assert.equal(cacheTtlSeconds('max-age=99999999'), 86400);
        assert.equal(cacheTtlSeconds('MAX-AGE=1000'), 1000);
        assert.equal(cacheTtlSeconds('max-age=abc'), 3600);
        assert.equal(cacheTtlSeconds('max-age=-5'), 3600);
        assert.equal(cacheTtlSeconds('s-maxage=9000'), 3600);
        assert.equal(cacheTtlSeconds('max-age=99999999999999'), 3600);
    });
});

describe('describeClientIdentity', () => {
    it('leaves registered clients unverified', () => {
        assert.deepEqual(describeClientIdentity(null, 'https://claude.ai/cb'), {
            clientIdHost: null,
            verification: 'unverified',
            redirectOffDomain: false
        });
    });

    it('verifies the domain for web redirects', () => {
        assert.deepEqual(describeClientIdentity(ID, 'https://app.example.com/cb'), {
            clientIdHost: 'app.example.com',
            verification: 'verified_domain',
            redirectOffDomain: false
        });
        assert.equal(describeClientIdentity('https://example.com/c.json', 'https://app.example.com/cb').redirectOffDomain, false);
    });

    it('flags an off-domain web redirect', () => {
        const r = describeClientIdentity(ID, 'https://other.example.org/cb');
        assert.equal(r.verification, 'verified_domain');
        assert.equal(r.redirectOffDomain, true);
        assert.equal(describeClientIdentity(ID, 'https://evilapp.example.com/cb').redirectOffDomain, true);
        assert.equal(describeClientIdentity('https://pp.example.com/c.json', 'https://app.example.com/cb').redirectOffDomain, true);
    });

    it('never verifies a loopback redirect or a shared-hosting host', () => {
        assert.deepEqual(describeClientIdentity(ID, 'http://127.0.0.1:8123/cb'), {
            clientIdHost: 'app.example.com',
            verification: 'claimed_domain',
            redirectOffDomain: false
        });
        assert.equal(describeClientIdentity('https://someone.github.io/c.json', 'https://someone.github.io/cb').verification, 'claimed_domain');
        assert.equal(describeClientIdentity('https://github.io/c.json', 'https://x.example/cb').verification, 'claimed_domain');
        assert.equal(isSharedHostingHost('notgithub.io'), false);
        assert.equal(isSharedHostingHost('a.b.pages.dev'), true);
    });

    it('keeps punycode hosts as written', () => {
        assert.equal(
            describeClientIdentity('https://xn--bcher-kva.example/c.json', 'https://xn--bcher-kva.example/cb').clientIdHost,
            'xn--bcher-kva.example'
        );
        assert.equal(publisherOf('https://xn--bcher-kva.example/c.json'), 'xn--bcher-kva.example');
        assert.equal(publisherOf(null), null);
    });

    it('treats https loopback redirects like http ones', () => {
        for (const uri of [
            'https://localhost/cb',
            'https://127.0.0.1:8443/cb',
            'https://[::1]/cb',
            'https://app.localhost/cb',
            'https://127.1.2.3/cb'
        ]) {
            const r = describeClientIdentity(ID, uri);
            assert.equal(r.verification, 'claimed_domain', uri);
            assert.equal(r.redirectOffDomain, false, uri);
        }
    });
});

describe('shared hosting', () => {
    it('recognises hosts where anyone can publish', () => {
        for (const host of [
            'someone.github.io',
            'raw.githubusercontent.com',
            'gist.githubusercontent.com',
            's3.amazonaws.com',
            's3.us-east-1.amazonaws.com',
            's3-us-west-2.amazonaws.com',
            's3.dualstack.eu-west-1.amazonaws.com',
            'bucket.s3.us-east-1.amazonaws.com',
            'bucket.s3.amazonaws.com',
            'cdn.jsdelivr.net',
            'unpkg.com',
            'abc123.r2.dev',
            'myproj.firebaseio.com',
            'myproj.web.app',
            'storage.googleapis.com',
            'acct.blob.core.windows.net',
            'x.pages.dev',
            'x.vercel.app',
            'x.herokuapp.com',
            'x.ngrok-free.app'
        ]) {
            assert.equal(isSharedHostingHost(host), true, host);
            assert.equal(describeClientIdentity(`https://${host}/c.json`, `https://${host}/cb`).verification, 'claimed_domain', host);
        }
    });

    it('leaves ordinary domains alone', () => {
        for (const host of ['app.example.com', 'example.co.uk', 'claude.ai', 'notgithub.io', 'mygithub.io.example.com', 'anthropic.com']) {
            assert.equal(isSharedHostingHost(host), false, host);
        }
    });

    it('keys a registrable domain per tenant of a shared host', () => {
        assert.equal(registrableDomain('a.b.example.com'), 'example.com');
        assert.equal(registrableDomain('a.b.example.co.uk'), 'example.co.uk');
        assert.equal(registrableDomain('x.github.io'), 'x.github.io');
        assert.equal(registrableDomain('deep.x.github.io'), 'x.github.io');
    });
});

describe('ipBucket', () => {
    it('keys IPv6 callers by /64 and leaves IPv4 alone', () => {
        assert.equal(ipBucket('203.0.113.7'), '203.0.113.7');
        assert.equal(ipBucket('::ffff:203.0.113.7'), '203.0.113.7');
        assert.equal(ipBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), ipBucket('2001:db8:1:2::1'));
        assert.notEqual(ipBucket('2001:db8:1:2::1'), ipBucket('2001:db8:1:3::1'));
        assert.equal(ipBucket('2001:db8:1:2::1%eth0'), ipBucket('2001:db8:1:2::9'));
    });
});
