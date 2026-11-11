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

    // Maximum width*height of an uploaded screenshot (checked from the PNG header before decoding)
    SCREEN_MAX_PIXELS = 25_000_000;
}
