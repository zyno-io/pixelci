import { http, openapi, rawResponse } from '@zyno-io/ts-server-foundation';

import { OAUTH_SCOPE } from '../services/oauth/OAuthConstants';
import { notFoundResponse } from '../services/oauth/OAuthErrors';
import { OAuthServerService } from '../services/oauth/OAuthServer.service';

const METADATA_HEADERS = { 'Cache-Control': 'max-age=300', Vary: 'Origin' };

/**
 * OAuth discovery documents (RFC 9728 protected-resource metadata, RFC 8414 authorization-server metadata). Not part of the OpenAPI
 * schema. Every route answers 404 JSON when OAuth is unavailable, and unknown `/.well-known/*` paths answer 404 JSON too, because the
 * SPA fallback would otherwise serve its HTML to discovery probes.
 */
@http.controller('/.well-known')
@openapi.ignore()
export class OAuthWellKnownController {
    constructor(private oauth: OAuthServerService) {}

    @http.GET('/oauth-protected-resource/api/mcp')
    protectedResourcePathSuffixed() {
        return this.protectedResource();
    }

    /** Fallback for clients that skip the WWW-Authenticate pointer and probe the root. Same document. */
    @http.GET('/oauth-protected-resource')
    protectedResourceRoot() {
        return this.protectedResource();
    }

    @http.GET('/oauth-authorization-server')
    authorizationServer() {
        const urls = this.oauth.urls();
        if (!urls) return notFoundResponse();
        return rawResponse(
            JSON.stringify({
                issuer: urls.issuer,
                authorization_endpoint: urls.authorization,
                token_endpoint: urls.token,
                registration_endpoint: urls.registration,
                revocation_endpoint: urls.revocation,
                scopes_supported: [OAUTH_SCOPE],
                response_types_supported: ['code'],
                response_modes_supported: ['query'],
                grant_types_supported: ['authorization_code', 'refresh_token'],
                token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
                revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
                code_challenge_methods_supported: ['S256'],
                authorization_response_iss_parameter_supported: true
            }),
            { contentType: 'application/json', headers: METADATA_HEADERS }
        );
    }

    @http.GET('/openid-configuration')
    openidConfiguration() {
        return notFoundResponse();
    }

    // Literal segments outrank parameters, so the documents above still win.
    @http.GET('/:a')
    unknown1() {
        return notFoundResponse();
    }

    @http.GET('/:a/:b')
    unknown2() {
        return notFoundResponse();
    }

    @http.GET('/:a/:b/:c')
    unknown3() {
        return notFoundResponse();
    }

    private protectedResource() {
        const urls = this.oauth.urls();
        if (!urls) return notFoundResponse();
        return rawResponse(
            JSON.stringify({
                resource: urls.resource,
                authorization_servers: [urls.issuer],
                scopes_supported: [OAUTH_SCOPE],
                bearer_methods_supported: ['header'],
                resource_name: 'PixelCI'
            }),
            { contentType: 'application/json', headers: METADATA_HEADERS }
        );
    }
}
