/**
 * Every Cognee network path and MCP tool name lives here.
 *
 * IMPORTANT: no Cognee 1.6 API documentation is archived in this repository and
 * no Cognee server has been contacted. These values are UNVERIFIED. Phase 2
 * must replace them only after capturing evidence from the target deployment.
 * There is deliberately no dataset-delete path: `forget` must never substitute
 * a destructive dataset operation for a per-memory operation.
 */

export const COGNEE_API_VERIFICATION = Object.freeze({
  verified: false,
  source: 'no Cognee API docs archived in this repository; no server contacted',
  note:
    'Cognee 1.6 REST paths and MCP tool names are UNVERIFIED. Confirm against the ' +
    'target deployment before enabling live use. All paths are isolated here.',
})

export const COGNEE_PATHS = Object.freeze({
  health: '/health',
  add: '/api/v1/add',
  search: '/api/v1/search',
  datasets: '/api/v1/datasets',
  delete: '/api/v1/delete',
  prune: '/api/v1/prune',
})

export const COGNEE_MCP_TOOLS = Object.freeze({
  remember: 'cognee_remember',
  recall: 'cognee_recall',
  forget: 'cognee_forget',
  status: 'cognee_status',
})

export type CogneeRestPath = keyof typeof COGNEE_PATHS
export type CogneeMcpTool = keyof typeof COGNEE_MCP_TOOLS
