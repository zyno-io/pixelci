import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseVcsPatBearer } from '../../src/accessories/AuthMiddleware.accessory';
import { generateToken, hashToken, pkceS256, safeEqual, verifyPkce } from '../../src/services/oauth/OAuthCrypto';
import { bearerChallenge, parseBasic, parseBearer } from '../../src/services/oauth/OAuthErrors';
import { FormParams } from '../../src/services/oauth/OAuthHttp';
import { buildRedirect, sanitizeClientName } from '../../src/services/oauth/OAuthServer.service';
import { getOAuthUrls, normalizeResource } from '../../src/services/oauth/OAuthUrls';
import { describeRedirectUri, isValidRedirectUri, redirectUriMatches } from '../../src/services/oauth/RedirectUris';

const URLS = getOAuthUrls({ MCP_OAUTH_ENABLED: true, PUBLIC_URL: 'https://pixelci.example.com' })!;

describe('getOAuthUrls', () => {
    it('derives everything from the PUBLIC_URL origin', () => {
        assert.equal(URLS.issuer, 'https://pixelci.example.com');
        assert.equal(URLS.resource, 'https://pixelci.example.com/api/mcp');
        assert.equal(URLS.protectedResourceMetadata, 'https://pixelci.example.com/.well-known/oauth-protected-resource/api/mcp');
        assert.equal(URLS.token, 'https://pixelci.example.com/api/oauth/token');
        assert.equal(getOAuthUrls({ MCP_OAUTH_ENABLED: true, PUBLIC_URL: 'https://pixelci.example.com/' })?.issuer, 'https://pixelci.example.com');
    });

    it('is unavailable when disabled or PUBLIC_URL is unsuitable', () => {
        assert.equal(getOAuthUrls({ MCP_OAUTH_ENABLED: false, PUBLIC_URL: 'https://x.example.com' }), null);
        for (const bad of [
            undefined,
            '',
            'not a url',
            'http://pixelci.example.com',
            'https://x.example.com/sub',
            'https://x.example.com/?a=b',
            'https://x.example.com/#frag',
            'https://x.example.com?',
            'https://user:pw@x.example.com',
            'ftp://x.example.com'
        ]) {
            assert.equal(getOAuthUrls({ MCP_OAUTH_ENABLED: true, PUBLIC_URL: bad }), null, String(bad));
        }
    });

    it('allows http only on a loopback host', () => {
        assert.equal(getOAuthUrls({ MCP_OAUTH_ENABLED: true, PUBLIC_URL: 'http://localhost:7925' })?.issuer, 'http://localhost:7925');
        assert.equal(getOAuthUrls({ MCP_OAUTH_ENABLED: true, PUBLIC_URL: 'http://127.0.0.1:7925' })?.issuer, 'http://127.0.0.1:7925');
        assert.equal(getOAuthUrls({ MCP_OAUTH_ENABLED: true, PUBLIC_URL: 'http://[::1]:7925' })?.issuer, 'http://[::1]:7925');
    });
});

describe('normalizeResource', () => {
    it('defaults to the canonical resource', () => {
        assert.equal(normalizeResource([], URLS), URLS.resource);
    });

    it('accepts the origin and the MCP path, with trailing slashes', () => {
        for (const ok of [
            'https://pixelci.example.com',
            'https://pixelci.example.com/',
            'https://pixelci.example.com/api/mcp',
            'https://pixelci.example.com/api/mcp/'
        ]) {
            assert.equal(normalizeResource([ok], URLS), URLS.resource, ok);
        }
    });

    it('rejects anything else', () => {
        for (const bad of [
            'https://evil.example.com/api/mcp',
            'https://pixelci.example.com/api/ext',
            'https://pixelci.example.com/api/mcp?x=1',
            'https://pixelci.example.com/api/mcp#f',
            'http://pixelci.example.com/api/mcp',
            'https://pixelci.example.com:8443/api/mcp',
            'not a url',
            ''
        ]) {
            assert.equal(normalizeResource([bad], URLS), undefined, bad);
        }
        assert.equal(normalizeResource([URLS.resource, URLS.resource], URLS), undefined);
    });
});

