/**
 * Every Cognee network path and MCP tool name lives here.
 *
 * VERIFIED against the live instance on 2026-11-21 (Cognee `1.6.10-local`,
 * `http://10.20.10.15:8000`, Postgres+pgvector, ENABLE_BACKEND_ACCESS_CONTROL=true).
 * Each path below was exercised with a real `X-Api-Key` request; see
 * `docs/LIVE_INTEGRATION.md` for the captured request/response excerpts and
 * `test/live/cognee-live.test.ts` for the reproducible probe.
 *
 * There is deliberately no dataset-delete path: `forget` must never substitute
 * a destructive dataset operation for a per-memory operation. Dataset deletion
 * exists only in the live test's own cleanup code.
 */

export const COGNEE_API_VERIFICATION = Object.freeze({
  verified: true,
  source: 'live probes 2026-11-21 against Cognee 1.6.10-local at http://10.20.10.15:8000',
  version: '1.6.10-local',
  probes: Object.freeze([
    'GET /health -> 200 {"status":"ready","health":"healthy","version":"1.6.10-local"}',
    'GET /api/v1/users/me -> 200 {id,email,tenant_id,parent_user_id}',
    'GET|POST /api/v1/datasets -> [{id,name,createdAt,updatedAt,ownerId}]',
    'POST /api/v1/remember (multipart raw_data + datasetId) -> {status,dataset_id,pipeline_run_id,items:[{id}]}',
    'POST /api/v1/search (JSON query,searchType,datasetIds,topK) -> [{dataset_id,dataset_name,search_result:[...]}]',
    'POST /api/v1/forget (JSON datasetId,dataId) -> {status:"success",data_record_found,deleted_nodes,deleted_edges}',
    'GET /api/v1/datasets/status?dataset=&pipeline= -> {<uuid>:"DATASET_PROCESSING_COMPLETED"}',
    'GET /api/v1/datasets/status/memory?dataset= -> {<uuid>:{state,searchable,graph_ready,...}}',
    'GET /api/v1/datasets/{id}/processing-status -> {total,completed,pending,items:[{id,completed}]}',
    'GET /api/v1/datasets/{id}/data -> [{id,name,contentHash,...}] (contentHash = md5(raw text))',
  ]),
})

const DATASETS = '/api/v1/datasets'

/**
 * Fixed paths plus per-id path builders. The base URL is expected to already
 * end in `/api/v1` (the client resolves relative paths against it); `/health`
 * is origin-relative and is resolved separately by the adapter.
 */
export const COGNEE_PATHS = Object.freeze({
  health: '/health',
  whoami: '/api/v1/users/me',
  datasets: DATASETS,
  datasetData: (datasetId: string) => `${DATASETS}/${encodeURIComponent(datasetId)}/data`,
  datasetById: (datasetId: string) => `${DATASETS}/${encodeURIComponent(datasetId)}`,
  processingStatus: (datasetId: string) => `${DATASETS}/${encodeURIComponent(datasetId)}/processing-status`,
  pipelineStatus: `${DATASETS}/status`,
  memoryStatus: `${DATASETS}/status/memory`,
  add: '/api/v1/add',
  remember: '/api/v1/remember',
  search: '/api/v1/search',
  forget: '/api/v1/forget',
})

export const COGNEE_MCP_TOOLS = Object.freeze({
  remember: 'cognee_remember',
  recall: 'cognee_recall',
  forget: 'cognee_forget',
  status: 'cognee_status',
})

/** Status strings observed on the live instance, normalized to one predicate. */
export const COGNEE_PIPELINE_OK = Object.freeze([
  'completed',
  'pipelineruncompleted',
  'dataset_processing_completed',
])

export function isPipelineComplete(status: unknown): boolean {
  if (typeof status !== 'string') return false
  return COGNEE_PIPELINE_OK.includes(status.trim().toLowerCase())
}

export function isPipelineFailed(status: unknown): boolean {
  return typeof status === 'string' && /fail|error|cancel/i.test(status)
}

export type CogneeRestPath = keyof typeof COGNEE_PATHS
export type CogneeMcpTool = keyof typeof COGNEE_MCP_TOOLS
