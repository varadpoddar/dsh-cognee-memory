import { MemoryError } from '../errors.js'
import type { CogneeMemoryConfig } from '../config/schema.js'
import { legacyScopeKey, scopeKey } from '../memory/scopes.js'
import type { ScopeRef } from '../types.js'
import { COGNEE_PATHS } from './cognee-paths.js'
import { isRecord, pickString } from './cognee-response.js'
import type { HttpJsonClient } from './http-client.js'

export interface CogneeDataset {
  readonly id: string
  readonly name: string
  readonly ownerId?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID.test(value)
}

export function parseDataset(value: unknown): CogneeDataset | undefined {
  if (!isRecord(value)) return undefined
  const id = pickString(value, ['id', 'dataset_id', 'datasetId'])
  const name = pickString(value, ['name', 'dataset_name', 'datasetName'])
  if (id === undefined || name === undefined || !isUuid(id)) return undefined
  const ownerId = pickString(value, ['ownerId', 'owner_id'])
  return ownerId === undefined ? { id, name } : { id, name, ownerId }
}

export function parseDatasetList(value: unknown): CogneeDataset[] {
  const rows = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.data)
      ? value.data
      : isRecord(value) && Array.isArray(value.datasets)
        ? value.datasets
        : []
  const parsed: CogneeDataset[] = []
  for (const row of rows) {
    const dataset = parseDataset(row)
    if (dataset !== undefined) parsed.push(dataset)
  }
  return parsed
}

interface RegistryOptions {
  readonly client: HttpJsonClient
  readonly config: CogneeMemoryConfig
  readonly now?: () => number
}

/**
 * Maps DSH scope keys to Cognee dataset UUIDs.
 *
 * Observed live behaviour that this class exists to guard against:
 *  - `POST /add` (and `/remember`) with a `datasetName` the caller does not own
 *    silently creates a NEW dataset with the same name instead of failing.
 *  - Name lookups only resolve datasets the caller owns; shared datasets must be
 *    addressed by UUID.
 * Therefore every write resolves the dataset first (create-if-missing under our
 * own user), verifies `ownerId`, and passes `datasetId` — never a name only.
 */
export class DatasetRegistry {
  private readonly client: HttpJsonClient
  private readonly now: () => number
  private readonly cacheMs: number
  private readonly byName = new Map<string, { dataset: CogneeDataset; fetchedAt: number }>()
  private meId: string | undefined

  constructor(options: RegistryOptions) {
    this.client = options.client
    this.now = options.now ?? Date.now
    this.cacheMs = 60_000
  }

  /** Drop cached ids, e.g. after a write reports NOT_FOUND/FORBIDDEN. */
  invalidate(): void {
    this.byName.clear()
  }

  /** The Cognee user id behind the API key; used for the ownership check. */
  async currentUserId(signal?: AbortSignal): Promise<string | undefined> {
    if (this.meId !== undefined) return this.meId
    const response = await this.client.requestJson<unknown>({
      method: 'GET',
      path: COGNEE_PATHS.whoami,
      operation: 'whoami',
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: 5_000,
    })
    if (isRecord(response)) this.meId = pickString(response, ['id', 'user_id', 'userId'])
    return this.meId
  }

  /** Look up an existing dataset for a scope without creating anything. */
  async lookup(scope: ScopeRef, signal?: AbortSignal): Promise<CogneeDataset | undefined> {
    return this.lookupByName(scopeKey(scope), true, signal)
  }

  /**
   * Read-only M1 dataset lookup. Namespaces changed in Milestone 2, but the
   * verified fixture and any earlier memories remain readable; new writes
   * always target the current namespace.
   */
  async lookupLegacy(scope: ScopeRef, signal?: AbortSignal): Promise<CogneeDataset | undefined> {
    const legacy = legacyScopeKey(scope)
    if (legacy === undefined || legacy === scopeKey(scope)) return undefined
    return this.lookupByName(legacy, false, signal)
  }

  private async lookupByName(
    name: string,
    assertOwner: boolean,
    signal?: AbortSignal,
  ): Promise<CogneeDataset | undefined> {
    const cached = this.byName.get(name)
    if (cached !== undefined && this.now() - cached.fetchedAt < this.cacheMs) return cached.dataset
    const listed = (await this.list(signal)).find((dataset) => dataset.name === name)
    if (listed === undefined) return undefined
    if (assertOwner) await this.assertOwned(listed, signal)
    this.byName.set(name, { dataset: listed, fetchedAt: this.now() })
    return listed
  }

  /** Resolve a scope's dataset, creating it under the API-key user when missing. */
  async ensure(scope: ScopeRef, signal?: AbortSignal): Promise<CogneeDataset> {
    const existing = await this.lookup(scope, signal)
    if (existing !== undefined) return existing
    const response = await this.client.requestJson<unknown>({
      method: 'POST',
      path: COGNEE_PATHS.datasets,
      operation: 'dataset.create',
      body: { name: scopeKey(scope) },
      ...(signal === undefined ? {} : { signal }),
    })
    const created = parseDataset(response)
    if (created === undefined) {
      throw new MemoryError('BACKEND', 'Cognee did not return a dataset id for the created dataset')
    }
    await this.assertNotForeign(scopeKey(scope), created)
    this.byName.set(created.name, { dataset: created, fetchedAt: this.now() })
    return created
  }

  private async list(signal?: AbortSignal): Promise<CogneeDataset[]> {
    const response = await this.client.requestJson<unknown>({
      method: 'GET',
      path: COGNEE_PATHS.datasets,
      operation: 'datasets.list',
      ...(signal === undefined ? {} : { signal }),
    })
    return parseDatasetList(response)
  }

  private async assertOwned(dataset: CogneeDataset, signal?: AbortSignal): Promise<void> {
    await this.assertNotForeign(dataset.name, dataset, signal)
  }

  private async assertNotForeign(
    name: string,
    dataset: CogneeDataset,
    signal?: AbortSignal,
  ): Promise<void> {
    if (dataset.ownerId === undefined) return
    const meId = await this.currentUserId(signal)
    if (meId === undefined || meId === dataset.ownerId) return
    throw new MemoryError('FORBIDDEN', `dataset ${name} is owned by another Cognee user`, {
      retryable: false,
      details: { dataset: name, ownerId: dataset.ownerId },
    })
  }
}
