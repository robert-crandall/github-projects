import { useState, type FormEvent } from 'react';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { githubWorkActionSchema, isGitHubStream, notificationWorkstream, workSettingsSchema, type WorkSettings, type Workstream } from '../../service/src/work-schema.ts';
import type { WorkQueue } from './controller.ts';
import { Appearance } from '../themes/Appearance.tsx';

const actions = [
  ['review', 'Review a PR'], ['fix', 'Fix a PR'], ['reply', 'Reply'],
  ['merge', 'Merge a PR'], ['implement', 'Work on an issue'],
  ['review-result', 'Read a completed Copilot review'], ['follow-up', 'Follow up'], ['manual', 'Task'],
] as const;

export function Settings({ settings, profileName, queue, close, recover, reference }: {
  settings: WorkSettings; queue: WorkQueue; close: () => void; recover: () => void; reference: () => void;
  profileName: string;
}) {
  const [draft, setDraft] = useState(() => structuredClone(settings));
  const [name, setName] = useState(profileName);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [checking, setChecking] = useState(false);
  const [connectionInfo, setConnectionInfo] = useState('');
  function change(next: WorkSettings) { setDraft(next); setSaved(false); setError(''); }
  function streamChange(id: string, patch: Partial<Workstream>) {
    change({ ...draft, streams: draft.streams.map(stream => stream.id === id ? { ...stream, ...patch } : stream) });
  }
  function save(event: FormEvent) {
    event.preventDefault();
    const parsed = workSettingsSchema.safeParse({
      ...draft, streams: draft.streams.map(stream => ({ ...stream, tools: stream.tools.map(tool => tool.trim()).filter(Boolean) })),
    });
    if (!parsed.success) { setError(parsed.error.issues.map(issue => issue.message).join(' ')); return; }
    const invalidMcp = parsed.data.streams.find(stream => stream.enabled && !isGitHubStream(stream)
      && (!stream.server.trim() || !stream.tools.length || stream.tools.includes('*')));
    if (invalidMcp) { setError(`${invalidMcp.name}: choose a server and name its allowed read tools. Wildcards are not allowed.`); return; }
    try { queue.saveSettings(parsed.data, name); setSaved(true); }
    catch (error) { setError(error instanceof Error ? error.message : 'Settings could not be saved.'); }
  }
  async function connections() {
    setChecking(true); setError('');
    try {
      await queue.connections();
      const info = queue.getSnapshot().connections;
      setConnectionInfo(info ? `${info.instructions}\n${info.servers.map(server =>
        `${server.name} (${server.source})${server.tools.length ? `: ${server.tools.join(', ')}` : ''}`).join('\n')}` : 'No connection information was returned.');
    } catch (error) { setError(error instanceof Error ? error.message : 'Connections could not be read.'); }
    finally { setChecking(false); }
  }
  return <main className="task-settings">
    <header className="task-settings-heading"><button className="quiet" onClick={close}><ArrowLeft size={16} />Back to tasks</button><h1>How I find and rank your work</h1>
      <p>Choose the sources. Tell Copilot what matters. Every run ranks the whole task list.</p>
    </header>
    <Appearance />
    <form onSubmit={save}>
      <section aria-labelledby="profile-heading"><h2 id="profile-heading">Work profile</h2>
        <label htmlFor="profile-name">Profile name</label>
        <input id="profile-name" value={name} maxLength={80} required onChange={event => {
          setName(event.target.value); setSaved(false); setError('');
        }} />
        <p>Instructions, sources, schedule and tasks belong to this profile. Switch profiles or add one from the task list.</p>
      </section>
      <section aria-labelledby="instructions-heading"><h2 id="instructions-heading">Priority instructions</h2>
        <p>Your rules and roadmap guide the order, not which requests you have already completed.</p>
        <label htmlFor="priority-instructions">What should come first?</label>
        <textarea id="priority-instructions" rows={8} maxLength={16000} value={draft.instructions}
          placeholder={'Rank PR reviews in owner/repo first.\nTreat reviews requested through Slack as high priority.\nFor usersd, prioritize earlier roadmap phases. Paste the roadmap here.'}
          onChange={event => change({ ...draft, instructions: event.target.value })} />
        <label className="task-model">Copilot model (optional)<input value={draft.model} maxLength={100}
          placeholder="Use the SDK default" onChange={event => change({ ...draft, model: event.target.value })} /></label>
        <p className="field-help">Copilot receives task titles, task notes, source evidence and these instructions. Saved thread notes stay private.</p>
      </section>
      <section aria-labelledby="sources-heading"><div className="task-section-heading"><h2 id="sources-heading">Sources of work</h2>
        <button type="button" className="secondary" disabled={draft.streams.length >= 30} onClick={() => change({
          ...draft, streams: [...draft.streams, {
            id: crypto.randomUUID(), name: 'New source', enabled: false, kind: 'slack',
            query: '', action: 'follow-up', server: '', tools: [],
          }],
        })}><Plus size={15} />Add source</button></div>
        <p>Keep backlog searches for assigned work and projects. Notifications find requests those searches miss, including mentions.</p>
        {!draft.streams.some(stream => stream.kind === 'github-notifications') && <button type="button" className="secondary"
          disabled={draft.streams.length >= 30} onClick={() => change({ ...draft, streams: [...draft.streams, notificationWorkstream()] })}>
          <Plus size={15} />Add GitHub notifications</button>}
        <div className="task-streams">{draft.streams.map((stream, index) => <fieldset key={stream.id} className="task-stream">
          <legend>Source {index + 1}</legend>
          <div className="task-stream-top"><label className="checkbox-label"><input type="checkbox" checked={stream.enabled}
            onChange={event => streamChange(stream.id, { enabled: event.target.checked })} />Enabled</label>
            <button type="button" className="quiet danger" aria-label={`Remove ${stream.name}`} onClick={() => change({
              ...draft, streams: draft.streams.filter(item => item.id !== stream.id),
            })}><Trash2 size={15} />Remove</button></div>
          <div className="task-field-pair"><label>Name<input value={stream.name} maxLength={100}
            onChange={event => streamChange(stream.id, { name: event.target.value })} /></label>
            <label>Source type<select value={stream.kind} onChange={event => streamChange(stream.id, event.target.value === 'github-notifications'
              ? { kind: 'github-notifications', query: notificationWorkstream().query, action: 'follow-up', server: '', tools: [] }
              : { kind: event.target.value as Workstream['kind'] })}>
              <option value="github">GitHub search</option><option value="github-notifications">GitHub notifications</option>
              <option value="slack">Slack through MCP</option><option value="mcp">MCP search</option>
            </select></label></div>
          {stream.kind === 'github-notifications' ? <p className="field-help">
            Inspect issue and PR notifications updated since the last successful run, whether read or unread.
            The first scan covers 30 days. Copilot identifies actual requests before adding tasks; ordinary activity does not reopen Done.
          </p> : <><label>{stream.kind === 'github' ? 'GitHub query' : 'What should Copilot look for?'}
            <textarea rows={2} value={stream.query} maxLength={4000} placeholder={stream.kind === 'github'
              ? 'is:pr is:open archived:false user-review-requested:@me'
              : 'Find requests for me in the team channel. Read the thread and extract only work I need to do.'}
            onChange={event => streamChange(stream.id, { query: event.target.value })} /></label>
          <label>{stream.kind === 'github' ? 'Action to take on matches' : 'Default action'}
            <select value={stream.action} onChange={event => streamChange(stream.id, { action: event.target.value as Workstream['action'] })}>
              {stream.kind === 'github' && !githubWorkActionSchema.safeParse(stream.action).success
                && <option value={stream.action} disabled>Choose a supported GitHub action</option>}
              {actions.filter(([value]) => stream.kind !== 'github' || githubWorkActionSchema.safeParse(value).success)
                .map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label></>}
          {!isGitHubStream(stream) && <div className="task-field-pair"><label>MCP server name<input value={stream.server}
            placeholder="slack" onChange={event => streamChange(stream.id, { server: event.target.value })} /></label>
            <label>Allowed read tools, comma-separated<input value={stream.tools.join(',')}
              placeholder="search_messages, get_thread"
              onChange={event => streamChange(stream.id, { tools: event.target.value.split(',') })} /></label></div>}
        </fieldset>)}</div>
        <p className="field-help">A source result is evidence, not a new task ID. Matching the same PR in two searches will not duplicate its review.</p>
      </section>
      <section aria-labelledby="schedule-heading"><h2 id="schedule-heading">Run on a schedule</h2>
        <label className="checkbox-label"><input type="checkbox" checked={draft.schedule.enabled}
          onChange={event => change({ ...draft, schedule: { ...draft.schedule, enabled: event.target.checked } })} />
          Collect and prioritize automatically</label>
        <label className="task-cadence">Minutes between runs<input type="number" min={5} max={1440} required value={draft.schedule.everyMinutes}
          onChange={event => change({ ...draft, schedule: { ...draft.schedule, everyMinutes: Number(event.target.value) } })} /></label>
        <p>Runs only while this profile is selected and the app is open, including hidden in the menu bar. After sleep, it catches up once. Quitting stops scheduled runs.</p>
        <p className="field-help">Each run uses Copilot. Run now uses these same sources and instructions.</p>
      </section>
      {error && <p className="task-error" role="alert">{error}</p>}
      {saved && <p role="status">Settings applied. The save status below confirms when they reach disk.</p>}
      <div className="task-settings-save"><button type="submit" className="primary">Save settings</button></div>
    </form>
    <section aria-labelledby="connections-heading"><h2 id="connections-heading">Connections and intake</h2>
      <p>GitHub uses your GitHub CLI sign-in. MCP source connections stay in backend configuration, never in task data.</p>
      <button className="secondary" disabled={checking} onClick={() => void connections()}>{checking ? 'Reading connections...' : 'Read MCP connections'}</button>
      {connectionInfo && <p className="task-connection-info" role="status">{connectionInfo}</p>}
      <p>A Slack connection saved in Copilot app settings is not automatically shared with this app. Read connections for setup details.</p>
      <p>External agents can submit tasks through this app's MCP server. The next run adds them to the selected profile.
        For a completed Copilot review, submit a <code>review-result</code> task with a stable event ID and PR link. The task stays open until you mark it Done.</p>
      <p className="field-help">Run the packaged <code>github-projects-service --mcp</code> as a local MCP server in the producing app. This does not automatically install a completion hook.</p>
    </section>
    <section aria-labelledby="storage-heading"><h2 id="storage-heading">Your saved work</h2>
      <p>Done is local. It never closes a GitHub issue, submits a review or marks a notification read.
        Unsubscribe is a separate action in task details. Direct mentions, team mentions and review requests can still notify you again.</p>
      <div className="button-row"><button className="secondary" onClick={recover}>Backups & recovery</button>
        <button className="quiet" onClick={reference}>Open saved thread notes</button></div>
    </section>
  </main>;
}
