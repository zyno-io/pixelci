import { http, HttpRequest, openapi, rawResponse } from '@zyno-io/ts-server-foundation';

import { AppConfig } from '../config';
import { OAUTH_REGISTER_BODY_LIMIT, OAUTH_TOKEN_BODY_LIMIT } from '../services/oauth/OAuthConstants';
import { notFoundResponse, OAuthError, oauthErrorResponse, oauthJson, parseBasic } from '../services/oauth/OAuthErrors';
import { contentTypeIs, FormParams, readLimitedBody } from '../services/oauth/OAuthHttp';
import { IClientCredentials, OAuthServerService } from '../services/oauth/OAuthServer.service';
import { IOAuthUrls } from '../services/oauth/OAuthUrls';
import { RateLimiterService } from '../services/RateLimiter.service';

const HOUR_S = 3600;
const TEN_MIN_S = 600;
const AUTHORIZE_LIMIT_PER_10_MIN = 60;
const TOKEN_LIMIT_PER_10_MIN = 300;
const REVOKE_LIMIT_PER_10_MIN = 60;

/** Parameters of a token/revocation request, as they are read from the form body (`resource` may repeat). */
const REPEATABLE = new Set(['resource']);

/**
 * OAuth 2.1 protocol endpoints (not part of the OpenAPI schema). They parse requests by hand so every failure is an OAuth-shaped
 * error rather than a framework one. Every route answers 404 JSON when OAuth is unavailable.
 */
@http.controller('/api/oauth')
@openapi.ignore()
export class OAuthController {
    constructor(
        private oauth: OAuthServerService,
        private rateLimiter: RateLimiterService,
        private appConfig: AppConfig
    ) {}

