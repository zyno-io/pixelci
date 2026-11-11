import {
    http,
    HttpBadRequestError,
    HttpBody,
    HttpAccessDeniedError,
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
import { VcsService } from '../services/Vcs.service';
import { normalizeCreateConfig } from '../services/VcsConfig';
import { IVcsIntegrationCreateInput } from './VcsIntegrations.controller';

type ISessionResponse = Pick<UserEntity, 'id' | 'name' | 'isAdmin' | 'vcsId'>;

type ISessionProvider = Pick<VcsIntegrationEntity, 'id' | 'name' | 'platform'>;

interface ISessionLoginRequest {
    providerId: UuidString;
    redirectUri: string;
    code: string;
    // Only consulted when the very first admin is being created.
    setupToken?: string;
}

interface ISessionLoginResponse {
    jwt: string;
}

interface IOnboardingStatusResponse {
    isOnboarded: boolean;
    // True when SETUP_TOKEN is configured (>= 16 chars); first-run setup is impossible otherwise.
    setupEnabled: boolean;
}

interface IOnboardingRequest {
    setupToken?: string;
    integration: IVcsIntegrationCreateInput;
}

const MIN_SETUP_TOKEN_LENGTH = 16;
const ONBOARDING_LOCK = 'pixelci:onboarding';

function sha256(value: string): Buffer {
    return createHash('sha256').update(value, 'utf8').digest();
}

@ApiController('/api/session')
export class SessionController {
    private readonly setupToken?: string;

    constructor(
        private vcsService: VcsService,
        private db: Db,
        appConfig: AppConfig,
        logger: ScopedLogger
    ) {
        const configured = appConfig.SETUP_TOKEN;
        if (configured && configured.length < MIN_SETUP_TOKEN_LENGTH) {
            logger.warn(`SETUP_TOKEN is shorter than ${MIN_SETUP_TOKEN_LENGTH} characters and is ignored; first-run setup is disabled`);
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

    @http.GET('providers/:id/login-url')
    async getProviderLoginUrl(id: UuidString, query: HttpQueries<{ redirectUri: string; state?: string }>): Promise<{ url: string }> {
        const url = await this.vcsService.getProviderLoginUrl(id, query.redirectUri, query.state);
        return { url };
    }

    @http.GET('onboarding-status')
    async getOnboardingStatus(): Promise<IOnboardingStatusResponse> {
        const count = await VcsIntegrationEntity.query().count();
        return { isOnboarded: count > 0, setupEnabled: !!this.setupToken };
    }

    @http.POST('onboarding/vcs-integration')
    async createOnboardingVcsIntegration(body: HttpBody<IOnboardingRequest>): Promise<Pick<VcsIntegrationEntity, 'id' | 'name' | 'platform'>> {
        if (!this.isSetupTokenValid(body.setupToken)) {
            throw new HttpAccessDeniedError('Invalid or missing setup token');
        }
        const input = body.integration;
        const { platform, config } = normalizeCreateConfig(input);

        const integration = await this.db.transaction(async txn => {
            // Serialize concurrent onboarding requests so the count-then-insert check cannot be raced.
            await txn.acquireSessionLock([ONBOARDING_LOCK]);
            const existingCount = await txn.query(VcsIntegrationEntity).count();
            if (existingCount > 0) {
                return undefined;
            }
            const created = createEntity(VcsIntegrationEntity, {
                id: uuid(),
                name: input.name,
                platform,
                config
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
        const session = await this.vcsService.exchangeProviderCode(body.providerId, body.redirectUri, body.code);

        const { name, id, ...sessionDetails } = session;

        const findUser = () => UserEntity.query().filter({ vcsId: body.providerId, vcsUserId: id }).findOneOrUndefined();
        let user = await findUser();
        let createdInTxn = false;

        if (!user) {
            // The first admin needs both "no admin exists yet" and the setup token. Serialize with onboarding and
            // other first logins so two racing logins cannot both become admin.
            user = await this.db
                .transaction(async txn => {
                    await txn.acquireSessionLock([ONBOARDING_LOCK]);
                    const adminCount = await txn.query(UserEntity).filter({ isAdmin: true }).count();
                    const created = createEntity(UserEntity, {
                        id: uuid(),
                        vcsId: body.providerId,
                        vcsUserId: id,
                        createdAt: new Date(),
                        isAdmin: adminCount === 0 && this.isSetupTokenValid(body.setupToken)
                    });
                    created.name = name;
                    created.lastLoginAt = new Date();
                    created.vcsSession = sessionDetails;
                    txn.add(created);
                    await txn.flush();
                    createdInTxn = true;
                    return created;
                })
                .catch(async err => {
                    // Lost a race with a concurrent login for the same account: use the row that won.
                    if (isUniqueConstraintError(err)) return findUser();
                    throw err;
                });
        }

        if (!createdInTxn) {
            // Existing account (or lost the insert race): refresh its profile and session.
            user!.name = name;
            user!.lastLoginAt = new Date();
            user!.vcsSession = sessionDetails;
            await user!.save();
        }

        const jwt = await JWT.generate({ subject: user!.id });
        return { jwt };
    }
}
