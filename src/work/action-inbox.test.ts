import { describe, expect, test } from 'bun:test';
import { emptyWorkspace } from '../domain/live.ts';
import { reconcileWork, completeWorkTask } from './engine.ts';
import { defaultWorkState } from '../../service/src/work-schema.ts';
import { buildCopilotDispatchPrompt, defaultTemplateKind, guessProjectId } from './ActionInboxPanel.tsx';

describe('Action Inbox reconciliation and prompt builder', () => {
  test('reconcileWork with reopenDone=false keeps completed tasks Done even when newer activity arrives, and preserves email metadata', () => {
    const initial = emptyWorkspace('2026-04-06T12:00:00Z', 'UTC');
    const collected = reconcileWork(initial, {
      collectedAt: '2026-04-06T12:00:00.000Z',
      candidates: [
        {
          title: 'Chase Alerts: Unexpected charge',
          action: 'follow-up',
          url: 'https://mail.google.com/mail/u/0/#inbox/thr_1',
          email: {
            messageId: 'msg_1',
            threadId: 'thr_1',
            from: 'Chase Alerts <alerts@chase.com>',
            senderEmail: 'alerts@chase.com',
            subject: 'Unexpected charge',
            snippet: '$42.00 at Acme Corp',
          },
          evidence: [{
            id: 'gmail:msg_1',
            source: 'gmail',
            streamId: 'personal-gmail',
            summary: 'Chase Alerts — Unexpected charge',
            url: 'https://mail.google.com/mail/u/0/#inbox/thr_1',
            at: '2026-04-06T11:59:00.000Z',
          }],
        },
        {
          title: 'Review PR #99',
          action: 'review',
          url: 'https://github.com/octo/repo/pull/99',
          notification: {
            threadId: '99123',
            reference: { repo: 'octo/repo', number: 99, kind: 'pr' },
            updatedAt: '2026-04-06T11:58:00.000Z',
          },
          evidence: [{
            id: 'github-notification:99123:1',
            source: 'github',
            streamId: 'github-notifications',
            summary: 'GitHub review requested notification on octo/repo#99: Review PR #99',
            url: 'https://github.com/octo/repo/pull/99',
            at: '2026-04-06T11:58:00.000Z',
          }],
        },
      ],
      observations: [
        { url: 'https://mail.google.com/mail/u/0/#inbox/thr_1', state: 'open', observedAt: '2026-04-06T12:00:00.000Z', reason: '' },
        { url: 'https://github.com/octo/repo/pull/99', state: 'open', reference: { repo: 'octo/repo', number: 99, kind: 'pr' }, observedAt: '2026-04-06T12:00:00.000Z', reason: '' },
      ],
      warnings: [],
    }, '2026-04-06T12:00:00.000Z', false, { reopenDone: false });

    expect(collected.tasks).toHaveLength(2);
    const emailTask = collected.tasks.find(task => task.work?.email?.threadId === 'thr_1')!;
    const prTask = collected.tasks.find(task => task.work?.reference?.number === 99)!;
    expect(emailTask.work?.email?.senderEmail).toBe('alerts@chase.com');

    // Mark the PR task done; selectedKey advances to the remaining active task
    const withSelection = { ...collected, selectedKey: `a:${prTask.id}` };
    const completed = completeWorkTask(withSelection, prTask.id, '2026-04-06T12:05:00.000Z');
    expect(completed.tasks.find(task => task.id === prTask.id)?.status).toBe('done');
    expect(completed.selectedKey).toBe(`a:${emailTask.id}`);

    // Subsequent collectSources (reopenDone: false) with a newer timestamp does NOT reopen the Done task
    const recollected = reconcileWork(completed, {
      collectedAt: '2026-04-06T12:10:00.000Z',
      candidates: [{
        title: 'Review PR #99',
        action: 'review',
        url: 'https://github.com/octo/repo/pull/99',
        notification: {
          threadId: '99123',
          reference: { repo: 'octo/repo', number: 99, kind: 'pr' },
          updatedAt: '2026-04-06T12:09:00.000Z',
        },
        evidence: [{
          id: 'github-notification:99123:2',
          source: 'github',
          streamId: 'github-notifications',
          summary: 'New comment on octo/repo#99',
          url: 'https://github.com/octo/repo/pull/99',
          at: '2026-04-06T12:09:00.000Z',
        }],
      }],
      observations: [
        { url: 'https://github.com/octo/repo/pull/99', state: 'open', reference: { repo: 'octo/repo', number: 99, kind: 'pr' }, observedAt: '2026-04-06T12:10:00.000Z', reason: '' },
      ],
      warnings: [],
    }, '2026-04-06T12:10:00.000Z', false, { reopenDone: false });

    expect(recollected.tasks.find(task => task.id === prTask.id)?.status).toBe('done');
  });

  test('builds Copilot Projects custom instruction prompt and selects matching project', () => {
    const settings = defaultWorkState().settings;
    const state = reconcileWork(emptyWorkspace('2026-04-06T12:00:00Z', 'UTC'), {
      collectedAt: '2026-04-06T12:00:00.000Z',
      candidates: [{
        title: 'Review octo/github#101',
        action: 'review',
        url: 'https://github.com/octo/github/pull/101',
        evidence: [{
          id: 'ev1',
          source: 'github',
          streamId: 'github-notifications',
          summary: 'Review requested on octo/github#101',
          url: 'https://github.com/octo/github/pull/101',
          at: '2026-04-06T11:58:00.000Z',
        }],
      }],
      observations: [
        { url: 'https://github.com/octo/github/pull/101', state: 'open', reference: { repo: 'octo/github', number: 101, kind: 'pr' }, observedAt: '2026-04-06T12:00:00.000Z', reason: '' },
      ],
      warnings: [],
    }, '2026-04-06T12:00:00.000Z');

    const task = state.tasks[0]!;
    expect(defaultTemplateKind(task)).toBe('review');
    const prompt = buildCopilotDispatchPrompt(task, settings);
    expect(prompt).toContain('Review https://github.com/octo/github/pull/101');
    expect(prompt).toContain('URL: https://github.com/octo/github/pull/101');
    expect(prompt).toContain('GitHub PR: octo/github#101');

    const projectId = guessProjectId(task, [
      { id: 'proj-1', name: 'github', state: 'running', sessions: 2, active: true },
      { id: 'proj-2', name: 'PR Reviews', state: 'idle', sessions: 1, active: false },
    ], settings);
    expect(projectId).toBe('proj-2');

    const fixPrState = reconcileWork(emptyWorkspace('2026-04-06T12:00:00Z', 'UTC'), {
      collectedAt: '2026-04-06T12:00:00.000Z',
      candidates: [{
        title: 'Fix CI on octo/github#102',
        action: 'fix',
        url: 'https://github.com/octo/github/pull/102',
        evidence: [{
          id: 'ev2',
          source: 'github',
          streamId: 'github-notifications',
          summary: 'CI failing on octo/github#102',
          url: 'https://github.com/octo/github/pull/102',
          at: '2026-04-06T11:58:00.000Z',
        }],
      }],
      observations: [
        { url: 'https://github.com/octo/github/pull/102', state: 'open', reference: { repo: 'octo/github', number: 102, kind: 'pr' }, observedAt: '2026-04-06T12:00:00.000Z', reason: '' },
      ],
      warnings: [],
    }, '2026-04-06T12:00:00.000Z');
    const fixTask = fixPrState.tasks[0]!;
    expect(guessProjectId(fixTask, [
      { id: 'proj-1', name: 'github', state: 'running', sessions: 2, active: false },
      { id: 'proj-2', name: 'PR Reviews', state: 'idle', sessions: 1, active: true },
    ], settings)).toBe('proj-1');
  });
});
