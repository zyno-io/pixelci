import { http, HttpBadRequestError, HttpBody, HttpNotFoundError, UuidString } from '@zyno-io/ts-server-foundation';

import { AdminAuthMiddleware } from '../accessories/AuthMiddleware.accessory';
import { ApiController } from '../accessories/Controller.accessory';
import { UserEntity } from '../entities/User.entity';
import { VcsIntegrationEntity } from '../entities/VcsIntegration.entity';

interface IUserListResponse {
    id: string;
    name: string;
    isAdmin: boolean;
    createdAt: Date;
    lastLoginAt: Date;
    vcsName: string;
}

interface IUserUpdateInput {
    isAdmin: boolean;
}

@ApiController('/api/admin/users')
@http.middleware(AdminAuthMiddleware)
export class UsersController {
    constructor() {}

    @http.GET()
    async index(): Promise<IUserListResponse[]> {
        const users = await UserEntity.query().orderBy('name').find();

        const vcsIds = [...new Set(users.map(u => u.vcsId))];
        const vcsIntegrations = await VcsIntegrationEntity.query()
            .filter({ id: { $in: vcsIds } })
            .find();
        const vcsMap = new Map(vcsIntegrations.map(v => [v.id, v.name]));

        return users.map(u => ({
            id: u.id,
            name: u.name,
            isAdmin: u.isAdmin,
            createdAt: u.createdAt,
            lastLoginAt: u.lastLoginAt,
            vcsName: vcsMap.get(u.vcsId) ?? ''
        }));
    }

    @http.PUT('/:id')
    async update(id: UuidString, body: HttpBody<IUserUpdateInput>, currentUser: UserEntity): Promise<{ id: string; isAdmin: boolean }> {
        if (id.toLowerCase() === currentUser.id.toLowerCase()) {
            throw new HttpBadRequestError('Cannot modify your own admin status');
        }

        const user = await UserEntity.query().filter({ id }).findOneOrUndefined();
        if (!user) throw new HttpNotFoundError();

        user.isAdmin = body.isAdmin;
        await user.save();

        return { id: user.id, isAdmin: user.isAdmin };
    }
}
