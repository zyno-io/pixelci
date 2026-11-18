import { BaseAppConfig } from '@zyno-io/ts-server-foundation';

export class AppConfig extends BaseAppConfig {
    S3_ENDPOINT?: string;
    S3_REGION?: string;
    S3_BUCKET?: string;
    S3_ACCESS_KEY_ID?: string;
    S3_ACCESS_SECRET?: string;

    DEFAULT_PIXEL_MATCH_THRESHOLD = 0.2;
    // A true percentage of pixels (0..100): 0.01 means 0.01% of pixels may differ.
    DEFAULT_PIXEL_DIFF_PCT_THRESHOLD = 0.01;
    // Radius (px) within which shifted content is not counted as a diff. 0 disables.
    DEFAULT_PIXEL_SHIFT_TOLERANCE = 1;

    // When true (default), reads are filtered/gated by whether the caller can access the app's
    // project in the VCS provider. Set false for environments without a reachable VCS (e.g. e2e).
    ENFORCE_VCS_PROJECT_ACCESS: boolean = true;

    // Secret required to complete first-run setup (create the first VCS integration, become the first admin).
    // Unset, or shorter than 16 characters, disables first-run setup.
    SETUP_TOKEN?: string;

    // Maximum width*height of an uploaded screenshot (checked from the PNG header before decoding)
    SCREEN_MAX_PIXELS = 25_000_000;

    // Effective upload size limit: oversized bodies are rejected up front (Content-Length / source accounting), before any
    // multipart parsing. The per-file FileUpload maxSize on the upload endpoint ('17MB') sits above it as a backstop.
    // 16 MiB image + 64 KiB for multipart framing.
    HTTP_MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024 + 64 * 1024;

    // Public origin of the web app (e.g. https://pixelci.example.com). The OAuth redirect URI is always
    // `${PUBLIC_URL}/login`, so it must exactly match what is registered with the provider.
    PUBLIC_URL?: string;

    // GitLab CI auth. Job tokens (CI_JOB_TOKEN) are validated by calling GitLab's /api/v4/job, which needs the job-token
    // allowlist/scope to permit PixelCI. Set this to false to accept only GitLab ID tokens (id_tokens: PIXELCI_ID_TOKEN).
    GITLAB_JOB_TOKEN_AUTH_ENABLED: boolean = true;
    // Extra accepted `aud` values for GitLab ID tokens, comma-separated. The PUBLIC_URL origin is always accepted; add
    // others if the CLI's PIXELCI_API_URL differs from it (e.g. an internal URL). Each is accepted with or without a trailing slash.
    GITLAB_ID_TOKEN_AUDIENCES?: string;

    // OAuth 2.1 authorization server for MCP clients (claude.ai, Claude Desktop, Claude Code). The issuer is the PUBLIC_URL origin, which
    // must be https (http only on a loopback host); otherwise OAuth stays off whatever this is set to.
    MCP_OAUTH_ENABLED: boolean = true;
    // Dynamic client registration (RFC 7591) limits, per client IP and across all callers, per hour.
    OAUTH_DCR_MAX_PER_IP_PER_HOUR = 20;
    OAUTH_DCR_MAX_PER_HOUR = 200;
    // Client ID Metadata Documents: clients identified by an https URL whose document PixelCI fetches. Effective only when OAuth is.
    // Needs outbound HTTPS from the API to arbitrary public hosts. Fetch limits: per client_id URL and per host per 10 minutes, and overall per hour.
    OAUTH_CIMD_ENABLED: boolean = true;
    OAUTH_CIMD_MAX_FETCHES_PER_URL_PER_10_MIN = 10;
    OAUTH_CIMD_MAX_FETCHES_PER_HOST_PER_10_MIN = 30;
    OAUTH_CIMD_MAX_FETCHES_PER_HOUR = 300;
    OAUTH_CIMD_MAX_FETCHES_PER_IP_PER_10_MIN = 20;
}
