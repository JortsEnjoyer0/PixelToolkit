/** Recursively Object.freeze plain objects and arrays (dev guard for immutable document state). Returns the input. */
export function deepFreeze<T>(value: T): T {
  // Typed arrays cannot be frozen (Object.freeze throws on ArrayBuffer views with elements)
  if (value === null || typeof value !== 'object' || Object.isFrozen(value) || ArrayBuffer.isView(value))
    return value;
  Object.freeze(value);
  for (const v of Object.values(value as object))
    deepFreeze(v);
  return value;
}
