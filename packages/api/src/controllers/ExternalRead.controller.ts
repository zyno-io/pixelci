import { http, HttpQueries, HttpRequest, Redirect, UuidString } from '@zyno-io/ts-server-foundation';
import { AnyResponse } from '@zyno-io/ts-server-foundation';

import { VcsTokenAuthMiddleware, vcsPrincipal } from '../accessories/AuthMiddleware.accessory';
import { ExternalReadService } from '../services/ExternalRead.service';
import { S3Service } from '../services/S3.service';

export type { IExtAppResponse, IExtBuildDetailResponse, IExtBuildResponse, IExtBuildScreenResponse } from '../services/ExternalRead.service';
import type { IExtAppResponse, IExtBuildDetailResponse, IExtBuildResponse } from '../services/ExternalRead.service';

/**
 * Read-only API surface for programmatic consumers (e.g. the MCP endpoint), authenticated with a
 * VCS personal access token. Intentionally separate from the user (JWT) controllers so a
 * token can only ever read — never approve, reject, or comment. Every app is additionally gated by
 * whether the caller's token can access its project in the VCS provider.
 */
@http.controller('/api/ext')
@http.middleware(VcsTokenAuthMiddleware)
export class ExternalReadController {
    constructor(
        private s3Svc: S3Service,
        private extReadSvc: ExternalReadService
    ) {}

    @http.GET('apps')
    async listApps(request: HttpRequest): Promise<IExtAppResponse[]> {
        return this.extReadSvc.listApps(vcsPrincipal(request));
    }

    @http.GET('apps/:appId/builds')
    async listBuilds(
        appId: UuidString,
        request: HttpRequest,
        query: HttpQueries<{ branchId?: UuidString; limit?: number }>
    ): Promise<IExtBuildResponse[]> {
        return this.extReadSvc.listBuilds(vcsPrincipal(request), appId, query);
    }

    @http.GET('apps/:appId/builds/:buildId')
    async getBuild(appId: UuidString, buildId: UuidString, request: HttpRequest): Promise<IExtBuildDetailResponse> {
        return this.extReadSvc.getBuild(vcsPrincipal(request), appId, buildId);
    }

    @http.GET('apps/:appId/builds/:buildId/screens/:screenId/image')
    async getScreenImage(
        appId: UuidString,
        buildId: UuidString,
        screenId: UuidString,
        request: HttpRequest,
        query: HttpQueries<{ kind?: 'new' | 'diff' }>
    ): AnyResponse {
        const path = await this.extReadSvc.getScreenImagePath(
            vcsPrincipal(request),
            appId,
            buildId,
            screenId,
            query.kind === 'diff' ? 'diff' : 'new'
        );
        const url = await this.s3Svc.getSignedUrl(path);
        return Redirect.toUrl(url);
    }
}
