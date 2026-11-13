import { DatabaseSession } from '@zyno-io/ts-server-foundation';
import { createHash } from 'crypto';

import { BuildScreenEntity } from '../entities/BuildScreen.entity';
import { ScreenEntity } from '../entities/Screen.entity';

/**
 * sha256 (hex) of the screen names sorted by plain JS code-unit order and joined with `\n`. Names can't contain `\n`
 * (see parseScreenName). The CLI implements the identical function.
 */
export function screenManifestHash(names: string[]): string {
    return createHash('sha256')
        .update([...names].sort().join('\n'))
        .digest('hex');
}

/** Names of the screens uploaded to a build (join of builds_screens to screens). */
export async function uploadedScreenNames(session: DatabaseSession, buildId: string): Promise<string[]> {
    const rows = await session.query(BuildScreenEntity).filter({ buildId }).select('screenId').find();
    if (!rows.length) return [];
    const screens = await session
        .query(ScreenEntity)
        .filter({ id: { $in: rows.map(r => r.screenId) } })
        .select('name')
        .find();
    return screens.map(s => s.name);
}
