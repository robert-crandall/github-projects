import { CopilotService } from './copilot.ts';
import { GitHubService } from './github.ts';
import { sanitized } from './errors.ts';
import { serve, type Handler } from './protocol.ts';
import type { ServiceErrorDTO } from './schema.ts';
import { WorkService } from './work.ts';
import { serveIntakeMcp } from './work-mcp-protocol.ts';

export function createHandler(github = new GitHubService(), copilot = new CopilotService(), work = new WorkService({ copilot })): Handler {
  return async (request, signal) => {
    switch (request.op) {
      case 'connection.check': {
        const [gh, sdk] = await Promise.allSettled([github.connection(signal), copilot.connection(signal)]);
        const failed = (error: unknown): { available: false; error: ServiceErrorDTO } => ({ available: false, error: sanitized(error) });
        return {
          github: gh.status === 'fulfilled' ? gh.value : { ...failed(gh.reason), scopes: [] },
          copilot: sdk.status === 'fulfilled' ? sdk.value : failed(sdk.reason),
        };
      }
      case 'github.refresh': return github.refresh(signal);
      case 'github.conversation': return github.conversation(request.input, signal);
      case 'github.acknowledge': return github.write('acknowledge', request.input, signal);
      case 'github.unsubscribe': return github.write('unsubscribe', request.input, signal);
      case 'copilot.triage': return copilot.triage(request.input, signal);
      case 'copilot.interpretCapture': return copilot.interpretCapture(request.input, signal);
      case 'copilot.reconsider': return copilot.reconsider(request.input, signal);
      case 'work.collect': return work.collect(request.input, signal);
      case 'work.rank': return work.rank(request.input, signal);
      case 'work.connections': return work.listConnections();
      case 'work.intake': return work.pendingIntake();
      case 'work.ackIntake': return work.ackIntake(request.input);
    }
  };
}
if (import.meta.main) {
  process.once('SIGTERM', () => { process.stdin.destroy(); });
  process.once('SIGINT', () => { process.stdin.destroy(); });
  try {
    const write = (line: string) => new Promise<void>((resolve, reject) => {
      process.stdout.write(line, error => error ? reject(error) : resolve());
    });
    if (process.argv.includes('--mcp')) await serveIntakeMcp(process.stdin, write);
    else await serve(process.stdin, write, createHandler(), {
      onDiagnostic: code => { process.stderr.write(`service:${code}\n`); },
      closeInput: () => { process.stdin.destroy(); },
    });
  } catch (error) {
    process.stderr.write(`service:${sanitized(error).code}\n`);
    process.exitCode = 1;
  }
}
