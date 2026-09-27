import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkQueueSnapshot } from './controller.ts';
import { RunProgress } from './RunProgress.tsx';
import { RunProgressPopover } from './RunProgressPopover.tsx';

function snapshot(patch: Partial<WorkQueueSnapshot> = {}): WorkQueueSnapshot {
  return {
    running: false, cancelRequested: false, phase: 'idle', error: '', warnings: [], unsubscribing: [],
    progress: { startedAt: 0, finishedAt: 1000, sources: [] }, ...patch,
  };
}
function render(run: WorkQueueSnapshot, details: string[] = [], error = run.error) {
  return renderToStaticMarkup(<RunProgressPopover run={run} details={details} error={error}
    profileName="Default" cancelAssessor={() => {}} />);
}

test('run activity is absent before any run and every available result starts collapsed', () => {
  expect(render(snapshot({ progress: null }))).toBe('');
  const html = render(snapshot());
  expect(html).toContain('aria-label="Run details: Run complete"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('task-run-popover-heading');
  expect(html).not.toContain('role="progressbar"');
  expect(html).not.toContain('task-run-spinner');
});

test('all active phases retain an activity indicator rather than claiming completion', () => {
  const labels: [WorkQueueSnapshot['phase'], string][] = [
    ['preparing', 'Preparing'], ['intake', 'Reading intake'], ['collecting', 'Collecting'],
    ['checking-assessments', 'Checking assessments'], ['refreshing-state', 'Checking GitHub'],
    ['assessing', 'Assessing'], ['ranking', 'Ranking'], ['saving', 'Saving'], ['cancelling', 'Cancelling'],
  ];
  for (const [phase, label] of labels) {
    const html = render(snapshot({ running: true, phase }));
    expect(html).toContain(`aria-label="Run details: ${label}"`);
    expect(html).toContain('task-run-spinner');
    expect(html).not.toContain('Run complete');
  }
});

test('inline progress announces phases by default but popover details can defer to their owner', () => {
  for (const [phase, label] of [
    ['assessing', 'Assessing tasks'], ['ranking', 'Ranking tasks'], ['saving', 'Saving results'], ['idle', 'Run complete'],
  ] as const) {
    const run = snapshot({ phase, running: phase !== 'idle', progress: {
      startedAt: 0, finishedAt: phase === 'idle' ? 1000 : null, sources: [], assessment: { total: 1, saved: 0, batches: 0 },
    } });
    const inline = renderToStaticMarkup(<RunProgress run={run} details={[]} cancelAssessor={() => {}} />);
    const owned = renderToStaticMarkup(<RunProgress run={run} details={[]} cancelAssessor={() => {}} announcePhase={false} />);
    expect(inline).toContain(`<span role="status">${label}</span>`);
    expect(owned).toContain(`<span>${label}</span>`);
    expect(owned).not.toContain(`<span role="status">${label}</span>`);
    expect(owned.match(/role="status"/g)).toHaveLength(2);
    expect(owned).toContain('aria-label="Assessments saved"');
    expect(owned).not.toContain('aria-hidden="true"');
  }
});

test('collapsed controls distinguish cancellation, coverage notes, partial coverage and errors after reload', () => {
  expect(render(snapshot({ phase: 'cancelled' }))).toContain('aria-label="Run details: Assessment cancelled"');
  expect(render(snapshot(), ['Older history remains.'])).toContain('aria-label="Run details: Coverage notes"');
  const progress = { startedAt: 0, finishedAt: 1000, sources: [
    { id: 'source', name: 'Source', state: 'failed' as const, diagnostics: ['Unavailable'] },
  ] };
  expect(render(snapshot({ progress }))).toContain('aria-label="Run details: Partial coverage · 1 failed"');
  expect(render(snapshot({ progress, running: true, phase: 'collecting' })))
    .toContain('aria-label="Run details: Collecting · 1 failed"');
  const failed = render(snapshot({ progress, phase: 'error', error: 'Ranking failed' }), ['Ranking failed']);
  expect(failed).toContain('aria-label="Run details: Run incomplete · 1 failed"');
  expect(failed).toContain('task-run-incomplete');
  expect(failed).not.toContain('task-run-spinner');
  const restored = render(snapshot({ progress: null }), ['Saved run failure'], 'Saved run failure');
  expect(restored).toContain('aria-label="Run details: Run incomplete"');
  expect(restored).not.toContain('Run complete');
});
