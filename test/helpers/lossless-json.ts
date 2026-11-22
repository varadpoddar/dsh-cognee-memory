/**
 * Mirror of DSH's tool-output contract: a value crosses the tool boundary only
 * if it is lossless JSON. DSH rejects objects whose own keys are not all
 * enumerable string keys, non-plain prototypes, cycles, non-finite numbers and
 * `-0`. Reproduced here so a regression fails in unit tests, not on the host.
 */
export interface LosslessResult {
  readonly ok: boolean
  readonly path?: string
  readonly reason?: string
}

export function checkLosslessJson(value: unknown): LosslessResult {
  const ancestors = new Set<object>()

  const visit = (current: unknown, path: string): LosslessResult => {
    if (current === null) return { ok: true }
    if (typeof current === 'boolean' || typeof current === 'string') return { ok: true }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return { ok: false, path, reason: 'non-finite number' }
      if (Object.is(current, -0)) return { ok: false, path, reason: 'negative zero' }
      return { ok: true }
    }
    if (typeof current !== 'object') return { ok: false, path, reason: `non-JSON type ${typeof current}` }
    const object = current as object
    if (ancestors.has(object)) return { ok: false, path, reason: 'cycle' }
    ancestors.add(object)
    try {
      if (Array.isArray(object)) {
        if (Object.getPrototypeOf(object) !== Array.prototype) {
          return { ok: false, path, reason: 'array subclass' }
        }
        if (Reflect.ownKeys(object).length !== object.length + 1) {
          return { ok: false, path, reason: 'array has non-index own keys' }
        }
        for (let index = 0; index < object.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(object, index)) {
            return { ok: false, path: `${path}[${index}]`, reason: 'sparse array' }
          }
          const result = visit(object[index], `${path}[${index}]`)
          if (!result.ok) return result
        }
        return { ok: true }
      }
      const prototype = Object.getPrototypeOf(object)
      if (prototype !== null && prototype !== Object.prototype) {
        const name =
          (prototype as { constructor?: { name?: string } }).constructor?.name ?? 'unknown'
        return { ok: false, path, reason: `non-plain prototype ${name}` }
      }
      for (const key of Reflect.ownKeys(object)) {
        if (typeof key !== 'string') return { ok: false, path, reason: 'symbol key' }
        if (!Object.prototype.propertyIsEnumerable.call(object, key)) {
          return { ok: false, path: `${path}.${key}`, reason: 'non-enumerable own key' }
        }
        const result = visit((object as Record<string, unknown>)[key], `${path}.${key}`)
        if (!result.ok) return result
      }
      return { ok: true }
    } finally {
      ancestors.delete(object)
    }
  }

  return visit(value, 'value')
}

/** Deep equality after a JSON round trip, which is what "lossless" means. */
export function survivesJsonRoundTrip(value: unknown): boolean {
  const roundTripped: unknown = JSON.parse(JSON.stringify(value))
  return JSON.stringify(roundTripped) === JSON.stringify(value)
}
