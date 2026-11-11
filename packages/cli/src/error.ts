export class AppError extends Error {}

export function handleError(err: unknown): never {
    if (err instanceof AppError) {
        console.warn(err.message);
        process.exit(1);
    }

    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
}
