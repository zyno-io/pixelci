import { ISafeFetchResult, safeHttpsGetJson } from './SafeHttpsFetch';

/**
 * The seam for retrieving a client's metadata document. Production uses the SSRF-hardened fetcher; integration tests provide a
 * fake so they need no network. Throws ClientMetadataFetchError on failure.
 */
export abstract class ClientMetadataFetcher {
    abstract fetch(url: URL): Promise<ISafeFetchResult>;
}

export class SafeHttpsClientMetadataFetcher extends ClientMetadataFetcher {
    fetch(url: URL): Promise<ISafeFetchResult> {
        return safeHttpsGetJson(url);
    }
}
