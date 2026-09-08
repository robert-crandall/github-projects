import type { AppState, Step, WorkItem } from './types.ts';

export const INITIAL_CLOCK = '2026-09-08T09:40:00.000Z';
export const SAMPLE_IDS = new Set([
  'direct-review', 'team-review', 'ci-fix', 'mention', 'manual-task',
  'daily-routine', 'deferred-task', 'waiting-task', 'new-review',
]);

export function routineSteps(): Step[] {
  return [
    { id: 'announce', title: 'Announce change' },
    { id: 'increase', title: 'Increase flag' },
  ];
}

function sample(id: string, title: string, kind: WorkItem['kind']): WorkItem {
  return {
    id, title, kind, status: 'available', createdAt: INITIAL_CLOCK,
    updatedAt: INITIAL_CLOCK, sources: [], notes: '', steps: [], nextStep: title,
  };
}

export function arrivalReview(clock: string): WorkItem {
  return {
    ...sample('new-review', 'Review the timeout guard', 'review'),
    createdAt: clock, updatedAt: clock,
    sources: [{
      id: 'sample-arrival', kind: 'github', label: 'Synthetic · harbor#43',
      reference: 'demo://github/harbor/pull/43',
    }],
    review: { identity: 'demo://github/harbor/pull/43', request: 'direct', lines: 12, files: 1 },
    evidence: 'Synthetic fixture · 12 changed lines across 1 file; directly requested.',
  };
}

export function createInitialState(): AppState {
  return {
    version: 1,
    clock: INITIAL_CLOCK,
    draft: '',
    captures: [],
    undo: [],
    interpretationError: false,
    sync: { status: 'ok', lastSuccessAt: INITIAL_CLOCK },
    projects: [{
      id: 'rollout', name: 'Safer rollouts',
      notes: 'Synthetic project context. Announce changes before increasing the flag.',
    }],
    items: [
      {
        ...sample('direct-review', 'Review the retry backoff fix', 'review'),
        updatedAt: '2026-09-08T09:12:00.000Z',
        sources: [{
          id: 'sample-direct', kind: 'github', label: 'Synthetic · harbor#42',
          reference: 'demo://github/harbor/pull/42',
        }],
        review: { identity: 'demo://github/harbor/pull/42', request: 'direct', lines: 18, files: 2 },
        evidence: 'Synthetic fixture · 18 changed lines across 2 files; directly requested.',
        nextStep: 'Read the diff and leave a review in your usual tool.',
      },
      {
        ...sample('team-review', 'Review the provider configuration fix', 'review'),
        updatedAt: '2026-09-08T08:30:00.000Z',
        sources: [{
          id: 'sample-team', kind: 'github', label: 'Synthetic · terraform-provider#87',
          reference: 'demo://github/terraform-provider/pull/87',
        }],
        review: {
          identity: 'demo://github/terraform-provider/pull/87', request: 'team',
          lines: 32, files: 3, team: 'integrations/terraform-provider-core-maintainers',
        },
        evidence: 'Synthetic fixture · 32 changed lines; requested from Terraform Provider Core Maintainers, not directly from you.',
      },
      {
        ...sample('ci-fix', 'Fix the failing checks on my PR', 'fix'),
        updatedAt: '2026-09-07T16:00:00.000Z',
        sources: [{
          id: 'sample-ci', kind: 'github', label: 'Synthetic · authored harbor#39',
          reference: 'demo://github/harbor/pull/39',
        }],
        evidence: 'Synthetic authored PR · CI failed; no conflict or review status inferred.',
        nextStep: 'Inspect the failing test output.',
        steps: [{ id: 'inspect', title: 'Inspect failing checks' }, { id: 'fix', title: 'Fix the failure' }],
        projectId: 'rollout',
      },
      {
        ...sample('mention', 'Check whether this mention needs a reply', 'mention'),
        updatedAt: '2026-09-07T12:00:00.000Z',
        sources: [{
          id: 'sample-mention', kind: 'github', label: 'Synthetic · harbor#36 mention',
          reference: 'demo://github/harbor/pull/36',
        }],
        evidence: 'Synthetic mention · may need a reply; not a confirmed request.',
        nextStep: 'Read the context before deciding whether a reply is needed.',
      },
      {
        ...sample('manual-task', 'Send the rollout notes to the team', 'task'),
        sources: [{ id: 'sample-capture', kind: 'capture', label: 'Synthetic manual capture' }],
        nextStep: 'Draft a short summary of the rollout.',
      },
      {
        ...sample('daily-routine', 'Daily feature-flag rollout', 'routine'),
        sources: [{ id: 'sample-routine', kind: 'routine', label: 'Synthetic · daily at 10:00 UTC' }],
        steps: routineSteps(),
        nextStep: 'Announce change',
        projectId: 'rollout',
        routine: { time: '10:00', nextDueAt: '2026-09-08T10:00:00.000Z', occurrences: [] },
      },
      {
        ...sample('deferred-task', 'Revisit the rollout checklist', 'task'),
        status: 'deferred', availableAt: '2026-09-10T09:00:00.000Z',
        reason: 'Intentionally saved for later; revisit after this rollout.',
        sources: [{ id: 'sample-deferred', kind: 'capture', label: 'Synthetic deferred task' }],
      },
      {
        ...sample('waiting-task', 'Confirm the rollout window', 'task'),
        status: 'waiting', reason: 'Waiting for the service owner to confirm the window.',
        sources: [{ id: 'sample-waiting', kind: 'capture', label: 'Synthetic waiting task' }],
        projectId: 'rollout',
      },
    ],
  };
}
