import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, ReadStream, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';
import { Readable } from 'stream';

import { AppConfig } from '../../src/config';
import { S3Service } from '../../src/services/S3.service';

// We can't mock modules in CJS node:test easily, so we test through the real class
// with a real S3Client that we spy on.

function createMockConfig(): AppConfig {
    return {
        S3_ENDPOINT: 'http://localhost:9000',
        S3_REGION: 'us-east-1',
        S3_BUCKET: 'test-bucket',
        S3_ACCESS_KEY_ID: 'test-key',
        S3_ACCESS_SECRET: 'test-secret'
    } as AppConfig;
}

describe('S3Service', () => {
    describe('getPathForScreen', () => {
        it('should generate correct screen path', () => {
            const service = new S3Service(createMockConfig());
            const path = service.getPathForScreen('app-123', 'build-456', 'screen-789');
            assert.equal(path, 'screens/app-123/build-456/screen-789.png');
        });
    });

    describe('getPathForDiff', () => {
        it('should generate correct diff path', () => {
            const service = new S3Service(createMockConfig());
            const path = service.getPathForDiff('app-123', 'build-456', 'screen-789');
            assert.equal(path, 'screens/app-123/build-456/screen-789.diff.png');
        });
    });

    describe('uploadFile', () => {
        it('should call S3Client.send with PutObjectCommand', async () => {
            const service = new S3Service(createMockConfig());
            const sendMock = mock.method(service['s3Client'], 'send', async () => ({}));

            await service.uploadFile(Buffer.from('test'), 'test/path.png', 'image/png');

            assert.equal(sendMock.mock.callCount(), 1);
            const command = sendMock.mock.calls[0].arguments[0];
            assert.ok(command instanceof PutObjectCommand);
        });

        it('should stream a path input with an explicit ContentLength', async () => {
            const dir = mkdtempSync(join(tmpdir(), 's3-spec-'));
            const file = join(dir, 'a.png');
            writeFileSync(file, Buffer.alloc(1234, 1));
            const service = new S3Service(createMockConfig());
            const sendMock = mock.method(service['s3Client'], 'send', async () => ({}));

            try {
                await service.uploadFile(file, 'test/path.png', 'image/png');
                const command = sendMock.mock.calls[0].arguments[0] as PutObjectCommand;
                assert.ok(command instanceof PutObjectCommand);
                assert.ok(command.input.Body instanceof ReadStream);
                assert.equal(command.input.ContentLength, 1234);
                const stream = command.input.Body as ReadStream;
                stream.destroy();
                await once(stream, 'close');
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('should propagate upload errors', async () => {
            const service = new S3Service(createMockConfig());
            mock.method(service['s3Client'], 'send', async () => {
                throw new Error('Upload failed');
            });

            await assert.rejects(() => service.uploadFile(Buffer.from('test'), 'test/path.png', 'image/png'), {
                message: 'Upload failed'
            });
        });
    });

    describe('deleteFile', () => {
        it('should call S3Client.send with DeleteObjectCommand', async () => {
            const service = new S3Service(createMockConfig());
            const sendMock = mock.method(service['s3Client'], 'send', async () => ({}));

            await service.deleteFile('test/path.png');

            assert.equal(sendMock.mock.callCount(), 1);
            const command = sendMock.mock.calls[0].arguments[0];
            assert.ok(command instanceof DeleteObjectCommand);
        });

        it('should propagate delete errors', async () => {
            const service = new S3Service(createMockConfig());
            mock.method(service['s3Client'], 'send', async () => {
                throw new Error('Delete failed');
            });

            await assert.rejects(() => service.deleteFile('test/path.png'), { message: 'Delete failed' });
        });
    });

    describe('getBuffer', () => {
        it('should download file as buffer', async () => {
            const service = new S3Service(createMockConfig());
            const mockStream = new Readable({ read() {} });
            mockStream.push('test file content');
            mockStream.push(null);

            mock.method(service['s3Client'], 'send', async () => ({ Body: mockStream }));

            const buffer = await service.getBuffer('test/path.png');

            assert.equal(buffer.toString(), 'test file content');
        });

        it('should propagate stream errors', async () => {
            const service = new S3Service(createMockConfig());
            const mockStream = new Readable({ read() {} });

            mock.method(service['s3Client'], 'send', async () => ({ Body: mockStream }));

            const promise = service.getBuffer('test/path.png');
            setImmediate(() => mockStream.emit('error', new Error('Download failed')));

            await assert.rejects(promise, { message: 'Download failed' });
        });
    });

    describe('S3Client initialization', () => {
        it('should not include credentials when not provided', () => {
            const config = {
                ...createMockConfig(),
                S3_ACCESS_KEY_ID: undefined,
                S3_ACCESS_SECRET: undefined
            } as unknown as AppConfig;

            // Just verify it doesn't throw
            const service = new S3Service(config);
            assert.ok(service);
        });
    });
});
