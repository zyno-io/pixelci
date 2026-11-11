import { http, HttpBody, HttpNotFoundError, UuidString } from '@zyno-io/ts-server-foundation';
import { keyBy } from 'lodash';

import { UserAuthMiddleware } from '../accessories/AuthMiddleware.accessory';
import { ApiController } from '../accessories/Controller.accessory';
import { AppEntity } from '../entities/App.entity';
import { BranchEntity } from '../entities/Branch.entity';
import { BuildEntity } from '../entities/Build.entity';
import { BuildScreenEntity } from '../entities/BuildScreen.entity';
import { ScreenEntity } from '../entities/Screen.entity';
import { UserEntity } from '../entities/User.entity';
import { AppAccessService } from '../services/AppAccess.service';
import { IToleranceOverrides, validateToleranceOverrides } from '../services/Tolerance';
import { IBuildResponse, toBuildResponse } from '../responses/build.response';

export type IAppGalleryScreen = {
    screenId: string;
    name: string;
    tolerances: IToleranceOverrides;
    image: { buildId: string; sourceBuildId: string; isBaseline: boolean };
};
export type IAppGalleryResponse = { baselineBuild: IBuildResponse | null; screens: IAppGalleryScreen[] };

const overridesOf = (screen: ScreenEntity): IToleranceOverrides => ({
    colorTolerance: screen.colorTolerance ?? null,
    shiftTolerance: screen.shiftTolerance ?? null,
    diffPctTolerance: screen.diffPctTolerance ?? null
});

@ApiController('/api/apps/:appId/screens')
@http.middleware(UserAuthMiddleware)
export class ScreensController {
    constructor(private appAccessSvc: AppAccessService) {}

    @http.GET()
    async index(appId: UuidString, user: UserEntity): Promise<IAppGalleryResponse> {
        await this.appAccessSvc.assertCanAccessAppId({ kind: 'user', user }, appId);

        const app = await AppEntity.query().filter({ id: appId }).findOneOrUndefined();
        if (!app) throw new HttpNotFoundError();

        const baselineBuild = app.defaultBranchId
            ? await BuildEntity.query()
                  .filter({ appId, branchId: app.defaultBranchId, status: 'changes approved' })
                  .orderBy('id', 'desc')
                  .findOneOrUndefined()
            : undefined;

        // screenId -> chosen build screen
        const chosen = new Map<string, { buildScreen: BuildScreenEntity; isBaseline: boolean }>();

        if (baselineBuild) {
            const baselineScreens = await BuildScreenEntity.query().filter({ appId, buildId: baselineBuild.id, isRemoved: false }).find();
            for (const buildScreen of baselineScreens) chosen.set(buildScreen.screenId, { buildScreen, isBaseline: true });
        }

        // Screens not in the baseline: their most recent build screen from a build that got as far as
        // being processed. Baseline screens are excluded in SQL, and rows are read newest-first in
        // pages, stopping once every remaining screen has been placed, so a busy app doesn't load
        // every build screen uploaded since the baseline.
        const baselineScreenIds = [...chosen.keys()];
        const remaining = new Set(
            (
                await ScreenEntity.query()
                    .filter({ appId, ...(baselineScreenIds.length && { id: { $nin: baselineScreenIds } }) })
                    .select('id')
                    .find()
            ).map(screen => screen.id)
        );
        const newer = new Map<string, BuildScreenEntity>();
        const buildIsValid = new Map<string, boolean>();
        const PAGE_SIZE = 500;
        let beforeId: string | undefined;

        while (remaining.size) {
            const page = await BuildScreenEntity.query()
                .filter({
                    appId,
                    screenId: { $in: [...remaining] },
                    isRemoved: false,
                    ...((baselineBuild || beforeId) && {
                        id: { ...(baselineBuild && { $gt: baselineBuild.id }), ...(beforeId && { $lt: beforeId }) }
                    })
                })
                .orderBy('id', 'desc')
                .limit(PAGE_SIZE)
                .find();
            if (!page.length) break;
            beforeId = page[page.length - 1].id;

            const unknownBuildIds = [...new Set(page.map(bs => bs.buildId))].filter(id => !buildIsValid.has(id));
            if (unknownBuildIds.length) {
                const builds = await BuildEntity.query()
                    .filter({ id: { $in: unknownBuildIds } })
                    .select('id', 'status')
                    .find();
                for (const id of unknownBuildIds) buildIsValid.set(id, false);
                for (const b of builds) buildIsValid.set(b.id, !['draft', 'canceled', 'failed'].includes(b.status));
            }

            for (const buildScreen of page) {
                if (!remaining.has(buildScreen.screenId) || !buildIsValid.get(buildScreen.buildId)) continue;
                newer.set(buildScreen.screenId, buildScreen);
                remaining.delete(buildScreen.screenId);
            }
            if (page.length < PAGE_SIZE) break;
        }
        for (const [screenId, buildScreen] of newer) chosen.set(screenId, { buildScreen, isBaseline: false });

        const screenEntities = chosen.size
            ? await ScreenEntity.query()
                  .filter({ appId, id: { $in: [...chosen.keys()] } })
                  .find()
            : [];
        const screensById = keyBy(screenEntities, 'id');

        const screens: IAppGalleryScreen[] = [...chosen.entries()]
            .filter(([screenId]) => screensById[screenId])
            .map(([screenId, { buildScreen, isBaseline }]) => ({
                screenId,
                name: screensById[screenId].name,
                tolerances: overridesOf(screensById[screenId]),
                image: {
                    buildId: buildScreen.matchedBuildId ?? buildScreen.buildId,
                    sourceBuildId: buildScreen.buildId,
                    isBaseline
                }
            }))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

        let baselineResponse: IBuildResponse | null = null;
        if (baselineBuild) {
            const branch = await BranchEntity.query().filter({ id: baselineBuild.branchId }).select('name').findOneOrUndefined();
            baselineResponse = toBuildResponse(baselineBuild, branch?.name ?? '');
        }

        return { baselineBuild: baselineResponse, screens };
    }

    @http.PUT('/:screenId/tolerances')
    async updateTolerances(
        appId: UuidString,
        screenId: UuidString,
        user: UserEntity,
        body: HttpBody<IToleranceOverrides>
    ): Promise<IToleranceOverrides> {
        await this.appAccessSvc.assertCanAccessAppId({ kind: 'user', user }, appId);
        validateToleranceOverrides(body);

        const screen = await ScreenEntity.query().filter({ id: screenId, appId }).findOneOrUndefined();
        if (!screen) throw new HttpNotFoundError();

        screen.colorTolerance = body.colorTolerance ?? null;
        screen.shiftTolerance = body.shiftTolerance ?? null;
        screen.diffPctTolerance = body.diffPctTolerance ?? null;
        await screen.save();

        return overridesOf(screen);
    }
}
