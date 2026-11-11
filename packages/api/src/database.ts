import { createPostgresDatabase } from '@zyno-io/ts-server-foundation';

import { AppEntity } from './entities/App.entity';
import { BranchEntity } from './entities/Branch.entity';
import { BuildEntity } from './entities/Build.entity';
import { BuildScreenEntity } from './entities/BuildScreen.entity';
import { BuildShardEntity } from './entities/BuildShard.entity';
import { ScreenEntity } from './entities/Screen.entity';
import { UserEntity } from './entities/User.entity';
import { VcsIntegrationEntity } from './entities/VcsIntegration.entity';

export class Db extends createPostgresDatabase({}, [
    AppEntity,
    BranchEntity,
    BuildEntity,
    BuildScreenEntity,
    BuildShardEntity,
    ScreenEntity,
    UserEntity,
    VcsIntegrationEntity
]) {}
