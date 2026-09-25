import type { ServiceErrorDTO } from './schema.ts';

const messages: Record<ServiceErrorDTO['code'], string> = {
  invalid_input: 'The operation input is invalid.',
  source_changed: 'GitHub has newer notification activity. No acknowledgement was sent. Refresh and confirm a new operation; the old retry keeps its original boundary.',
  invalid_output: 'The upstream response was invalid; saved work is unchanged.',
  missing_cli: 'Install the required gh or Copilot CLI and reopen the app.',
  authentication: 'Sign in to the required GitHub CLI or Copilot CLI, then retry.',
  missing_scope: 'GitHub needs classic notifications or repo scope; private evidence needs repo and team membership needs read:org.',
  access: 'GitHub denied access. Check repository access and organization SSO authorization.',
  rate_limit: 'GitHub rate-limited this operation. Retry later.',
  unavailable: 'The service could not reach the upstream provider.',
  deadline: 'The operation timed out. An external write may have reached GitHub; retry explicitly.',
  cancelled: 'The operation was cancelled. An external write may have reached GitHub; no success is assumed.',
  busy: 'The service is busy. Retry when the current operation finishes.',
  protocol: 'Invalid service protocol frame.',
  limit: 'The operation exceeded the service safety limit.',
  unsupported: 'This GitHub source or requested action is not supported by this version.',
  copilot_unavailable: 'Copilot is unavailable. Check CLI sign-in, subscription, and runtime compatibility.',
  copilot_output: 'Copilot returned an invalid or ungrounded preview. No suggestions were applied.',
  internal: 'The service failed. Saved local work is unchanged.',
  mcp_configuration: 'The selected MCP connection or explicit read tools are unavailable. App connections are not shared automatically. Configure the Copilot CLI mcp-config.json or backend COPILOT_MCP_CONFIG_PATH.',
  mcp_unavailable: 'The selected MCP read or OAuth authentication failed. Authenticate that connection through supported Copilot CLI MCP setup, then retry with explicit read tools. App sign-in may not be shared.',
  assessment_storage: 'The assessment cache is unavailable or corrupt. The previous order is retained; repair local storage before retrying.',
  assessment_capacity: 'The assessment cache reached its storage limit. The previous order is retained; free assessment cache storage before retrying.',
  assessment_required: 'Current saved assessments are required. Use Run assessor for unassessed tasks or Assess selected to refresh saved assessments. The previous order is retained.',
};
export class ServiceError extends Error {
  readonly dto: ServiceErrorDTO;
  constructor(code: ServiceErrorDTO['code'], retryable = false, context: 'general' | 'read' = 'general') {
    const message = context === 'read' && code === 'source_changed'
      ? 'The source or repository revision changed during the read-only operation. No current review was returned; retry explicitly.'
      : context === 'read' && (code === 'deadline' || code === 'cancelled')
      ? `The read-only operation ${code === 'deadline' ? 'timed out' : 'was cancelled'}. Saved local work is unchanged; retry explicitly.`
      : messages[code];
    super(message);
    this.dto = { code, message, retryable };
  }
}
export function sanitized(error: unknown): ServiceErrorDTO {
  return error instanceof ServiceError ? error.dto : new ServiceError('internal').dto;
}
export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof ServiceError ? signal.reason : new ServiceError('cancelled');
}
