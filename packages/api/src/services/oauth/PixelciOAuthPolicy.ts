import { AppConfig } from '../../config';
import { UserEntity } from '../../entities/User.entity';
import { VcsService } from '../Vcs.service';
import { OAuthPolicy, OAuthSessionCheck } from './OAuthPolicy';

/**
 * PixelCI's side of the authorization-server seam: an OAuth grant lives only as long as its user's VCS sign-in, since every MCP
 * read is made with that session. With ENFORCE_VCS_PROJECT_ACCESS off there is no VCS dependency to check.
 */
export class PixelciOAuthPolicy extends OAuthPolicy {
    constructor(
        private vcsService: VcsService,
        private appConfig: AppConfig
    ) {
        super();
    }

    async checkSession(userId: string): Promise<OAuthSessionCheck> {
        if (!this.appConfig.ENFORCE_VCS_PROJECT_ACCESS) return 'ok';
        const user = await UserEntity.query().filter({ id: userId }).findOneOrUndefined();
        if (!user) return 'reauth';
        return this.vcsService.checkUserSession(user);
    }
}
