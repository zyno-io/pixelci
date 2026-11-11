import { BaseAppConfig } from '@zyno-io/ts-server-foundation';

export class AppConfig extends BaseAppConfig {
    S3_ENDPOINT?: string;
    S3_REGION?: string;
    S3_BUCKET?: string;
    S3_ACCESS_KEY_ID?: string;
    S3_ACCESS_SECRET?: string;

    DEFAULT_PIXEL_MATCH_THRESHOLD = 0.2;
    DEFAULT_PIXEL_DIFF_PCT_THRESHOLD = 1;

    // When true (default), reads are filtered/gated by whether the caller can access the app's
    // project in the VCS provider. Set false for environments without a reachable VCS (e.g. e2e).
    ENFORCE_VCS_PROJECT_ACCESS: boolean = true;

    // Secret required to complete first-run setup (create the first VCS integration, become the first admin).
    // Unset, or shorter than 16 characters, disables first-run setup.
    SETUP_TOKEN?: string;
}
