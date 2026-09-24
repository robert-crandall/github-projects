import type { Row } from '../types.ts';

export type Destination = { row: Row; kind: 'github' | 'copilot' | 'notification'; action?: 'done' | 'unsubscribe'; retryId?: string };
