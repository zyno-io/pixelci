/** Map-based LRU cache with per-entry TTL; the least recently used entry is evicted when `size > max`. */
export class BoundedTtlCache<V> {
    private entries = new Map<string, { value: V; expiresAt: number }>();

    constructor(
        private readonly max: number,
        private readonly defaultTtlMs: number = Infinity
    ) {}

    get size(): number {
        return this.entries.size;
    }

    get(key: string): V | undefined {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt <= Date.now()) {
            this.entries.delete(key);
            return undefined;
        }
        // refresh recency
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }

    set(key: string, value: V, ttlMs: number = this.defaultTtlMs): void {
        this.entries.delete(key);
        this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
        while (this.entries.size > this.max) {
            const oldest = this.entries.keys().next().value as string;
            this.entries.delete(oldest);
        }
    }

    delete(key: string): boolean {
        return this.entries.delete(key);
    }

    clear(): void {
        this.entries.clear();
    }
}
