import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import assert from 'assert';
import { readFile } from 'fs/promises';
import { Readable } from 'stream';

import { AppConfig } from '../config';

// Bounds a whole S3 call, body included, so a stalled socket fails the call instead of hanging a build.
// (requestTimeout/socketTimeout on the smithy handler only warn, or stop applying once headers arrive.)
const S3_CALL_TIMEOUT_MS = 60_000;

/** True for the errors S3 gives when the requested object does not exist. */
export function isNotFound(err: unknown): boolean {
    // by name, not status: a missing bucket is also a 404 and must not pass for a missing object
    const name = (err as { name?: string } | undefined)?.name;
    return name === 'NotFound' || name === 'NoSuchKey';
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// Strict on purpose: anything that does not match exactly is "unrecognized" to the storage cleaner, and is never deleted.
const SCREENS_KEY_RE = new RegExp(`^screens/(${UUID})/(${UUID})/(${UUID})(?:\\.(${UUID})\\.thumb|\\.diff)?\\.png$`);

export interface IParsedScreensKey {
    appId: string;
    buildId: string;
    screenId: string;
    kind: 'upload' | 'diff' | 'thumb';
    /** Thumbnails only: the upload (build screen) the thumbnail was generated for. */
    buildScreenId?: string;
}

/** Inverse of the getPathFor* helpers below. Returns null for any key that is not exactly one of their shapes. */
export function parseScreensKey(key: string): IParsedScreensKey | null {
    const m = SCREENS_KEY_RE.exec(key);
    if (!m) return null;
    const [, appId, buildId, screenId, buildScreenId] = m;
    if (buildScreenId) return { appId, buildId, screenId, kind: 'thumb', buildScreenId };
    return { appId, buildId, screenId, kind: key.endsWith('.diff.png') ? 'diff' : 'upload' };
}

export interface IS3Object {
    key: string;
    lastModified?: Date;
    size?: number;
}

export interface IListObjectsOptions {
    /** Lists keys after this one (lexicographically). Preferred over a token: it stays valid while the listed keys are deleted. */
    startAfter?: string;
    continuationToken?: string;
    maxKeys?: number;
}

export class S3Service {
    private s3Client: S3Client;

    constructor(private appConfig: AppConfig) {
        this.s3Client = new S3Client({
            endpoint: appConfig.S3_ENDPOINT,
            region: appConfig.S3_REGION,
            forcePathStyle: true,
            // Only compute/validate checksums when an operation requires them (SDK defaults break some S3-compatible stores)
            requestChecksumCalculation: 'WHEN_REQUIRED',
            responseChecksumValidation: 'WHEN_REQUIRED',
            ...(appConfig.S3_ACCESS_KEY_ID &&
                appConfig.S3_ACCESS_SECRET && {
                    credentials: {
                        accessKeyId: appConfig.S3_ACCESS_KEY_ID,
                        secretAccessKey: appConfig.S3_ACCESS_SECRET
                    }
                })
        });
    }

    async uploadFile(localPath: string, targetPath: string, contentType: string): Promise<void>;
    async uploadFile(buffer: Buffer, targetPath: string, contentType: string): Promise<void>;
    async uploadFile(localPathOrBuffer: string | Buffer, targetPath: string, contentType: string): Promise<void> {
        // A path is read fully into memory rather than streamed: a stream body can't be replayed on an SDK retry and leaks its fd
        // if S3 rejects the request early. Memory is bounded by the upload size cap (16MB).
        const body = typeof localPathOrBuffer === 'string' ? await readFile(localPathOrBuffer) : localPathOrBuffer;
        const command = new PutObjectCommand({
            Bucket: this.appConfig.S3_BUCKET,
            Key: targetPath,
            ContentType: contentType,
            Body: body
        });
        await this.s3Client.send(command, { abortSignal: AbortSignal.timeout(S3_CALL_TIMEOUT_MS) });
    }

    async deleteFile(path: string): Promise<void> {
        await this.s3Client.send(
            new DeleteObjectCommand({
                Bucket: this.appConfig.S3_BUCKET,
                Key: path
            }),
            { abortSignal: AbortSignal.timeout(S3_CALL_TIMEOUT_MS) }
        );
    }

    /**
     * Deletes keys one request each (not the bulk DeleteObjects call, which some S3-compatible stores lack), `concurrency` at a time.
     * Never throws for a single key: failures are returned so the caller can count them and carry on.
     */
    async deleteFiles(keys: string[], concurrency = 8): Promise<{ deleted: string[]; failed: { key: string; error: unknown }[] }> {
        const deleted: string[] = [];
        const failed: { key: string; error: unknown }[] = [];
        let next = 0;
        const worker = async () => {
            while (next < keys.length) {
                const key = keys[next++];
                try {
                    await this.deleteFile(key);
                    deleted.push(key);
                } catch (error) {
                    failed.push({ key, error });
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, worker));
        return { deleted, failed };
    }

    /** One page (up to 1000 keys, sorted) of the objects under a prefix. `nextToken` is set while more remain. */
    async listObjects(prefix: string, options: IListObjectsOptions = {}): Promise<{ objects: IS3Object[]; nextToken?: string }> {
        const res = await this.s3Client.send(
            new ListObjectsV2Command({
                Bucket: this.appConfig.S3_BUCKET,
                Prefix: prefix,
                StartAfter: options.startAfter,
                ContinuationToken: options.continuationToken,
                MaxKeys: options.maxKeys
            }),
            { abortSignal: AbortSignal.timeout(S3_CALL_TIMEOUT_MS) }
        );
        const objects = (res.Contents ?? []).flatMap(o => (o.Key ? [{ key: o.Key, lastModified: o.LastModified, size: o.Size }] : []));
        return { objects, nextToken: res.IsTruncated ? res.NextContinuationToken : undefined };
    }

    /** One page of the "directories" directly under a prefix (each result ends in a slash). */
    async listCommonPrefixes(prefix: string, token?: string): Promise<{ prefixes: string[]; nextToken?: string }> {
        const res = await this.s3Client.send(
            new ListObjectsV2Command({ Bucket: this.appConfig.S3_BUCKET, Prefix: prefix, Delimiter: '/', ContinuationToken: token }),
            { abortSignal: AbortSignal.timeout(S3_CALL_TIMEOUT_MS) }
        );
        const prefixes = (res.CommonPrefixes ?? []).flatMap(p => (p.Prefix ? [p.Prefix] : []));
        return { prefixes, nextToken: res.IsTruncated ? res.NextContinuationToken : undefined };
    }

    /** Whether an object is in the bucket. Only "not found" answers false; any other failure throws. */
    async exists(path: string): Promise<boolean> {
        try {
            await this.s3Client.send(new HeadObjectCommand({ Bucket: this.appConfig.S3_BUCKET, Key: path }), {
                abortSignal: AbortSignal.timeout(S3_CALL_TIMEOUT_MS)
            });
            return true;
        } catch (err) {
            if (isNotFound(err)) return false;
            throw err;
        }
    }

    async getSignedUrl(path: string): Promise<string> {
        const command = new GetObjectCommand({
            Bucket: this.appConfig.S3_BUCKET,
            Key: path
        });
        return getSignedUrl(this.s3Client, command, { expiresIn: 300 });
    }

    async getBuffer(path: string): Promise<Buffer> {
        const command = new GetObjectCommand({
            Bucket: this.appConfig.S3_BUCKET,
            Key: path
        });
        const response = await this.s3Client.send(command, { abortSignal: AbortSignal.timeout(S3_CALL_TIMEOUT_MS) });
        assert(response.Body instanceof Readable);
        const body = response.Body as Readable;
        return new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = [];
            body.on('data', (chunk: Buffer) => {
                chunks.push(chunk);
            });
            body.on('end', () => {
                resolve(Buffer.concat(chunks));
            });
            body.on('error', (err: Error) => {
                reject(err);
            });
        });
    }

    /**
     * Like getBuffer, but returns undefined instead of reading an object larger than maxBytes
     * (checked against ContentLength, and enforced while streaming if the length is missing).
     */
    async getBufferWithLimit(path: string, maxBytes: number): Promise<Buffer | undefined> {
        const command = new GetObjectCommand({
            Bucket: this.appConfig.S3_BUCKET,
            Key: path
        });
        const response = await this.s3Client.send(command, { abortSignal: AbortSignal.timeout(S3_CALL_TIMEOUT_MS) });
        assert(response.Body instanceof Readable);
        const body = response.Body as Readable;
        if (response.ContentLength !== undefined && response.ContentLength > maxBytes) {
            body.destroy();
            return undefined;
        }
        return new Promise<Buffer | undefined>((resolve, reject) => {
            const chunks: Buffer[] = [];
            let total = 0;
            body.on('data', (chunk: Buffer) => {
                total += chunk.length;
                if (total > maxBytes) {
                    body.destroy();
                    resolve(undefined);
                    return;
                }
                chunks.push(chunk);
            });
            body.on('end', () => resolve(Buffer.concat(chunks)));
            body.on('error', (err: Error) => reject(err));
        });
    }

    getPathForScreen(appId: string, buildId: string, screenId: string): string {
        return `screens/${appId}/${buildId}/${screenId}.png`;
    }
    /** Keyed by the upload (build screen id): a re-upload to the same build gets a new thumbnail, never a stale one. */
    getPathForThumbnail(appId: string, buildId: string, screenId: string, buildScreenId: string): string {
        return `screens/${appId}/${buildId}/${screenId}.${buildScreenId}.thumb.png`;
    }
    getPathForDiff(appId: string, buildId: string, screenId: string): string {
        return `screens/${appId}/${buildId}/${screenId}.diff.png`;
    }
}
