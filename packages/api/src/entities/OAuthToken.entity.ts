import { entity, PrimaryKey } from '@zyno-io/ts-server-foundation';
import { BaseEntity, DatabaseField, UuidString } from '@zyno-io/ts-server-foundation';

/** An access or refresh token, stored only as a SHA-256 hash. */
@entity.name('oauth_tokens')
@entity.index(['tokenHash'], { unique: true })
@entity.index(['grantId'])
@entity.index(['expiresAt'])
export class OAuthTokenEntity extends BaseEntity {
    id!: UuidString & PrimaryKey;
    grantId!: UuidString;
    kind!: ('access' | 'refresh') & DatabaseField<{ type: 'varchar(16)' }>;
    tokenHash!: string & DatabaseField<{ type: 'varchar(64)' }>;
    createdAt!: Date;
    expiresAt!: Date;
    /** Refresh tokens only: when this token was exchanged for a new pair. */
    rotatedAt!: Date | null;
}
