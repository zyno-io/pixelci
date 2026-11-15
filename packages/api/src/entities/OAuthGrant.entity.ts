import { entity, PrimaryKey } from '@zyno-io/ts-server-foundation';
import { BaseEntity, DatabaseField, UuidString } from '@zyno-io/ts-server-foundation';

/** A token family: what the user sees as one "connected app". */
@entity.name('oauth_grants')
@entity.index(['userId', 'revokedAt'])
@entity.index(['clientId'])
export class OAuthGrantEntity extends BaseEntity {
    id!: UuidString & PrimaryKey;
    clientId!: UuidString;
    userId!: UuidString;
    scope!: string & DatabaseField<{ type: 'varchar(255)' }>;
    resource!: string & DatabaseField<{ type: 'varchar(2048)' }>;
    /** For display only. */
    redirectUri!: string & DatabaseField<{ type: 'varchar(2048)' }>;
    createdAt!: Date;
    /** Absolute cap: no token in the grant outlives it. */
    expiresAt!: Date;
    lastUsedAt!: Date | null;
    revokedAt!: Date | null;
    revokedReason!:
        | (('user' | 'client_revoke' | 'refresh_reuse' | 'code_reuse' | 'vcs_session' | 'superseded') & DatabaseField<{ type: 'varchar(32)' }>)
        | null;
}
