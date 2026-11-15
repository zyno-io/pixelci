import { createApp, CreateAppOptions, DEFAULT_REDACTED_QUERY_KEYS } from '@zyno-io/ts-server-foundation';
import { compact } from 'lodash';

import {
    AdminAuthMiddleware,
    BuildCiTokenMiddleware,
    McpAuthMiddleware,
    UserAuthMiddleware,
    VcsTokenAuthMiddleware
} from './accessories/AuthMiddleware.accessory';
import { SetIntegrationSecretCommand } from './commands/SetIntegrationSecret.command';
import { AppConfig } from './config';
import { AppsController } from './controllers/Apps.controller';
import { BranchesController } from './controllers/Branches.controller';
import { BuildsController } from './controllers/Builds.controller';
import { BuildScreensController } from './controllers/BuildScreens.controller';
import { ConnectedAppsController } from './controllers/ConnectedApps.controller';
import { ExternalReadController } from './controllers/ExternalRead.controller';
import { McpController } from './controllers/Mcp.controller';
import { ScreensController } from './controllers/Screens.controller';
import { OAuthController } from './controllers/OAuth.controller';
import { OAuthWellKnownController } from './controllers/OAuthWellKnown.controller';
import { SessionController } from './controllers/Session.controller';
import { UsersController } from './controllers/Users.controller';
import { VcsIntegrationsController } from './controllers/VcsIntegrations.controller';
import { Db } from './database';
import { ProcessBuildJob } from './jobs/ProcessBuild.job';
import { PruneOAuthJob } from './jobs/PruneOAuth.job';
import { ReapStuckBuildsJob } from './jobs/ReapStuckBuilds.job';
import { RerunCiJobJob } from './jobs/RerunCiJob.job';
import { AppAccessService } from './services/AppAccess.service';
import { ExternalReadService } from './services/ExternalRead.service';
import { OAuthPolicy } from './services/oauth/OAuthPolicy';
import { OAuthServerService } from './services/oauth/OAuthServer.service';
import { PixelciOAuthPolicy } from './services/oauth/PixelciOAuthPolicy';
import { PixelMatchService } from './services/PixelMatch.service';
import { RateLimiterService } from './services/RateLimiter.service';
import { S3Service } from './services/S3.service';
import { assertSecretsConfig } from './services/secrets/SecretBox';
import { ThumbnailService } from './services/Thumbnail.service';
import { VcsService } from './services/Vcs.service';

export const CoreAppOptions: CreateAppOptions<AppConfig> = {
    config: AppConfig,
    db: Db,
    cors: _appConfig => [
        {
            hosts: compact(['http://localhost:7925', 'http://localhost:4173']),
            credentials: true
        },
        // Browser-based MCP clients (e.g. the MCP Inspector) reach the discovery, token and MCP endpoints cross-origin. Any origin, but never
        // credentials. The authorize endpoint (a top-level navigation) and the SPA-facing /api/connected-apps routes are deliberately excluded.
        {
            hosts: ['*'],
            paths: ['/.well-known/oauth-', '/api/oauth/token', '/api/oauth/register', '/api/oauth/revoke', '/api/mcp'],
            methods: ['GET', 'POST', 'OPTIONS'],
            exposeHeaders: ['WWW-Authenticate']
        }
    ],
    // Query strings carry authorization codes, `state` and consent request ids; redact them from request logs.
    requestLogging: { redactQueryKeys: [...DEFAULT_REDACTED_QUERY_KEYS, 'request'] },
    frameworkConfig: {
        port: 7924
    },
    staticFiles: {
        directory: 'static'
    },
    enableWorker: true,
    controllers: [
        SessionController,
        AppsController,
        BranchesController,
        BuildsController,
        BuildScreensController,
        ScreensController,
        VcsIntegrationsController,
        UsersController,
        ExternalReadController,
        McpController,
        OAuthWellKnownController,
        OAuthController,
        ConnectedAppsController
    ],
    commands: [SetIntegrationSecretCommand],
    providers: [
        AdminAuthMiddleware,
        BuildCiTokenMiddleware,
        UserAuthMiddleware,
        VcsTokenAuthMiddleware,
        McpAuthMiddleware,
        ProcessBuildJob,
        RerunCiJobJob,
        ReapStuckBuildsJob,
        PruneOAuthJob,
        PixelMatchService,
        VcsService,
        AppAccessService,
        ExternalReadService,
        RateLimiterService,
        OAuthServerService,
        { provide: OAuthPolicy, useClass: PixelciOAuthPolicy },
        S3Service,
        ThumbnailService
    ]
};

export const createPixelCIApp = () => {
    const app = createApp(CoreAppOptions);
    assertSecretsConfig(app.config);
    return app;
};
