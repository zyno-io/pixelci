import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { TestingHelpers } from '@zyno-io/ts-server-foundation';
import { randomBytes } from 'crypto';

/** Points the TestingFacade at the local Postgres (see resources/dev/docker-compose.yml). */
export function configureTestDatabase() {
    TestingHelpers.setDefaultDatabaseConfig({
        DB_ADAPTER: 'postgres',
        PG_HOST: process.env.PG_HOST ?? '127.0.0.1',
        PG_PORT: Number(process.env.PG_PORT ?? 5432),
        PG_USER: process.env.PG_USER ?? 'root',
        PG_PASSWORD_SECRET: process.env.PG_PASSWORD_SECRET ?? 'secret',
        PG_CONNECTION_LIMIT: 10
    });
}

/**
 * Gives this process its own Redis key prefix, so integration suites can run concurrently (and a crashed run
 * can't leave locks or queues behind for the next one). Call before the testing facade starts.
 */
export function useIsolatedRedisPrefix(suite: string) {
    process.env.REDIS_PREFIX = `pixelci_${suite}_${process.pid}_${randomBytes(3).toString('hex')}`;
}

/**
 * Creates S3_BUCKET when the run points at a private bucket (S3_BUCKET set in the environment); a no-op otherwise.
 * An already-existing bucket is fine.
 */
export async function ensureTestBucket() {
    const bucket = process.env.S3_BUCKET;
    if (!bucket) return;
    const client = new S3Client({
        endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:29444',
        region: process.env.S3_REGION ?? 'us-east-1',
        forcePathStyle: true,
        credentials: {
            accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'AKIAIOSFODNN7EXAMPLE',
            secretAccessKey: process.env.S3_ACCESS_SECRET ?? 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
        }
    });
    try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (err) {
        const name = (err as { name?: string }).name;
        if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw err;
    } finally {
        client.destroy();
    }
}
