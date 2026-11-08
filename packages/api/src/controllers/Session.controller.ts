import { http, HttpBadRequestError, HttpBody, HttpQueries } from '@zyno-io/ts-server-foundation';
import { uuid } from '@zyno-io/ts-server-foundation';
import { createEntity, JWT } from '@zyno-io/ts-server-foundation';

import { ApiController } from '../accessories/Controller.accessory';
import { UserEntity } from '../entities/User.entity';
import { IGitLabConfig, VcsIntegrationEntity } from '../entities/VcsIntegration.entity';
import { VcsService } from '../services/Vcs.service';
import { assertPlatformConfigurable } from './VcsIntegrations.controller';

type ISessionResponse = Pick<UserEntity, 'id' | 'name' | 'isAdmin'>;

type ISessionProvider = Pick<VcsIntegrationEntity, 'id' | 'name'>;

interface ISessionLoginRequest {
    providerId: string;
    redirectUri: string;
    code: string;
}

interface ISessionLoginResponse {
    jwt: string;
}

interface IOnboardingStatusResponse {
    isOnboarded: boolean;
}

interface IOnboardingVcsIntegrationInput {
    name: string;
    platform: 'gitlab' | 'github';
    config: IGitLabConfig;
}

@ApiController('/api/session')
export class SessionController {
    constructor(private vcsService: VcsService) {}

    @http.GET('me')
    async getIdentity(user: UserEntity): Promise<ISessionResponse> {
        return {
            id: user.id,
            name: user.name,
            isAdmin: user.isAdmin
        };
    }

    @http.GET('providers')
    async getProviders(): Promise<ISessionProvider[]> {
        // Unauthenticated endpoint: map explicitly. Responses are JSON.stringify'd as-is (not filtered by the
        // declared return type), so returning entities would leak `config` (OAuth client secrets).
        const integrations = await VcsIntegrationEntity.query().orderBy('name').find();
        return integrations.map(({ id, name }) => ({ id, name }));
    }

    @http.GET('providers/:id/login-url')
    async getProviderLoginUrl(id: string, query: HttpQueries<{ redirectUri: string; state?: string }>): Promise<{ url: string }> {
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
        body: HttpBody<IOnboardingVcsIntegrationInput>
    ): Promise<Pick<VcsIntegrationEntity, 'id' | 'name' | 'platform'>> {
        const existingCount = await VcsIntegrationEntity.query().count();
        if (existingCount > 0) {
            throw new HttpBadRequestError('Onboarding has already been completed');
        }
        assertPlatformConfigurable(body.platform);

        const integration = createEntity(VcsIntegrationEntity, {
            id: uuid(),
            name: body.name,
            platform: body.platform,
            config: body.config
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
