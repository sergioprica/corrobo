import type { EffectContract } from "./types";

/**
 * Deterministic canonicalization of an intent: exactly what JSON persistence keeps, with object
 * keys recursively sorted (array order is preserved — it's meaningful). Two intents that differ
 * only in property order fingerprint identically, and an intent fingerprints the same before and
 * after a JSON round trip through a store — by construction, because the fingerprint is computed
 * from that round trip itself.
 *
 * So intents that JSON stores identically ARE the same intent here: `{ a: undefined }` and `{}`,
 * `NaN` and `null`, a `Date` and its ISO string. Values JSON would silently lose, mangle, or
 * store as something else are rejected with a TypeError naming the path instead: circular
 * references, functions, symbols, BigInts, Maps, Sets, weak collections, typed arrays,
 * ArrayBuffers and own getter properties (a getter can return something different on every
 * read). A value with its own `toJSON()`, like Date or Buffer, is judged by what it returns.
 */
export function canonicalStringify(value: unknown): string {
  assertJsonFaithful(value, "", "intent", new Set());
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw notSerializable("intent", "undefined");
  }
  return JSON.stringify(sortKeysDeep(JSON.parse(json)));
}

/** Walks the value the way JSON.stringify will (honoring toJSON with its real key) and rejects what it would mangle. */
function assertJsonFaithful(value: unknown, key: string, path: string, ancestors: Set<object>): void {
  if (value !== null && typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function") {
    value = (value as { toJSON: (key: string) => unknown }).toJSON(key);
  }
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw notSerializable(path, `a ${typeof value}`);
  }
  if (value === null || typeof value !== "object") return;
  if (
    value instanceof Map ||
    value instanceof Set ||
    value instanceof WeakMap ||
    value instanceof WeakSet ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  ) {
    throw notSerializable(path, `a ${value.constructor.name}`);
  }
  if (ancestors.has(value)) {
    throw notSerializable(path, "a circular reference");
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertJsonFaithful(item, String(i), `${path}[${i}]`, ancestors));
  } else {
    for (const k of Object.keys(value)) {
      if (Object.getOwnPropertyDescriptor(value, k)?.get) {
        // A getter can return something different on every read, so the intent that was
        // fingerprinted need not be the intent that gets stored.
        throw notSerializable(`${path}.${k}`, "a getter");
      }
      assertJsonFaithful((value as Record<string, unknown>)[k], k, `${path}.${k}`, ancestors);
    }
  }
  ancestors.delete(value);
}

/** Sorts keys of already-parsed JSON data. defineProperty so a "__proto__" key stays a plain key. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      Object.defineProperty(sorted, key, {
        value: sortKeysDeep((value as Record<string, unknown>)[key]),
        enumerable: true,
        writable: true,
        configurable: true
      });
    }
    return sorted;
  }
  return value;
}

function notSerializable(path: string, what: string): TypeError {
  return new TypeError(
    `corrobo: ${path} is ${what}, which can't be persisted faithfully as JSON. Operation intents must be ` +
      `plain JSON data (objects, arrays, strings, finite numbers, booleans, null; Dates are stored as ISO ` +
      `strings) — or provide fingerprintIntent() on the contract.`
  );
}

/**
 * Fingerprints an intent for reused-identity binding (see runtime.ts). Uses the contract's
 * own fingerprintIntent() when provided, otherwise the canonical-JSON default above.
 */
export function fingerprintIntent<Intent>(
  contract: Pick<EffectContract<Intent, unknown, unknown>, "fingerprintIntent">,
  intent: Intent
): string {
  if (contract.fingerprintIntent) {
    return contract.fingerprintIntent(intent);
  }
  return canonicalStringify(intent);
}
