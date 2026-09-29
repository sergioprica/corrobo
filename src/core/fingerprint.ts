import type { EffectContract } from "./types";

/**
 * Deterministic canonicalization of an intent: exactly what JSON persistence would keep, with
 * object keys recursively sorted (array order is preserved — it's meaningful). Two intents that
 * differ only in property order fingerprint identically, and an intent fingerprints the same
 * before and after a JSON round trip through a store (a Date and its persisted ISO string match).
 *
 * Values JSON would silently lose or mangle are rejected with a TypeError instead of being
 * fingerprinted — otherwise two different intents could bind as "the same operation" (two
 * different Maps both serialize to `{}`), or the same intent could stop matching itself after
 * persistence: circular references, functions, symbols, BigInts, Maps, Sets and weak
 * collections. `toJSON()` is honored (Dates become ISO strings); `undefined` object properties
 * are omitted and `undefined`/non-finite numbers in arrays become null, as JSON does.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(normalize(value, "intent", new Set()));
}

function normalize(value: unknown, path: string, ancestors: Set<object>): unknown {
  if (value !== null && typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function") {
    value = (value as { toJSON: (key: string) => unknown }).toJSON("");
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "undefined":
      return undefined;
    case "function":
    case "symbol":
    case "bigint":
      throw notSerializable(path, `a ${typeof value}`);
  }
  if (value === null) return null;
  const obj = value as object;
  if (obj instanceof Map || obj instanceof Set || obj instanceof WeakMap || obj instanceof WeakSet) {
    throw notSerializable(path, `a ${obj.constructor.name}`);
  }
  if (ancestors.has(obj)) {
    throw notSerializable(path, "a circular reference");
  }
  ancestors.add(obj);
  try {
    if (Array.isArray(obj)) {
      return obj.map((item, i) => {
        const normalized = normalize(item, `${path}[${i}]`, ancestors);
        return normalized === undefined ? null : normalized;
      });
    }
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const normalized = normalize((obj as Record<string, unknown>)[key], `${path}.${key}`, ancestors);
      if (normalized !== undefined) sorted[key] = normalized;
    }
    return sorted;
  } finally {
    ancestors.delete(obj);
  }
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
