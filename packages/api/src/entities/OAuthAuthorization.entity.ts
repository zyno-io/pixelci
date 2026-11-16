import { entity, PrimaryKey } from '@zyno-io/ts-server-foundation';
import { BaseEntity, DatabaseField, UuidString } from '@zyno-io/ts-server-foundation';

/** One authorization request: a pending consent, then (once approved) the authorization code, then redeemed. */
@entity.name('oauth_authorizations')
@entity.index(['codeHash'], { unique: true })
@entity.index(['expiresAt'])
@entity.index(['clientId'])
export class OAuthAuthorizationEntity extends BaseEntity {
    /** The consent handle (`/oauth/consent?request=<id>`); not a secret. */
    id!: UuidString & PrimaryKey;
    clientId!: UuidString;
    /** Set at approve or deny. */
    userId!: UuidString | null;
    /** The exact redirect_uri of the request. */
    redirectUri!: string & DatabaseField<{ type: 'varchar(2048)' }>;
    state!: (string & DatabaseField<{ type: 'text' }>) | null;
    codeChallenge!: string & DatabaseField<{ type: 'varchar(43)' }>;
    scope!: string & DatabaseField<{ type: 'varchar(255)' }>;
    resource!: string & DatabaseField<{ type: 'varchar(2048)' }>;
    status!: ('pending' | 'approved' | 'denied' | 'redeemed') & DatabaseField<{ type: 'varchar(16)' }>;
    /** SHA-256 hex of the authorization code. */
    codeHash!: (string & DatabaseField<{ type: 'varchar(64)' }>) | null;
    grantId!: UuidString | null;
    createdAt!: Date;
    /** The pending request's expiry; reset to the code's expiry at approval. */
    expiresAt!: Date;
    approvedAt!: Date | null;
    redeemedAt!: Date | null;
}
