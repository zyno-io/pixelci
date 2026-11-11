import { createHash } from 'crypto';

import { AppError } from './error.js';

export interface IScreenManifest {
    count: number;
    hash: string;
}

/**
 * Must stay byte-for-byte identical to the server's `screenManifestHash`:
 * sha256hex of the names sorted with the default JS sort (UTF-16 code units), joined by "\n".
 */
export function screenManifestHash(names: readonly string[]): string {
    return createHash('sha256')
        .update([...names].sort().join('\n'))
        .digest('hex');
}

export function buildManifest(names: readonly string[]): IScreenManifest {
    return { count: names.length, hash: screenManifestHash(names) };
}

/**
 * Directory separators are flattened to " - ", so `a/b.png` and `a - b.png` would both become
 * `a - b`. The server keys screens by name, so such a pair can't be uploaded.
 */
export function assertUniqueNames(entries: readonly { name: string; file: string }[]): void {
    const seen = new Map<string, string>();
    for (const { name, file } of entries) {
        const prev = seen.get(name);
        if (prev !== undefined) {
            throw new AppError(`Screen name "${name}" is produced by more than one file ("${prev}" and "${file}"). Rename one of them.`);
        }
        seen.set(name, file);
    }
}