describe('redirect URIs', () => {
    it('validates registrable URIs', () => {
        for (const ok of [
            'https://claude.ai/api/mcp/auth_callback',
            'http://localhost:33418/callback',
            'http://127.0.0.1/cb',
            'http://[::1]:8080/cb'
        ]) {
            assert.equal(isValidRedirectUri(ok), true, ok);
        }
        for (const bad of [
            'http://example.com/cb',
            'https://claude.ai/cb#frag',
            'javascript:alert(1)',
            'cursor://anysphere.cursor-retrieval/oauth',
            'https://user:pw@claude.ai/cb',
            'https:///cb',
            'claude.ai/cb',
            'https://claude.ai/cb\\evil',
            'https://claude.ai/c b',
            '',
            'https://claude.ai/' + 'a'.repeat(2100)
        ]) {
            assert.equal(isValidRedirectUri(bad), false, bad);
        }
    });

    it('matches exactly for web URIs', () => {
        const reg = 'https://claude.ai/api/mcp/auth_callback';
        assert.equal(redirectUriMatches(reg, reg), true);
        assert.equal(redirectUriMatches(reg, reg + '/'), false);
        assert.equal(redirectUriMatches(reg, reg + '?x=1'), false);
        assert.equal(redirectUriMatches(reg, 'https://claude.ai:444/api/mcp/auth_callback'), false);
        assert.equal(redirectUriMatches(reg, 'https://CLAUDE.AI/api/mcp/auth_callback'), false);
        assert.equal(redirectUriMatches(reg, 'https://evil.example/api/mcp/auth_callback'), false);
    });

    it('lets loopback URIs vary only in port', () => {
        const reg = 'http://127.0.0.1:1111/callback';
        assert.equal(redirectUriMatches(reg, 'http://127.0.0.1:2222/callback'), true);
        assert.equal(redirectUriMatches(reg, 'http://127.0.0.1/callback'), true);
        assert.equal(redirectUriMatches(reg, 'http://127.0.0.1:2222/other'), false);
        assert.equal(redirectUriMatches(reg, 'http://127.0.0.1:2222/callback?x=1'), false);
        assert.equal(redirectUriMatches(reg, 'http://localhost:2222/callback'), false);
        assert.equal(redirectUriMatches(reg, 'https://127.0.0.1:2222/callback'), false);
        assert.equal(redirectUriMatches('http://localhost/cb', 'http://localhost:9/cb'), true);
        assert.equal(redirectUriMatches('https://claude.ai/cb', 'https://claude.ai:9/cb'), false);
    });

    it('describes where the user will be sent', () => {
        assert.deepEqual(describeRedirectUri('https://claude.ai/api/mcp/auth_callback'), { redirectDisplay: 'claude.ai', redirectKind: 'web' });
        assert.deepEqual(describeRedirectUri('http://localhost:4242/cb'), {
            redirectDisplay: 'an app on this computer (localhost:4242)',
            redirectKind: 'loopback'
        });
    });
});

describe('PKCE', () => {
    // RFC 7636 appendix B
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    it('computes S256', () => {
        assert.equal(pkceS256(verifier), challenge);
        assert.equal(verifyPkce(verifier, challenge), true);
    });

    it('rejects a wrong or malformed verifier', () => {
        assert.equal(verifyPkce(verifier.slice(0, -1) + 'A', challenge), false);
        assert.equal(verifyPkce('short', challenge), false);
        assert.equal(verifyPkce(verifier + '!', challenge), false);
        assert.equal(verifyPkce(challenge, challenge), false);
    });
});

describe('token primitives', () => {
    it('generates prefixed 256-bit tokens that hash deterministically', () => {
        const a = generateToken('pixelci_at_');
        assert.match(a, /^pixelci_at_[A-Za-z0-9_-]{43}$/);
        assert.notEqual(a, generateToken('pixelci_at_'));
        assert.match(hashToken(a), /^[0-9a-f]{64}$/);
        assert.equal(hashToken(a), hashToken(a));
    });

    it('compares in constant time over digests, regardless of length', () => {
        assert.equal(safeEqual('abc', 'abc'), true);
        assert.equal(safeEqual('abc', 'abd'), false);
        assert.equal(safeEqual('abc', 'abcd'), false);
        assert.equal(safeEqual('', ''), true);
    });
});