    @http.POST('/register')
    async register(request: HttpRequest) {
        const urls = this.oauth.urls();
        if (!urls) return notFoundResponse();
        try {
            const ip = request.getRemoteAddress();
            await this.limit(`dcr:ip:${ip}`, this.appConfig.OAUTH_DCR_MAX_PER_IP_PER_HOUR, HOUR_S);
            // The global cap is checked here but only counted after a successful registration, so junk requests can't use it
            // up and lock out legitimate clients.
            const global = await this.rateLimiter.peek('dcr:all', this.appConfig.OAUTH_DCR_MAX_PER_HOUR);
            if (!global.allowed) {
                throw new OAuthError('temporarily_unavailable', 'Too many requests.', 429, { 'Retry-After': String(global.retryAfterSeconds) });
            }

            if (!contentTypeIs(request, 'application/json')) {
                throw new OAuthError('invalid_client_metadata', 'The request must be application/json.');
            }
            const text = await readLimitedBody(request, OAUTH_REGISTER_BODY_LIMIT);
            let metadata: unknown;
            try {
                metadata = JSON.parse(text);
            } catch {
                throw new OAuthError('invalid_client_metadata', 'The request body is not valid JSON.');
            }

            const { client, clientSecret } = await this.oauth.registerClient(metadata);
            await this.rateLimiter.hit('dcr:all', this.appConfig.OAUTH_DCR_MAX_PER_HOUR, HOUR_S);
            return oauthJson(
                {
                    client_id: client.id,
                    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
                    redirect_uris: client.redirectUris,
                    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
                    grant_types: ['authorization_code', 'refresh_token'],
                    response_types: ['code'],
                    client_name: client.name,
                    scope: 'mcp:read',
                    ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {})
                },
                201
            );
        } catch (err) {
            return this.fail(err);
        }
    }

    /** Top-level browser navigation: there is no session here, so this only validates the request and hands over to the consent screen. */
    @http.GET('/authorize')
    async authorize(request: HttpRequest) {
        const urls = this.oauth.urls();
        if (!urls) return notFoundResponse();

        const limited = await this.rateLimiter.hit(`authorize:ip:${request.getRemoteAddress()}`, AUTHORIZE_LIMIT_PER_10_MIN, TEN_MIN_S);
        if (!limited.allowed) return this.redirect(errorPageUrl(urls, 'rate_limited'));

        const result = await this.oauth.startAuthorization(request.query, urls, request.getRemoteAddress());
        switch (result.type) {
            case 'error_page':
                return this.redirect(errorPageUrl(urls, result.reason));
            case 'client_error':
                return this.redirect(result.location);
            case 'consent': {
                const url = new URL(urls.consent);
                url.searchParams.set('request', result.requestId);
                return this.redirect(url.toString());
            }
        }
    }

    @http.POST('/token')
    async token(request: HttpRequest) {
        const urls = this.oauth.urls();
        if (!urls) return notFoundResponse();
        try {
            await this.limit(`token:ip:${request.getRemoteAddress()}`, TOKEN_LIMIT_PER_10_MIN, TEN_MIN_S);
            const params = await this.readForm(request);
            const client = await this.oauth.authenticateClient(clientCredentials(request, params), {
                refresh: true,
                clientIp: request.getRemoteAddress()
            });

            const grantType = params.require('grant_type');
            let tokens;
            if (grantType === 'authorization_code') {
                tokens = await this.oauth.exchangeAuthorizationCode(
                    client,
                    {
                        code: params.require('code'),
                        redirectUri: params.require('redirect_uri'),
                        codeVerifier: params.require('code_verifier'),
                        resource: params.all('resource')
                    },
                    urls
                );
            } else if (grantType === 'refresh_token') {
                tokens = await this.oauth.refreshTokens(
                    client,
                    { refreshToken: params.require('refresh_token'), scope: params.get('scope'), resource: params.all('resource') },
                    urls
                );
            } else {
                throw new OAuthError('unsupported_grant_type', 'Only authorization_code and refresh_token are supported.');
            }
            return oauthJson(tokens);
        } catch (err) {
            return this.fail(err);
        }
    }

    @http.POST('/revoke')
    async revoke(request: HttpRequest) {
        const urls = this.oauth.urls();
        if (!urls) return notFoundResponse();
        try {
            await this.limit(`revoke:ip:${request.getRemoteAddress()}`, REVOKE_LIMIT_PER_10_MIN, TEN_MIN_S);
            const params = await this.readForm(request);
            const client = await this.oauth.authenticateClient(clientCredentials(request, params));
            const token = params.require('token');
            await this.oauth.revokeToken(client, token);
            // RFC 7009: success whether or not the token existed.
            return rawResponse('', { statusCode: 200, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
        } catch (err) {
            return this.fail(err);
        }
    }

    private async readForm(request: HttpRequest): Promise<FormParams> {
        if (!contentTypeIs(request, 'application/x-www-form-urlencoded')) {
            throw new OAuthError('invalid_request', 'The request must be application/x-www-form-urlencoded.');
        }
        const params = new FormParams(new URLSearchParams(await readLimitedBody(request, OAUTH_TOKEN_BODY_LIMIT)));
        if (params.repeated().some(name => !REPEATABLE.has(name))) throw new OAuthError('invalid_request', 'A parameter was repeated.');
        return params;
    }

    private async limit(key: string, max: number, windowSeconds: number): Promise<void> {
        const result = await this.rateLimiter.hit(key, max, windowSeconds);
        if (!result.allowed) {
            throw new OAuthError('temporarily_unavailable', 'Too many requests.', 429, { 'Retry-After': String(result.retryAfterSeconds) });
        }
    }

    private fail(err: unknown) {
        if (err instanceof OAuthError) return oauthErrorResponse(err);
        throw err;
    }

    private redirect(location: string) {
        return rawResponse('', {
            statusCode: 302,
            headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }
        });
    }
}

function errorPageUrl(urls: IOAuthUrls, reason: string): string {
    const url = new URL(urls.error);
    url.searchParams.set('reason', reason);
    return url.toString();
}

function clientCredentials(request: HttpRequest, params: FormParams): IClientCredentials {
    const header = request.headers.authorization;
    const isBasic = typeof header === 'string' && /^Basic\b/i.test(header);
    return {
        basic: isBasic ? (parseBasic(header) ?? 'malformed') : undefined,
        bodyClientId: params.get('client_id'),
        bodyClientSecret: params.get('client_secret')
    };
}
