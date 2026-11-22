/** Types for the deterministic client-bundle builder, used by tests. */
export declare function stripExports(source: string): string
export declare function buildBundle(source: string): string
export declare function validateBundle(bundle: string): { apply: (ctx: unknown) => void; inject: string[] }