describe('Authorization headers', () => {
    it('parses bearer credentials', () => {
        assert.equal(parseBearer('Bearer abc'), 'abc');
        assert.equal(parseBearer('bearer   abc  '), 'abc');
        assert.equal(parseBearer('Bearer'), undefined);
        assert.equal(parseBearer('Bearer a b'), undefined);
        assert.equal(parseBearer('Basic abc'), undefined);
        assert.equal(parseBearer(undefined), undefined);
    });

    it('parses Basic client credentials, form-decoding both halves', () => {
        const enc = (id: string, secret: string) =>
            'Basic ' + Buffer.from(encodeURIComponent(id) + ':' + encodeURIComponent(secret)).toString('base64');
        assert.deepEqual(parseBasic(enc('client', 'se:cret/+=')), { id: 'client', secret: 'se:cret/+=' });
        assert.deepEqual(parseBasic('Basic ' + Buffer.from('id:').toString('base64')), { id: 'id', secret: '' });
        assert.equal(parseBasic('Basic ' + Buffer.from('nocolon').toString('base64')), undefined);
        assert.equal(parseBasic('Basic !!!'), undefined);
        assert.equal(parseBasic('Basic ' + Buffer.from('%E0%A4%A:x').toString('base64')), undefined);
        assert.equal(parseBasic('Bearer abc'), undefined);
    });

    it('rejects pixelci_* and JWT-shaped tokens before any VCS call', () => {
        assert.deepEqual(parseVcsPatBearer('Bearer glpat-abc123'), { token: 'glpat-abc123' });
        assert.deepEqual(parseVcsPatBearer('Bearer ghp_abc'), { token: 'ghp_abc' });
        assert.deepEqual(parseVcsPatBearer('Bearer pixelci_at_abc'), { rejected: 'pixelci' });
        assert.deepEqual(parseVcsPatBearer('Bearer pixelci_rt_abc'), { rejected: 'pixelci' });
        assert.deepEqual(parseVcsPatBearer('Bearer pixelci_anything'), { rejected: 'pixelci' });
        assert.deepEqual(parseVcsPatBearer('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig-_x'), { rejected: 'jwt' });
        assert.deepEqual(parseVcsPatBearer(undefined), { rejected: 'missing' });
        assert.deepEqual(parseVcsPatBearer('Basic abc'), { rejected: 'missing' });
    });
});

describe('bearerChallenge', () => {
    const base = 'resource_metadata="https://pixelci.example.com/.well-known/oauth-protected-resource/api/mcp", scope="mcp:read"';

    it('points at the path-suffixed protected-resource metadata with the scope', () => {
        assert.equal(bearerChallenge(URLS), 'Bearer ' + base);
    });

    it('adds the error and strips quote-breaking characters from the description', () => {
        assert.equal(
            bearerChallenge(URLS, { error: 'invalid_token', description: 'bad "token" \\ here\r\n' }),
            'Bearer ' + base + ', error="invalid_token", error_description="bad token  here"'
        );
    });

    it('is a bare realm challenge when OAuth is unavailable', () => {
        assert.equal(bearerChallenge(null), 'Bearer realm="PixelCI"');
        assert.equal(bearerChallenge(null, { error: 'invalid_token' }), 'Bearer realm="PixelCI", error="invalid_token"');
    });
});

describe('FormParams', () => {
    it('detects repeated parameters instead of collapsing them', () => {
        const p = new FormParams(new URLSearchParams('a=1&b=2&b=3&resource=x&resource=y'));
        assert.equal(p.get('a'), '1');
        assert.deepEqual(p.repeated().sort(), ['b', 'resource']);
        assert.throws(() => p.get('b'), /repeated/);
        assert.deepEqual(p.all('resource'), ['x', 'y']);
        assert.throws(() => p.require('missing'), /missing/);
        assert.throws(() => new FormParams(new URLSearchParams('a=')).require('a'), /missing/);
    });
});

describe('client names and redirect building', () => {
    it('sanitizes client names', () => {
        assert.equal(sanitizeClientName('  Claude‮ Code\u0000  '), 'Claude Code');
        assert.equal(sanitizeClientName('a\n\tb   c'), 'a b c');
        assert.equal(sanitizeClientName('x'.repeat(300)).length, 100);
        assert.equal(sanitizeClientName(''), 'Unnamed MCP client');
        assert.equal(sanitizeClientName('‮​'), 'Unnamed MCP client');
        assert.equal(sanitizeClientName(42), 'Unnamed MCP client');
        assert.equal(sanitizeClientName(undefined), 'Unnamed MCP client');
    });

    it('builds redirects with URL, preserving existing query and encoding values', () => {
        const url = new URL(buildRedirect('https://claude.ai/cb?keep=1', URLS, { code: 'c&d=e' }, 'st ate&x'));
        assert.equal(url.searchParams.get('keep'), '1');
        assert.equal(url.searchParams.get('code'), 'c&d=e');
        assert.equal(url.searchParams.get('state'), 'st ate&x');
        assert.equal(url.searchParams.get('iss'), URLS.issuer);
        assert.equal(url.searchParams.get('d'), null);
        assert.equal(new URL(buildRedirect('https://claude.ai/cb', URLS, { error: 'access_denied' })).searchParams.has('state'), false);
    });
});
