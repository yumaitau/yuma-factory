import { handleRunMcp } from '@/lib/run-mcp';

/** Live channel for a running agent: team memory and its epic thread, authenticated by a per-run token. */
export const GET = handleRunMcp;
export const POST = handleRunMcp;
