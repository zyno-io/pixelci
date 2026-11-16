import { entity, PrimaryKey } from '@zyno-io/ts-server-foundation';
import { BaseEntity, DatabaseField, UuidString } from '@zyno-io/ts-server-foundation';

/**
 * An OAuth client: dynamically registered (RFC 7591; `id` is the client_id) or a cached Client ID Metadata Document client (`metadataUrl`
 * is the client_id, `id` is internal and never accepted as one).
 */
@entity.name('oauth_clients')
@entity.index(['metadataUrl'], { unique: true })
export class OAuthClientEntity extends BaseEntity {
    id!: UuidString & PrimaryKey;
    name!: string & DatabaseField<{ type: 'varchar(100)' }>;
    redirectUris!: string[];
    tokenEndpointAuthMethod!: ('none' | 'client_secret_post' | 'client_secret_basic') & DatabaseField<{ type: 'varchar(32)' }>;
    /** SHA-256 hex of the client secret; null for public (`none`) clients. */
    secretHash!: (string & DatabaseField<{ type: 'varchar(64)' }>) | null;
    createdAt!: Date;
    lastUsedAt!: Date | null;
    /** Metadata-document clients only: the client_id URL (canonical). */
    metadataUrl!: (string & DatabaseField<{ type: 'varchar(2048)' }>) | null;
    metadataFetchedAt!: Date | null;
    /** When the cached document must be refetched. */
    metadataExpiresAt!: Date | null;
}
