export type OAuthSessionCheck = 'ok' | 'reauth' | 'unavailable';

/**
 * The seam between the authorization server and the host application. The server knows nothing about VCS providers or app access;
 * the host decides whether the user behind a grant may still hold one.
 */
export abstract class OAuthPolicy {
    /**
     * Whether the user's upstream sign-in is still usable. `reauth`: definitively gone (the grant should die and the user sign in
     * again). `unavailable`: couldn't tell (transient failure); callers proceed.
     */
    abstract checkSession(userId: string): Promise<OAuthSessionCheck>;
}
