import {
    createEntity,
    EntityFields,
    http,
    HttpBadRequestError,
    HttpBody,
    HttpNotFoundError,
    HttpQueries,
    uuid,
    UuidString
} from '@zyno-io/ts-server-foundation';

import { AdminAuthMiddleware, UserAuthMiddleware } from '../accessories/AuthMiddleware.accessory';
import { ApiController } from '../accessories/Controller.accessory';
import { AppEntity } from '../entities/App.entity';
import { BranchEntity } from '../entities/Branch.entity';
import { BuildEntity } from '../entities/Build.entity';
import { UserEntity } from '../entities/User.entity';
import { VcsIntegrationEntity } from '../entities/VcsIntegration.entity';
import { AppAccessService } from '../services/AppAccess.service';
import { IVcsProject, VcsService } from '../services/Vcs.service';

export type IAppIndexResponse = Partial<Pick<AppEntity, 'id' | 'defaultBranchId' | 'name'> & { buildCount: number }>;
export type IAppShowResponse = EntityFields<AppEntity> & { commitUrlBase: string | null };

interface IAppCreateInput {
    name: string;
    vcsId: UuidString;
    projectPath: string;
    vcsProjectId?: number;
    defaultBranchName?: string;
}

export type IAppUpdateInput = Partial<Pick<AppEntity, 'name' | 'defaultBranchId'>>;

@ApiController('/api/apps')
@http.middleware(UserAuthMiddleware)
export class AppsController {
    constructor(
        private vcsService: VcsService,
        private appAccessSvc: AppAccessService
    ) {}

    @http.GET()
    async index(user: UserEntity): Promise<IAppIndexResponse[]> {
        const apps = await AppEntity.query().filter({ deletedAt: null }).find();
        const accessibleApps = await this.appAccessSvc.filterAccessible({ kind: 'user', user }, apps);

        const appsWithBuildCount: IAppIndexResponse[] = await Promise.all(
            accessibleApps.map(async app => {
                const count = await BuildEntity.query().filter({ appId: app.id }).count();

                return {
                    ...app,
                    id: app.id,
                    buildCount: count
                };
            })
        );

        return appsWithBuildCount;
    }

    @http.GET('/:id')
    async show(id: UuidString, user: UserEntity): Promise<IAppShowResponse> {
        const app = await AppEntity.query().filter({ id, deletedAt: null }).findOneOrUndefined();
        if (!app) throw new HttpNotFoundError();
        await this.appAccessSvc.assertCanAccess({ kind: 'user', user }, app);

        const vcs = await VcsIntegrationEntity.query().filterField('id', app.vcsId).findOneOrUndefined();
        const commitUrlBase = vcs ? this.vcsService.getCommitUrlBase(vcs, app.projectPath) : null;

        return { ...app, commitUrlBase };
    }

    @http.POST()
    @http.middleware(AdminAuthMiddleware)
    async create(body: HttpBody<IAppCreateInput>): Promise<IAppIndexResponse> {
        const integration = await VcsIntegrationEntity.query().filterField('id', body.vcsId).findOneOrUndefined();
        if (!integration) throw new HttpBadRequestError('Unknown vcsId');
        if (!(Number.isSafeInteger(body.vcsProjectId) && body.vcsProjectId! > 0)) {
            throw new HttpBadRequestError('vcsProjectId (the VCS project or repository id) is required');
        }

        const appId = uuid();

        let defaultBranchId: string | undefined;
        if (body.defaultBranchName) {
            const branch = createEntity(BranchEntity, {
                id: uuid(),
                appId,
                name: body.defaultBranchName
            });
            await branch.save();
            defaultBranchId = branch.id;
        }

        const newApp = createEntity(AppEntity, {
            id: appId,
            name: body.name,
            vcsId: body.vcsId,
            projectPath: body.projectPath,
            vcsProjectId: body.vcsProjectId ?? null,
            defaultBranchId: defaultBranchId ?? null
        });
        await newApp.save();

        return newApp;
    }

    @http.PUT('/:id')
    @http.middleware(AdminAuthMiddleware)
    async update(id: UuidString, body: HttpBody<IAppUpdateInput>): Promise<IAppIndexResponse> {
        const app = await AppEntity.query().filter({ id }).findOneOrUndefined();
        if (!app) throw new HttpNotFoundError();

        if (body.defaultBranchId) {
            const branch = await BranchEntity.query().filter({ appId: id, id: body.defaultBranchId }).findOneOrUndefined();
            if (!branch) throw new HttpBadRequestError('invalid defaultBranchId');
        }

        Object.assign(app, body);
        await app.save();

        return app;
    }

    @http.DELETE('/:id')
    @http.middleware(AdminAuthMiddleware)
    async delete(id: UuidString): Promise<void> {
        const app = await AppEntity.query().filter({ id, deletedAt: null }).findOneOrUndefined();
        if (!app) throw new HttpNotFoundError();

        app.deletedAt = new Date();
        await app.save();
    }

    @http.GET('vcs-projects/search')
    @http.middleware(AdminAuthMiddleware)
    async searchVcsProjects(query: HttpQueries<{ vcsId: UuidString; search: string }>, user: UserEntity): Promise<IVcsProject[]> {
        return this.vcsService.searchProjects(user, query.vcsId, query.search);
    }

    @http.GET('vcs-projects/resolve')
    @http.middleware(AdminAuthMiddleware)
    async resolveVcsProject(query: HttpQueries<{ vcsId: UuidString; url: string }>, user: UserEntity): Promise<IVcsProject> {
        return this.vcsService.resolveProjectUrl(user, query.vcsId, query.url);
    }
}
