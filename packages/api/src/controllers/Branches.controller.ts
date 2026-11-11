import { http, UuidString } from '@zyno-io/ts-server-foundation';

import { UserAuthMiddleware } from '../accessories/AuthMiddleware.accessory';
import { ApiController } from '../accessories/Controller.accessory';
import { BranchEntity } from '../entities/Branch.entity';
import { UserEntity } from '../entities/User.entity';
import { AppAccessService } from '../services/AppAccess.service';

export type IBranchResponse = Pick<BranchEntity, 'id' | 'name'>;

@ApiController('/api/apps/:appId/branches')
@http.middleware(UserAuthMiddleware)
export class BranchesController {
    constructor(private appAccessSvc: AppAccessService) {}

    @http.GET()
    async index(appId: UuidString, user: UserEntity): Promise<IBranchResponse[]> {
        await this.appAccessSvc.assertCanAccessAppId({ kind: 'user', user }, appId);
        const branches = await BranchEntity.query().filter({ appId }).find();
        return branches.map(({ id, name }) => ({ id, name }));
    }
}
