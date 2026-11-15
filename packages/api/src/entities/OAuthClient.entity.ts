import { entity, PrimaryKey } from '@zyno-io/ts-server-foundation';
import { BaseEntity, DatabaseField, UuidString } from '@zyno-io/ts-server-foundation';

/** A dynamically registered OAuth client (RFC 7591). `id` is the client_id. */
@entity.name('oauth_clients')
export class OAuthClientEntity extends BaseEntity {
    id!: UuidString & PrimaryKey;
    name!: string & DatabaseField<{ type: 'varchar(100)' }>;
    redirectUris!: string[];
    tokenEndpointAuthMethod!: ('none' | 'client_secret_post' | 'client_secret_basic') & DatabaseField<{ type: 'varchar(32)' }>;
    /** SHA-256 hex of the client secret; null for public (`none`) clients. */
    secretHash!: (string & DatabaseField<{ type: 'varchar(64)' }>) | null;
    createdAt!: Date;
    lastUsedAt!: Date | null;
}
