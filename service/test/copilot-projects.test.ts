import { describe, expect, test } from 'bun:test';
import { CopilotProjectsService, deterministicRequestId, parseCopilotProjectsList, selectCopilotProject } from '../src/copilot-projects.ts';

describe('CopilotProjectsService', () => {
  test('parses copilot-projects list-projects output and matches project by repo or PR review', () => {
    const stdout = [
      ' * [running] github (3 sessions) 05434F51-E2AD-4D31-8DB1-368EF82D2DC9',
      '   [idle]    PR Reviews (1 session) 40736808-F7FE-411F-A8E1-62C1E42396A4',
      '   [idle]    m (2 sessions) 140BD25A-671F-4A6A-ABDA-EFC268D4BF3D',
    ].join('\n');

    const projects = parseCopilotProjectsList(stdout);
    expect(projects).toEqual([
      { id: '05434F51-E2AD-4D31-8DB1-368EF82D2DC9', name: 'github', state: 'running', sessions: 3, active: true },
      { id: '40736808-F7FE-411F-A8E1-62C1E42396A4', name: 'PR Reviews', state: 'idle', sessions: 1, active: false },
      { id: '140BD25A-671F-4A6A-ABDA-EFC268D4BF3D', name: 'm', state: 'idle', sessions: 2, active: false },
    ]);

    expect(selectCopilotProject(projects, { repo: 'github/github' })?.id).toBe('05434F51-E2AD-4D31-8DB1-368EF82D2DC9');
    expect(selectCopilotProject(projects, { action: 'review' })?.id).toBe('40736808-F7FE-411F-A8E1-62C1E42396A4');
  });

  test('dispatches new-copilot-session with prompt file, request ID, and title', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const service = new CopilotProjectsService({
      resolve: async () => '/usr/local/bin/copilot-projects',
      runner: async (command, args) => {
        calls.push({ command, args });
        if (args[0] === 'list-projects') {
          return {
            code: 0,
            stdout: ' * [running] github (3 sessions) 05434F51-E2AD-4D31-8DB1-368EF82D2DC9\n',
            stderr: '',
          };
        }
        return { code: 0, stdout: 'Session started\n', stderr: '' };
      },
    });

    const controller = new AbortController();
    const result = await service.dispatch({
      operationId: 'op-dispatch-1',
      repo: 'github/github',
      title: 'Review github/github#42',
      prompt: 'Review PR #42 carefully and check edge cases.',
    }, controller.signal);

    expect(result.status).toBe('confirmed');
    expect(result.projectId).toBe('05434F51-E2AD-4D31-8DB1-368EF82D2DC9');
    expect(result.projectName).toBe('github');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.command).toBe('/usr/local/bin/copilot-projects');
    expect(calls[1]!.args).toContain('new-copilot-session');
    expect(calls[1]!.args).toContain('--project');
    expect(calls[1]!.args).toContain('05434F51-E2AD-4D31-8DB1-368EF82D2DC9');
    expect(calls[1]!.args).toContain('--title');
    expect(calls[1]!.args).toContain('Review github/github#42');
    expect(calls[1]!.args).not.toContain('--no-parent');
    expect(result.requestId).toBe(deterministicRequestId('op-dispatch-1'));
    expect(deterministicRequestId('op-dispatch-1')).toBe(deterministicRequestId('op-dispatch-1'));
  });
});
