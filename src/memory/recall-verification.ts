import type { RecallHit } from '../types.js'

/**
 * Bounded in-process ledger of memory ids that a recall actually returned.
 * The settings page uses it to distinguish "indexed" (write confirmed) from
 * "recall-verified" (the record came back from retrieval at least once).
 */
export class RecallVerificationLedger {
  private readonly capacity: number
  private readonly ids = new Set<string>()

  constructor(capacity = 500) {
    this.capacity = capacity
  }

  record(hits: readonly RecallHit[]): void {
    for (const hit of hits) {
      const id = hit.record.id.trim()
      if (id === '') continue
      if (this.ids.has(id)) continue
      this.ids.add(id)
      if (this.ids.size > this.capacity) {
        const oldest = this.ids.values().next().value
        if (oldest !== undefined) this.ids.delete(oldest)
      }
    }
  }

  has(id: string): boolean {
    return this.ids.has(id)
  }

  snapshot(): readonly string[] {
    return [...this.ids]
  }
}
