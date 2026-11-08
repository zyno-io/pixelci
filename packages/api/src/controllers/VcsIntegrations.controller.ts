import { http, HttpBadRequestError, HttpBody, HttpNotFoundError } from '@zyno-io/ts-server-foundation';
import { uuid } from '@zyno-io/ts-server-foundation';
import { createEntity } from '@zyno-io/ts-server-foundation';

import { AdminAuthMiddleware } from '../accessories/AuthMiddleware.accessory';
import { ApiController } from '../accessories/Controller.accessory';
import { AppEntity } from '../entities/App.entity';
import { IGitLabConfig, VcsIntegrationEntity } from '../entities/VcsIntegration.entity';
import { mergeConfigUpdate, normalizeCreateConfig, redactConfig } from '../services/VcsConfig';

type IVcsIntegrationListResponse = Pick<VcsIntegrationEntity, 'id' | 'name' | 'platform'>;

export interface IGitHubConfigInput {
    url?: string;
    clientId: string;
    clientSecret: string;
    appId: string;
    privateKey: string;
    oidcAudience: string;
    oidcIssuer?: string;
}
export interface IGitLabIntegrationInput {
    name: string;
    platform: 'gitlab';
    config: IGitLabConfig;
}
export interface IGitHubIntegrationInput {
    name: string;
    platform: 'github';
    config: IGitHubConfigInput;
}
export type IVcsIntegrationCreateInput = IGitLabIntegrationInput | IGitHubIntegrationInput;

export interface IGitLabIntegrationUpdateInput {
    name?: string;
    platform?: 'gitlab';
    config?: { url?: string; clientId?: string; clientSecret?: string };
}
export interface IGitHubIntegrationUpdateInput {
    name?: string;
    platform: 'github';
    config?: Partial<IGitHubConfigInput>;
}
export type IVcsIntegrationUpdateInput = IGitHubIntegrationUpdateInput | IGitLabIntegrationUpdateInput;

export interface IGitLabIntegrationDetail {
    id: string;
    name: string;
    platform: 'gitlab';
    config: { url: string; clientId: string };
}
export interface IGitHubIntegrationDetail {
    id: string;
    name: string;
    platform: 'github';
    config: { url?: string; clientId: string; appId?: string; oidcAudience: string; hasPrivateKey: boolean };
}
export type IVcsIntegrationDetailResponse = IGitLabIntegrationDetail | IGitHubIntegrationDetail;

@ApiController('/api/admin/vcs-integrations')
@http.middleware(AdminAuthMiddleware)
export class VcsIntegrationsController {
    constructor() {}

    @http.GET()
    async index(): Promise<IVcsIntegrationListResponse[]> {
        const integrations = await VcsIntegrationEntity.query().orderBy('name').find();
        return integrations.map(i => ({
            id: i.id,
            name: i.name,
            platform: i.platform
        }));
    }

    @http.GET('/:id')
    async show(id: string): Promise<IVcsIntegrationDetailResponse> {
        const integration = await VcsIntegrationEntity.query().filter({ id }).findOneOrUndefined();
        if (!integration) throw new HttpNotFoundError();

        return redactConfig(integration.platform, integration.id, integration.name, integration.config);
    }

    @http.POST()
    async create(body: HttpBody<IVcsIntegrationCreateInput>): Promise<IVcsIntegrationListResponse> {
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

    @http.PUT('/:id')
    async update(id: string, body: HttpBody<IVcsIntegrationUpdateInput>): Promise<IVcsIntegrationListResponse> {
        const integration = await VcsIntegrationEntity.query().filter({ id }).findOneOrUndefined();
        if (!integration) throw new HttpNotFoundError();

        if (body.name !== undefined) integration.name = body.name;
        if (body.config !== undefined) {
            // A body without `platform` is treated as GitLab (keeps pre-GitHub clients working).
            const bodyPlatform = body.platform ?? 'gitlab';
            if (bodyPlatform !== integration.platform) {
                throw new HttpBadRequestError(`Cannot apply ${bodyPlatform} config to a ${integration.platform} integration`);
            }
            integration.config = mergeConfigUpdate(integration.platform, integration.config, body.config);
        }
        await integration.save();

        return {
            id: integration.id,
            name: integration.name,
            platform: integration.platform
        };
    }

    @http.DELETE('/:id')
    async delete(id: string): Promise<void> {
        const integration = await VcsIntegrationEntity.query().filter({ id }).findOneOrUndefined();
        if (!integration) throw new HttpNotFoundError();

        const appCount = await AppEntity.query().filter({ vcsId: id }).count();
        if (appCount > 0) {
            throw new HttpBadRequestError('Cannot delete integration that is referenced by apps');
        }

        await VcsIntegrationEntity.query().filter({ id }).deleteMany();
    }
}
