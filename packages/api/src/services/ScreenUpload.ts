import { HttpBadRequestError } from '@zyno-io/ts-server-foundation';
import { open } from 'fs/promises';
import { crc32 } from 'zlib';

export const MAX_SCREEN_NAME_LENGTH = 200;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_HEADER_LENGTH = 33; // signature (8) + IHDR chunk: length (4) + type (4) + data (13) + CRC (4)

// Control characters, line/paragraph separators, and bidi override/isolate controls
// (built from a string: the type compiler would emit a regex literal containing raw U+2028/2029, which is a syntax error)
const FORBIDDEN_NAME_CHARS = new RegExp('[\\p{Cc}\\u2028\\u2029\\u202A-\\u202E\\u2066-\\u2069]', 'u');

/** Derives the screen name from the uploaded file name. Strips only a trailing ".png"; no trimming or normalization. */
export function parseScreenName(originalName: string | undefined): string {
    const name = (originalName ?? '').replace(/\.png$/i, '');
    if (!name) throw new HttpBadRequestError('Screen name must not be empty');
    if ([...name].length > MAX_SCREEN_NAME_LENGTH) {
        throw new HttpBadRequestError(`Screen name must be at most ${MAX_SCREEN_NAME_LENGTH} characters`);
    }
    if (FORBIDDEN_NAME_CHARS.test(name)) throw new HttpBadRequestError('Screen name contains forbidden characters');
    return name;
}

/** Validates the PNG signature and IHDR chunk of a file on disk (without decoding it) and returns the dimensions. */
export async function readPngHeader(path: string, maxPixels: number): Promise<{ width: number; height: number }> {
    const header = Buffer.alloc(PNG_HEADER_LENGTH);
    const fh = await open(path, 'r');
    let bytesRead: number;
    try {
        ({ bytesRead } = await fh.read(header, 0, PNG_HEADER_LENGTH, 0));
    } finally {
        await fh.close();
    }

    if (bytesRead < PNG_HEADER_LENGTH || !header.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new HttpBadRequestError('Image is not a valid PNG');
    }
    if (header.readUInt32BE(8) !== 13 || header.toString('latin1', 12, 16) !== 'IHDR') {
        throw new HttpBadRequestError('Image has an invalid PNG header');
    }
    if (crc32(header.subarray(12, 29)) !== header.readUInt32BE(29)) {
        throw new HttpBadRequestError('Image has a corrupt PNG header');
    }

    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    if (width < 1 || height < 1) throw new HttpBadRequestError('Image has invalid dimensions');
    if (header[26] !== 0 || header[27] !== 0) throw new HttpBadRequestError('Image has an invalid PNG header');
    if (width * height > maxPixels) {
        throw new HttpBadRequestError(`Image is too large (${width}x${height}); the maximum is ${maxPixels} pixels`);
    }
    return { width, height };
}
