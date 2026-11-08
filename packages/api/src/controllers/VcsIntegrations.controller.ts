import { http, HttpBadRequestError, HttpBody, HttpNotFoundError } from '@zyno-io/ts-server-foundation';
import { uuid } from '@zyno-io/ts-server-foundation';
import { createEntity } from '@zyno-io/ts-server-foundation';

import { AdminAuthMiddleware } from '../accessories/AuthMiddleware.accessory';
import { ApiController } from '../accessories/Controller.accessory';
import { AppEntity } from '../entities/App.entity';
import { IGitLabConfig, VcsIntegrationEntity } from '../entities/VcsIntegration.entity';

type IVcsIntegrationListResponse = Pick<VcsIntegrationEntity, 'id' | 'name' | 'platform'>;
type IVcsIntegrationDetailResponse = Pick<VcsIntegrationEntity, 'id' | 'name' | 'platform' | 'config'>;

interface IVcsIntegrationCreateInput {
    name: string;
    platform: 'gitlab' | 'github';
    config: IGitLabConfig;
}

interface IVcsIntegrationUpdateInput {
    name?: string;
    config?: IGitLabConfig;
}

/**
 * GitHub integrations can't be configured via the API yet: the input config is typed as IGitLabConfig, so
 * GitHub-only fields (oidcAudience, oidcIssuer) would be stripped. Lifted in slice 2 (see design/github-actions.md).
 */
export function assertPlatformConfigurable(platform: VcsIntegrationEntity['platform']): void {
    if (platform !== 'gitlab') {
        throw new HttpBadRequestError(`Configuring ${platform} integrations is not supported yet`);
    }
}

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

        return {
            id: integration.id,
            name: integration.name,
            platform: integration.platform,
            config: integration.config
        };
    }

    @http.POST()
    async create(body: HttpBody<IVcsIntegrationCreateInput>): Promise<IVcsIntegrationListResponse> {
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

    @http.PUT('/:id')
    async update(id: string, body: HttpBody<IVcsIntegrationUpdateInput>): Promise<IVcsIntegrationListResponse> {
        const integration = await VcsIntegrationEntity.query().filter({ id }).findOneOrUndefined();
        if (!integration) throw new HttpNotFoundError();

        if (body.name !== undefined) integration.name = body.name;
        if (body.config !== undefined) {
            // config is replaced wholesale and typed as IGitLabConfig; for GitHub that would drop oidcAudience.
            assertPlatformConfigurable(integration.platform);
            integration.config = body.config;
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
