/** In-process gate: authenticated account/project tools require a successful spala_start first. */
const startedSubjects = new Map<string, number>();
const GATE_TTL_MS = 12 * 60 * 60 * 1000;

const GATED_TOOLS = new Set([
  'account_status',
  'account_setup',
  'organization_create',
  'project_list',
  'project_create',
  'project_connect',
  'project_select',
  'project_get_mcp_manifest',
  'project_get_public_context',
]);

export function markSpalaStartCompleted(subject: string, at = Date.now()): void {
  startedSubjects.set(subject, at);
}

export function clearSpalaStartGate(subject: string): void {
  startedSubjects.delete(subject);
}

export function hasCompletedSpalaStart(subject: string, now = Date.now()): boolean {
  const at = startedSubjects.get(subject);
  if (at == null) return false;
  if (now - at > GATE_TTL_MS) {
    startedSubjects.delete(subject);
    return false;
  }
  return true;
}

export function isStartupGatedTool(tool: string): boolean {
  return GATED_TOOLS.has(tool);
}

export function startupGateError(tool: string) {
  return {
    error: 'spala_start_required',
    tool,
    message: `Call spala_start as the first protected tool before ${tool}. spala_start absorbs account readiness and organization/project discovery; follow only its nextAction.`,
    nextAction: {
      tool: 'spala_start',
      reason: 'Complete authenticated startup before other account or project tools.',
    },
  };
}

export const STARTUP_GATED_TOOLS = [...GATED_TOOLS];
