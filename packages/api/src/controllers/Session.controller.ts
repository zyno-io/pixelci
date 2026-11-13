import {
    http,
    HttpBadRequestError,
    HttpBody,
    HttpAccessDeniedError,
    HttpInternalServerError,
    HttpNotFoundError,
    HttpQueries,
    isUniqueConstraintError,
    UuidString
} from '@zyno-io/ts-server-foundation';
import { ScopedLogger, uuid } from '@zyno-io/ts-server-foundation';
import { createEntity, JWT } from '@zyno-io/ts-server-foundation';
import { createHash, timingSafeEqual } from 'crypto';

import { ApiController } from '../accessories/Controller.accessory';
import { AppConfig } from '../config';
import { Db } from '../database';
import { UserEntity } from '../entities/User.entity';
import { VcsIntegrationEntity } from '../entities/VcsIntegration.entity';
import { sealIntegrationConfig, sealVcsSession } from '../services/secrets/VcsSecrets';
import { createOAuthState, deriveStateKey, sanitizeReturnTo, verifyOAuthState } from '../services/OAuthState';
import { VcsService } from '../services/Vcs.service';
import { normalizeCreateConfig } from '../services/VcsConfig';
import { IVcsIntegrationCreateInput } from './VcsIntegrations.controller';

type ISessionResponse = Pick<UserEntity, 'id' | 'name' | 'isAdmin' | 'vcsId'>;

type ISessionProvider = Pick<VcsIntegrationEntity, 'id' | 'name' | 'platform'>;

interface ISessionLoginRequest {
    code: string;
    // Server-issued, signed state from the login-url endpoint; carries the provider and return path.
    state: string;
    // Only consulted when the very first admin is being created.
    setupToken?: string;
}

interface ISessionLoginResponse {
    jwt: string;
    returnTo: string;
}

interface ISessionLoginUrlResponse {
    url: string;
    state: string;
}

interface IOnboardingStatusResponse {
    isOnboarded: boolean;
    // True when SETUP_TOKEN is configured (>= 16 chars); first-run setup is impossible otherwise.
    setupEnabled: boolean;
    // The OAuth callback URL providers must have registered (`${PUBLIC_URL}/login`); absent when PUBLIC_URL is not configured.
    oauthRedirectUri?: string;
    // True once at least one admin user exists. While false (and setupEnabled), login accepts the setup token to claim admin.
    hasAdmin: boolean;
}

interface IOnboardingRequest {
    setupToken?: string;
    integration: IVcsIntegrationCreateInput;
}

const MIN_SETUP_TOKEN_LENGTH = 16;
const ONBOARDING_LOCK = 'pixelci:onboarding';

let warnedShortToken = false;

function sha256(value: string): Buffer {
    return createHash('sha256').update(value, 'utf8').digest();
}

@ApiController('/api/session')
export class SessionController {
    private readonly setupToken?: string;

    constructor(
        private vcsService: VcsService,
        private db: Db,
        private appConfig: AppConfig,
        logger: ScopedLogger
    ) {
        const configured = appConfig.SETUP_TOKEN;
        if (configured && configured.length < MIN_SETUP_TOKEN_LENGTH) {
            // The controller may be instantiated per request; warn once per process.
            if (!warnedShortToken) {
                warnedShortToken = true;
                logger.warn(`SETUP_TOKEN is shorter than ${MIN_SETUP_TOKEN_LENGTH} characters and is ignored; first-run setup is disabled`);
            }
        } else if (configured) {
            this.setupToken = configured;
        }
    }

    private isSetupTokenValid(provided: unknown): boolean {
        if (!this.setupToken || typeof provided !== 'string') return false;
        // Compare fixed-length digests so neither the length nor the content of the token leaks through timing.
        return timingSafeEqual(sha256(provided), sha256(this.setupToken));
    }

    @http.GET('me')
    async getIdentity(user: UserEntity): Promise<ISessionResponse> {
        return {
            id: user.id,
            name: user.name,
            isAdmin: user.isAdmin,
            vcsId: user.vcsId
        };
    }

    @http.GET('providers')
    async getProviders(): Promise<ISessionProvider[]> {
        // Unauthenticated endpoint: map explicitly. Responses are JSON.stringify'd as-is (not filtered by the
        // declared return type), so returning entities would leak `config` (OAuth client secrets).
        const integrations = await VcsIntegrationEntity.query().orderBy('name').find();
        return integrations.map(({ id, name, platform }) => ({
            id,
            name,
            platform
        }));
    }

