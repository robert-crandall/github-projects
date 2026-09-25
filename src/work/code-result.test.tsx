import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { codeResult } from '../../tests/code-run-fixture.ts';
import { codeRunSchema } from '../../service/src/code-runs.ts';
import { emptyWorkspace } from '../domain/live.ts';
import { createNativePlatform, snapshotSchema } from '../platform/native.ts';
import { DesktopWorkspace } from '../runtime/desktop-workspace.ts';
import { CodeRunResult } from './CodeSessionPanel.tsx';

test('empty PR findings always render service-owned conclusion and partial coverage; Markdown never loads images', async () => {
  const now = new Date().toISOString(), state = emptyWorkspace(now,'UTC');
  const controller = new DesktopWorkspace(createNativePlatform(async command => {
    if (command === 'workspace_read') return {
      revision: crypto.randomUUID(), savedAt: now,
      snapshot: snapshotSchema.parse({formatVersion:1,reminders:[],workspace:{version:1,state,scroll:{}}}),
    };
    if (command === 'clock_now') return { now, timeZone:'UTC',error:null };
    throw new Error(`Unexpected ${command}`);
  }));
  await controller.load();
  for (const inspected of [false,true]) {
    const input = {taskId:'task',source:{repo:'octo/project',kind:'pr' as const,number:48},job:'pr-review' as const,agent:{id:'reviewer',instructions:'',model:''}};
    const result = codeResult(input,inspected);
    const run = codeRunSchema.parse({
      generation:crypto.randomUUID(),sequence:1,quarantined:false,
      intent:{runId:crypto.randomUUID(),profileId:'default',agentName:'Reviewer',startedAt:now,input},
      outcome:{status:inspected?'partial':'not-inspected',finishedAt:now,result},
    });
    const html = renderToStaticMarkup(<CodeRunResult run={run} controller={controller} />);
    expect(html).toContain(inspected ? 'Partial code inspection only. This is not an approval to merge.'
      : 'No source-code lines were inspected. No code review or approval was completed.');
    expect(html).toContain('Partial coverage: bounded, selective inspection, not a comprehensive review.');
    expect(html).toContain('No grounded findings returned. This is not approval');
    expect(html).not.toContain('<img');
  }
  const input = {taskId:'task',source:{repo:'octo/project',kind:'issue' as const,number:47},job:'implementation-assessment' as const,agent:{id:'implementation-assessment',instructions:'',model:''}};
  const result = codeResult(input);
  if (result.answer.job !== 'implementation-assessment') throw new Error('Expected implementation answer');
  result.answer.summary = '![tracking](https://example.com/pixel.png)<script>alert(1)</script>[unsafe](javascript:alert(1))';
  const run = codeRunSchema.parse({
    generation:crypto.randomUUID(),sequence:1,quarantined:false,
    intent:{runId:crypto.randomUUID(),profileId:'default',agentName:'Assessor',startedAt:now,input},
    outcome:{status:'partial',finishedAt:now,result},
  });
  const html = renderToStaticMarkup(<CodeRunResult run={run} controller={controller} />);
  expect(html).not.toContain('<img');
  expect(html).not.toContain('<script');
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain('Image not loaded');
});
