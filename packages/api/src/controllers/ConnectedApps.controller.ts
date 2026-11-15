import {
    EmptyResponse,
    http,
    HttpBody,
    HttpError,
    HttpNotFoundError,
    HttpQueries,
    HttpRequest,
    HttpUnauthorizedError
} from '@zyno-io/ts-server-foundation';

import { ApiController } from '../accessories/Controller.accessory';
import { AppConfig } from '../config';
import { UserEntity } from '../entities/User.entity';
import { OAUTH_SCOPE, OAUTH_SCOPE_DESCRIPTION } from '../services/oauth/OAuthConstants';
import { DecisionResult, OAuthServerService } from '../services/oauth/OAuthServer.service';
import { IOAuthUrls } from '../services/oauth/OAuthUrls';
import { describeRedirectUri } from '../services/oauth/RedirectUris';
import { VcsService } from '../services/Vcs.service';

interface IConnectedAppScope {
    name: string;
    description: string;
}

interface IConnectedAppRequest {
    id: string;
    clientName: string;
    redirectUri: string;
    redirectDisplay: string;
    redirectKind: 'web' | 'loopback';
    scopes: IConnectedAppScope[];
    expiresAt: Date;
}

interface IConnectedAppDecision {
    redirectUrl: string;
}

interface IConnectedApp {
    id: string;
    clientName: string;
    redirectDisplay: string;
    createdAt: Date;
    lastUsedAt: Date | null;
}

const SIGN_IN_EXPIRED = 'Your sign-in has expired; sign in again';

export type IConnectedAppRequestRef = { request: string };

/**
 * The SPA-facing side of OAuth: the consent screen's data and decisions, and the signed-in user's list of connected apps. Authenticated
 * with the user's session JWT (a bearer header; PixelCI sets no auth cookie, so a cross-site request can't act as the user).
 */
@ApiController('/api/connected-apps')
export class ConnectedAppsController {
    constructor(
        private oauth: OAuthServerService,
        private vcsService: VcsService,
        private appConfig: AppConfig
    ) {}

    // The request id is a bearer capability for the pending authorization, so it travels in the `request` query key (redacted from
    // request logs and traces) or the body, never in the path.
    @http.GET('/requests')
    async getRequest(query: HttpQueries<{ request: string }>, user: UserEntity): Promise<IConnectedAppRequest> {
        const id = query.request;
        this.urls();
        await this.assertVcsSession(user);
        const pending = await this.oauth.getPendingRequest(id);
        if (pending.status === 'not_found') throw new HttpNotFoundError();
        if (pending.status === 'gone') throw new HttpError(410, 'This request has expired or was already used.');
        const { authorization, client } = pending;
        // Deliberately not bound to a user yet: a user who opened the link in the wrong account can switch account and come back.
        return {
            id: authorization.id,
            clientName: client.name,
            redirectUri: authorization.redirectUri,
            ...describeRedirectUri(authorization.redirectUri),
            scopes: [{ name: OAUTH_SCOPE, description: OAUTH_SCOPE_DESCRIPTION }],
            expiresAt: authorization.expiresAt
        };
    }

    @http.POST('/requests/approve')
    async approve(body: HttpBody<IConnectedAppRequestRef>, request: HttpRequest, user: UserEntity): Promise<IConnectedAppDecision> {
        const id = body.request;
        const urls = this.urls();
        this.requireAuthorizationHeader(request);
        await this.assertVcsSession(user);
        return this.decision(await this.oauth.approve(id, user.id, urls));
    }

    @http.POST('/requests/deny')
    async deny(body: HttpBody<IConnectedAppRequestRef>, request: HttpRequest, user: UserEntity): Promise<IConnectedAppDecision> {
        const id = body.request;
        const urls = this.urls();
        this.requireAuthorizationHeader(request);
        return this.decision(await this.oauth.deny(id, user.id, urls));
    }

    @http.GET('/')
    async index(user: UserEntity): Promise<IConnectedApp[]> {
        this.urls();
        const rows = await this.oauth.listGrantsForUser(user.id);
        return rows.map(row => ({
            id: row.id,
            clientName: row.clientName,
            redirectDisplay: describeRedirectUri(row.redirectUri).redirectDisplay,
            createdAt: row.createdAt,
            lastUsedAt: row.lastUsedAt
        }));
    }

    @http.DELETE('/:id')
    async revoke(id: string, user: UserEntity): EmptyResponse {
        this.urls();
        if (!(await this.oauth.revokeGrantForUser(user.id, id))) throw new HttpNotFoundError();
    }

    private urls(): IOAuthUrls {
        const urls = this.oauth.urls();
        if (!urls) throw new HttpNotFoundError();
        return urls;
    }

    /** The session is not strictly the browser's own: a dead VCS sign-in would only yield a connection that cannot read anything. */
    private async assertVcsSession(user: UserEntity): Promise<void> {
        if (!this.appConfig.ENFORCE_VCS_PROJECT_ACCESS) return;
        if ((await this.vcsService.checkUserSession(user)) === 'reauth') throw new HttpUnauthorizedError(SIGN_IN_EXPIRED);
    }

    /** Approve and deny must come from the SPA's explicit bearer header, never from an ambient credential such as a cookie. */
    private requireAuthorizationHeader(request: HttpRequest): void {
        if (!/^Bearer\s+\S/i.test(String(request.headers.authorization ?? ''))) throw new HttpUnauthorizedError();
    }

    private decision(result: DecisionResult): IConnectedAppDecision {
        if (result.status === 'not_found') throw new HttpNotFoundError();
        if (result.status === 'gone') throw new HttpError(410, 'This request has expired or was already used.');
        return { redirectUrl: result.redirectUrl };
    }
}
