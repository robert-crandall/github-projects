import { initialState } from './engine.ts';
import { legacyStateSchema, type LegacyAction, type LegacyState } from '../types.ts';

export function legacyFixture(desktop = false): LegacyState {
  const current = initialState('UTC');
  const history = (id: string, title: string, notes: string): LegacyAction => ({
    id, title, notes, eventIds: [], status: 'available', project: 'Original project', nextStep: 'Original next step',
    captures: [], steps: [{ id: `${id}-step`, title: 'Original step', doneAt: current.clock }],
    origin: 'github', createdAt: current.clock, interpretation: 'none',
  });
  const linked = { threadId: current.threads[0]!.id, eventIds: [current.threads[0]!.events[0]!.id] };
  return legacyStateSchema.parse({
    ...current, version: 2, runtime: desktop ? 'desktop' : 'demo', view: 'attention', activeId: 'generated-1',
    threads: current.threads.map(thread => desktop ? { ...thread, source: 'github' } : thread),
    actions: [
      { ...history('generated-1', 'My earlier title', 'First distinct annotation'), ...linked },
      { ...history('generated-2', 'A different follow-up', 'Second distinct annotation'), ...linked, status: 'done', completedAt: current.clock },
      { ...history('captured', 'My edited captured task', 'Captured thread annotation'), ...linked, origin: 'capture',
        captures: ['  Review https://github.com/octo/project/pull/1\nOriginal second line  '], status: 'done', completedAt: current.clock },
      { ...history('routine', 'Announce, then increase', 'Routine notes'), origin: 'capture', captures: ['Every day at 10am, announce, then increase'],
        routine: { time: '10:00', timeZone: 'UTC', dueAt: current.clock, nextDueAt: '2026-09-12T10:00:00Z',
          history: [{ dueAt: current.clock, status: 'done', steps: [{ id: 'old', title: 'Historic step', doneAt: current.clock }] }] } },
    ],
    failures: { ...current.failures, interpretation: false }, undo: [],
  });
}
