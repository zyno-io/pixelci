import { createPostgresDatabase } from '@zyno-io/ts-server-foundation';

import { AppEntity } from './entities/App.entity';
import { BranchEntity } from './entities/Branch.entity';
import { BuildEntity } from './entities/Build.entity';
import { BuildScreenEntity } from './entities/BuildScreen.entity';
import { BuildShardEntity } from './entities/BuildShard.entity';
import { OAuthAuthorizationEntity } from './entities/OAuthAuthorization.entity';
import { OAuthClientEntity } from './entities/OAuthClient.entity';
import { OAuthGrantEntity } from './entities/OAuthGrant.entity';
import { OAuthTokenEntity } from './entities/OAuthToken.entity';
import { ScreenEntity } from './entities/Screen.entity';
import { ScreenDecisionEntity } from './entities/ScreenDecision.entity';
import { UserEntity } from './entities/User.entity';
import { VcsIntegrationEntity } from './entities/VcsIntegration.entity';

export class Db extends createPostgresDatabase({}, [
    AppEntity,
    BranchEntity,
    BuildEntity,
    BuildScreenEntity,
    BuildShardEntity,
    OAuthAuthorizationEntity,
    OAuthClientEntity,
    OAuthGrantEntity,
    OAuthTokenEntity,
    ScreenDecisionEntity,
    ScreenEntity,
    UserEntity,
    VcsIntegrationEntity
]) {}
