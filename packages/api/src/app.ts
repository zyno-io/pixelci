import { createApp, CreateAppOptions } from '@zyno-io/ts-server-foundation';
import { compact } from 'lodash';

import { AdminAuthMiddleware, BuildCiTokenMiddleware, UserAuthMiddleware, VcsTokenAuthMiddleware } from './accessories/AuthMiddleware.accessory';
import { ReencryptSecretsCommand } from './commands/ReencryptSecrets.command';
import { AppConfig } from './config';
import { AppsController } from './controllers/Apps.controller';
import { BranchesController } from './controllers/Branches.controller';
import { BuildsController } from './controllers/Builds.controller';
import { BuildScreensController } from './controllers/BuildScreens.controller';
import { ExternalReadController } from './controllers/ExternalRead.controller';
import { SessionController } from './controllers/Session.controller';
import { UsersController } from './controllers/Users.controller';
import { VcsIntegrationsController } from './controllers/VcsIntegrations.controller';
import { Db } from './database';
import { ProcessBuildJob } from './jobs/ProcessBuild.job';
import { ReapStuckBuildsJob } from './jobs/ReapStuckBuilds.job';
import { RerunCiJobJob } from './jobs/RerunCiJob.job';
import { AppAccessService } from './services/AppAccess.service';
import { PixelMatchService } from './services/PixelMatch.service';
import { S3Service } from './services/S3.service';
import { assertSecretsConfig } from './services/secrets/SecretBox';
import { VcsService } from './services/Vcs.service';

export const CoreAppOptions: CreateAppOptions<AppConfig> = {
    config: AppConfig,
    db: Db,
    cors: _appConfig => ({
        hosts: compact(['http://localhost:7925', 'http://localhost:4173']),
        credentials: true
    }),
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
        VcsIntegrationsController,
        UsersController,
        ExternalReadController
    ],
    commands: [ReencryptSecretsCommand],
    providers: [
        AdminAuthMiddleware,
        BuildCiTokenMiddleware,
        UserAuthMiddleware,
        VcsTokenAuthMiddleware,
        ProcessBuildJob,
        RerunCiJobJob,
        ReapStuckBuildsJob,
        PixelMatchService,
        VcsService,
        AppAccessService,
        S3Service
    ]
};

export const createPixelCIApp = () => {
    const app = createApp(CoreAppOptions);
    assertSecretsConfig(app.config);
    return app;
};
