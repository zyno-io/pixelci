import { http, HttpBadRequestError, HttpBody, HttpQueries, UuidString } from '@zyno-io/ts-server-foundation';
import { uuid } from '@zyno-io/ts-server-foundation';
import { createEntity, JWT } from '@zyno-io/ts-server-foundation';

import { ApiController } from '../accessories/Controller.accessory';
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
}

interface ISessionLoginResponse {
    jwt: string;
}

interface IOnboardingStatusResponse {
    isOnboarded: boolean;
}

@ApiController('/api/session')
export class SessionController {
    constructor(private vcsService: VcsService) {}

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
        return integrations.map(({ id, name, platform }) => ({ id, name, platform }));
    }

    @http.GET('providers/:id/login-url')
    async getProviderLoginUrl(id: UuidString, query: HttpQueries<{ redirectUri: string; state?: string }>): Promise<{ url: string }> {
        const url = await this.vcsService.getProviderLoginUrl(id, query.redirectUri, query.state);
        return { url };
    }

    @http.GET('onboarding-status')
    async getOnboardingStatus(): Promise<IOnboardingStatusResponse> {
        const count = await VcsIntegrationEntity.query().count();
        return { isOnboarded: count > 0 };
    }

    @http.POST('onboarding/vcs-integration')
    async createOnboardingVcsIntegration(
        body: HttpBody<IVcsIntegrationCreateInput>
    ): Promise<Pick<VcsIntegrationEntity, 'id' | 'name' | 'platform'>> {
        const existingCount = await VcsIntegrationEntity.query().count();
        if (existingCount > 0) {
            throw new HttpBadRequestError('Onboarding has already been completed');
        }
        const { platform, config } = normalizeCreateConfig(body);

        const integration = createEntity(VcsIntegrationEntity, {
            id: uuid(),
            name: body.name,
            platform,
            config
        });
        await integration.save();

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

        let user = await UserEntity.query()
            .filter({
                vcsId: body.providerId,
                vcsUserId: id
            })
            .findOneOrUndefined();

        const isNewUser = !user;

        if (!user) {
            user = createEntity(UserEntity, {
                id: uuid(),
                vcsId: body.providerId,
                vcsUserId: session.id,
                createdAt: new Date()
            });
        }

        if (isNewUser) {
            const userCount = await UserEntity.query().count();
            if (userCount === 0) {
                user.isAdmin = true;
            }
        }

        user.name = name;
        user.lastLoginAt = new Date();
        user.vcsSession = sessionDetails;
        await user.save();

        const jwt = await JWT.generate({ subject: user.id });
        return { jwt };
    }
}
