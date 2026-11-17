import { http, HttpNotFoundError, UuidString } from '@zyno-io/ts-server-foundation';

import { UserAuthMiddleware } from '../accessories/AuthMiddleware.accessory';
import { ApiController } from '../accessories/Controller.accessory';
import { ScreenDecisionEntity } from '../entities/ScreenDecision.entity';
import { UserEntity } from '../entities/User.entity';
import { AppAccessService } from '../services/AppAccess.service';
import { IDecisionSummary, loadDecisionSummaries } from '../services/Decisions';

@ApiController('/api/apps/:appId/decisions')
export class DecisionsController {
    constructor(private appAccessSvc: AppAccessService) {}

    /**
     * Revokes an approval (or a rejection): builds processed from now on no longer match it. Builds already approved stay approved.
     * Idempotent; there is no un-revoke (the next build that makes the same change asks again).
     */
    @http.POST(':id/revoke')
    @http.middleware(UserAuthMiddleware)
    async revoke(appId: UuidString, id: UuidString, user: UserEntity): Promise<IDecisionSummary> {
        await this.appAccessSvc.assertCanReviewAppId(user, appId);

        const decision = await ScreenDecisionEntity.query().filter({ id, appId }).findOneOrUndefined();
        if (!decision) throw new HttpNotFoundError();

        if (!decision.revokedAt) {
            // conditional, so concurrent revokes keep the first one's attribution
            await ScreenDecisionEntity.query().filter({ id, appId, revokedAt: null }).patchMany({ revokedAt: new Date(), revokedById: user.id });
        }

        const summary = (await loadDecisionSummaries(appId, [id])).get(id);
        if (!summary) throw new HttpNotFoundError();
        return summary;
    }
}
