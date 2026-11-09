import { entity, PrimaryKey } from '@zyno-io/ts-server-foundation';
import { BaseEntity, UuidString } from '@zyno-io/ts-server-foundation';

export interface IGitLabConfig {
    url: string;
    clientId: string;
    clientSecret: string;
}

export interface IGitHubConfig {
    /** Web base URL; defaults to https://github.com. Set for GitHub Enterprise Server. */
    url?: string;
    clientId: string;
    clientSecret: string;
    /** GitHub App id and PEM private key. Required on create; optional in storage (slice-1 rows lack them). */
    appId?: string;
    privateKey?: string;
    /** Required `aud` of Actions OIDC tokens. The CLI requests PIXELCI_API_URL (trailing slashes stripped). */
    oidcAudience: string;
    /** Optional OIDC issuer override (GHES / tests). */
    oidcIssuer?: string;
}

@entity.name('vcsIntegrations')
export class VcsIntegrationEntity extends BaseEntity {
    id!: UuidString & PrimaryKey;
    name!: string;
    platform!: 'gitlab' | 'github';
    config!: IGitLabConfig | IGitHubConfig;
}
