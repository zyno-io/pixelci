import { TestingHelpers } from '@zyno-io/ts-server-foundation';

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