    private getRedirectUri(): string {
        const publicUrl = this.appConfig.PUBLIC_URL?.trim();
        if (!publicUrl) throw new HttpInternalServerError('PUBLIC_URL is not configured');
        let parsed: URL;
        try {
            parsed = new URL(publicUrl);
        } catch {
            throw new HttpInternalServerError('PUBLIC_URL is not a valid URL');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new HttpInternalServerError('PUBLIC_URL must be an http(s) URL');
        return `${publicUrl.replace(/\/+$/, '')}/login`;
    }

    @http.GET('providers/:id/login-url')
    async getProviderLoginUrl(id: UuidString, query: HttpQueries<{ returnTo?: string }>): Promise<ISessionLoginUrlResponse> {
        const redirectUri = this.getRedirectUri();
        const provider = await VcsIntegrationEntity.query().filterField('id', id).findOneOrUndefined();
        if (!provider) throw new HttpNotFoundError('Unknown provider');
        const state = createOAuthState({ providerId: id, returnTo: sanitizeReturnTo(query.returnTo) }, deriveStateKey(this.appConfig));
        const url = await this.vcsService.getProviderLoginUrl(id, redirectUri, state);
        return { url, state };
    }

    @http.GET('onboarding-status')
    async getOnboardingStatus(): Promise<IOnboardingStatusResponse> {
        const count = await VcsIntegrationEntity.query().count();
        const adminCount = await UserEntity.query().filter({ isAdmin: true }).count();
        let oauthRedirectUri: string | undefined;
        try {
            oauthRedirectUri = this.getRedirectUri();
        } catch {
            // PUBLIC_URL missing or invalid: the UI falls back to its own origin
        }
        return { isOnboarded: count > 0, setupEnabled: !!this.setupToken, hasAdmin: adminCount > 0, oauthRedirectUri };
    }

    @http.POST('onboarding/vcs-integration')
    async createOnboardingVcsIntegration(body: HttpBody<IOnboardingRequest>): Promise<Pick<VcsIntegrationEntity, 'id' | 'name' | 'platform'>> {
        // Once onboarded, answer 403 whether or not the token is right so a guessed token can't be confirmed.
        // The count always runs, so response timing doesn't reveal whether the token was correct either.
        const onboarded = (await VcsIntegrationEntity.query().count()) > 0;
        if (!this.isSetupTokenValid(body.setupToken) || onboarded) {
            throw new HttpAccessDeniedError('Invalid or missing setup token');
        }
        const input = body.integration;
        const { platform, config } = normalizeCreateConfig(input);

        const integration = await this.db.transaction(async txn => {
            // Serialize concurrent onboarding requests so the count-then-insert check cannot be raced.
            await txn.acquireSessionLock([ONBOARDING_LOCK]);
            const existingCount = await txn.query(VcsIntegrationEntity).count();
            if (existingCount > 0) {
                return undefined; // lost a race with a concurrent request that passed the token check
            }
            const created = createEntity(VcsIntegrationEntity, {
                id: uuid(),
                name: input.name,
                platform,
                config: sealIntegrationConfig(config)
            });
            txn.add(created);
            await txn.flush();
            return created;
        });
        if (!integration) {
            throw new HttpBadRequestError('Onboarding has already been completed');
        }

        return {
            id: integration.id,
            name: integration.name,
            platform: integration.platform
        };
    }

    @http.POST('login')
    async login(body: HttpBody<ISessionLoginRequest>): Promise<ISessionLoginResponse> {
        const redirectUri = this.getRedirectUri();
        const verified = verifyOAuthState(body.state, deriveStateKey(this.appConfig));
        if (!verified) throw new HttpBadRequestError('Sign-in expired or could not be verified; please try again');
        const providerId = verified.providerId;
        const session = await this.vcsService.exchangeProviderCode(providerId, redirectUri, body.code);

        const { name, id, ...sessionDetails } = session;

        const findUser = () => UserEntity.query().filter({ vcsId: providerId, vcsUserId: id }).findOneOrUndefined();
        let user = await findUser();
        let writtenUnderLock = false;

        // Only new users, and non-admins presenting a valid setup token (who may be claiming the first admin role), need the lock.
        // The unlocked admin pre-check keeps correct-token and wrong-token logins on the same fast path once an admin exists
        // (no timing signal); the locked re-check below stays authoritative.
        if (
            !user ||
            (!user.isAdmin && (await UserEntity.query().filter({ isAdmin: true }).count()) === 0 && this.isSetupTokenValid(body.setupToken))
        ) {
            // Serialize with onboarding and other first logins so two racing logins can neither both become admin nor both insert.
            // The lookup is repeated under the lock: the users index is not unique yet, so the unlocked lookup above can be stale.
            user = await this.db
                .transaction(async txn => {
                    await txn.acquireSessionLock([ONBOARDING_LOCK]);
                    const adminCount = await txn.query(UserEntity).filter({ isAdmin: true }).count();
                    const claimAdmin = adminCount === 0 && this.isSetupTokenValid(body.setupToken);
                    let locked = await txn.query(UserEntity).filter({ vcsId: providerId, vcsUserId: id }).findOneOrUndefined();
                    if (!locked) {
                        locked = createEntity(UserEntity, {
                            id: uuid(),
                            vcsId: providerId,
                            vcsUserId: id,
                            createdAt: new Date(),
                            isAdmin: false
                        });
                        txn.add(locked);
                    }
                    if (claimAdmin) locked.isAdmin = true;
                    locked.name = name;
                    locked.lastLoginAt = new Date();
                    locked.vcsSession = sealVcsSession(sessionDetails);
                    await txn.flush();
                    writtenUnderLock = true;
                    return locked;
                })
                .catch(async err => {
                    // Second line of defence once the unique index exists: a concurrent insert won, so use its row.
                    if (isUniqueConstraintError(err)) return findUser();
                    throw err;
                });
        }
        if (!user) throw new HttpBadRequestError('Login failed');
        if (!writtenUnderLock) {
            // Rows not written under the lock (the common existing-user path, or the unique-error re-select): refresh the profile.
            user.name = name;
            user.lastLoginAt = new Date();
            user.vcsSession = sealVcsSession(sessionDetails);
            await user.save();
        }

        const jwt = await JWT.generate({ subject: user.id });
        return { jwt, returnTo: verified.returnTo };
    }
}
