import { AsyncLocalStorage } from "node:async_hooks";

interface ReadScope {
  active: boolean;
  bytes: number;
  values: Map<string, string>;
}
const scopes = new AsyncLocalStorage<ReadScope | undefined>();
const MAX_ENTRIES = 256;
const MAX_BYTES = 1024 * 1024;

/** A status response observes values once. Nothing survives its request or authorizes a write. */
export async function withStatusReadScope<T>(read: () => Promise<T>): Promise<T> {
  const scope: ReadScope = { active: true, bytes: 0, values: new Map() };
  return scopes.run(scope, async () => {
    try { return await read(); }
    finally { scope.active = false; scope.values.clear(); scope.bytes = 0; }
  });
}

/** Nested mutating tool calls must not inherit a parent's read-only observations. */
export function withoutStatusReads<T>(operation: () => T): T {
  return scopes.run(undefined, operation);
}

export function invalidateStatusReads(): void {
  const scope = scopes.getStore();
  if (scope) { scope.values.clear(); scope.bytes = 0; }
}

/** Only successful, bounded strings from explicitly read-only operations are memoized. */
export function observeStatusRead(key: string, read: () => string): string {
  const scope = scopes.getStore();
  if (!scope?.active) return read();
  const cached = scope.values.get(key);
  if (cached !== undefined) return cached;
  const value = read();
  const bytes = Buffer.byteLength(key) + Buffer.byteLength(value);
  if (scope.values.size < MAX_ENTRIES && scope.bytes + bytes <= MAX_BYTES) {
    scope.values.set(key, value);
    scope.bytes += bytes;
  }
  return value;
}
