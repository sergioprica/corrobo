import type { EffectContract } from "./types";

/**
 * Deterministic canonicalization of an intent: exactly what JSON persistence keeps, with object
 * keys recursively sorted (array order is preserved — it's meaningful). Two intents that differ
 * only in property order fingerprint identically, and an intent fingerprints the same before and
 * after a JSON round trip through a store — by construction, because the fingerprint is computed
 * from the stored form itself (see materializeIntent).
 *
 * So intents that JSON stores identically ARE the same intent here: `{ a: undefined }` and `{}`,
 * `NaN` and `null`, a `Date` and its ISO string.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(materializeIntent(value)));
}

/**
 * The stored form of an intent: the result of reading it exactly once through JSON semantics
 * (`toJSON()` applied with its real key), as plain data. runEffect persists this value and
 * fingerprints this value, so what was fingerprinted is what was stored, even if the original
 * object would read differently a second time.
 *
 * Values JSON would silently lose, mangle, or store as something else are rejected with a
 * TypeError naming the path: circular references, functions, symbols, BigInts, Maps, Sets, weak
 * collections, typed arrays, ArrayBuffers, own getter properties, and `undefined` as the whole
 * intent. A value with its own `toJSON()`, like Date or Buffer, is judged by what it returns.
 */
export function materializeIntent(value: unknown): unknown {
  const parentOf = new Map<object, object>();
  const pathOf = new Map<object, string>();
  let root: object | null = null;

  const json = JSON.stringify(value, function (this: object, key: string, v: unknown) {
    // `this` is the object holding `key`; JSON.stringify has already applied toJSON to `v`.
    let path: string;
    if (root === null) {
      root = this;
      path = "intent";
    } else {
      const holderPath = pathOf.get(this) ?? "intent";
      path = Array.isArray(this) ? `${holderPath}[${key}]` : `${holderPath}.${key}`;
      if (Object.getOwnPropertyDescriptor(this, key)?.get) {
        // A getter can return something different on every read.
        throw notSerializable(path, "a getter");
      }
    }
    if (typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") {
      throw notSerializable(path, `a ${typeof v}`);
    }
    if (v === null || typeof v !== "object") return v;
    if (
      v instanceof Map ||
      v instanceof Set ||
      v instanceof WeakMap ||
      v instanceof WeakSet ||
      v instanceof ArrayBuffer ||
      ArrayBuffer.isView(v)
    ) {
      throw notSerializable(path, `a ${v.constructor.name}`);
    }
    for (let holder: object | undefined = this; holder && holder !== root; holder = parentOf.get(holder)) {
      if (holder === v) throw notSerializable(path, "a circular reference");
    }
    parentOf.set(v, this);
    pathOf.set(v, path);
    return v;
  });
  if (json === undefined) {
    throw notSerializable("intent", "undefined");
  }
  return JSON.parse(json);
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
