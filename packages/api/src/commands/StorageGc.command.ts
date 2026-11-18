import { cli, resetMutexRedisConnection } from '@zyno-io/ts-server-foundation';

import { Db } from '../database';
import { createGcContext, StorageGcService } from '../services/storage/StorageGc.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

@cli.command('storage:gc', {
    description:
        'Run one storage cleanup pass now and print its stats as JSON. Usage: [dry-run|delete] [appId]. Defaults to dry-run, whatever STORAGE_GC_MODE says; sweeps every app (or just appId) to the end.'
})
export class StorageGcCommand {
    constructor(
        private db: Db,
        private gc: StorageGcService
    ) {}

    async execute(args: unknown[] = []) {
        try {
            await this.run(args.map(String));
        } finally {
            // Release the pool so the process exits now instead of when idle connections time out.
            await this.db.driver.close();
            resetMutexRedisConnection(); // the lock's Redis connection would keep the process alive
        }
    }

    private async run([modeArg, appId]: string[]) {
        const mode = modeArg ?? 'dry-run';
        if ((mode !== 'dry-run' && mode !== 'delete') || (appId !== undefined && !UUID_RE.test(appId))) {
            console.error('Usage: node . storage:gc [dry-run|delete] [appId]');
            process.exitCode = 1;
            return;
        }
        const settings = this.gc.getSettings();
        // Runs to the end: no time budget. Unknown-app prefixes are only deleted when the setting says so, as in the hourly job.
        const ctx = createGcContext(settings, { mode, deadlineAt: Infinity, force: true });
        const ran = await this.gc.withLock(async () => {
            await this.gc.run(ctx, { appIdFilter: appId });
        });
        if (!ran) {
            console.error('Another storage cleanup is running (it holds the lock); try again when it has finished.');
            process.exitCode = 1;
            return;
        }
        console.log(JSON.stringify({ mode, appId: appId ?? null, ...ctx.stats }, null, 2));
    }
}
