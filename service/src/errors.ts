import type { ServiceErrorDTO } from './schema.ts';

const messages: Record<ServiceErrorDTO['code'], string> = {
  invalid_input: 'The operation input is invalid.',
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
  unsupported: 'This GitHub source is not supported by this version.',
  copilot_unavailable: 'Copilot is unavailable. Check CLI sign-in, subscription, and runtime compatibility.',
  copilot_output: 'Copilot returned an invalid or ungrounded preview. No suggestions were applied.',
  internal: 'The service failed. Saved local work is unchanged.',
};
export class ServiceError extends Error {
  readonly dto: ServiceErrorDTO;
  constructor(code: ServiceErrorDTO['code'], retryable = false) {
    super(messages[code]);
    this.dto = { code, message: messages[code], retryable };
  }
}
export function sanitized(error: unknown): ServiceErrorDTO {
  return error instanceof ServiceError ? error.dto : new ServiceError('internal').dto;
}
export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof ServiceError ? signal.reason : new ServiceError('cancelled');
}
