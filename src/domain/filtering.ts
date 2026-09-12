import { inboxSchema, ruleSchema, type AppState, type Rule, type Thread, type View } from '../types.ts';

const builtins: Record<string, string> = { inbox: 'Inbox', archive: 'Archive', filtered: 'Filtered', tasks: 'Tasks' };
export function viewLabel(state: AppState, view: View): string {
  return builtins[view] ?? state.inboxes.find(inbox => `inbox:${inbox.id}` === view)?.name ?? 'Unknown inbox';
}

export function validateFilters(state: Pick<AppState, 'rules' | 'inboxes' | 'view'>): void {
  const ids = new Set<string>();
  const names = new Set(Object.keys(builtins));
  if (state.inboxes.length > 50 || state.rules.length > 100) throw new Error('Use at most 50 inboxes and 100 rules.');
  for (const value of state.inboxes) {
    const inbox = inboxSchema.parse(value);
    const name = inbox.name.toLowerCase();
    if (ids.has(inbox.id) || names.has(name)) throw new Error('Inbox names must be unique and cannot be Inbox, Archive, Filtered, or Tasks.');
    ids.add(inbox.id); names.add(name);
  }
  const ruleIds = new Set<string>();
  for (const value of state.rules) {
    const rule = ruleSchema.parse(value);
    if (ruleIds.has(rule.id)) throw new Error('Rule identities must be unique.');
    if (rule.action.type === 'inbox' && !ids.has(rule.action.inboxId)) throw new Error('Choose an existing destination inbox.');
    ruleIds.add(rule.id);
  }
  if (state.view.startsWith('inbox:') && !ids.has(state.view.slice(6))) throw new Error('This inbox no longer exists.');
}

export function matchesRule(rule: Rule, thread: Thread): boolean {
  const { repo, kind, title } = rule.criteria;
  return (repo === undefined || repo.toLowerCase() === thread.repo.toLowerCase())
    && (kind === undefined || kind === thread.kind)
    && (title === undefined || thread.title.toLowerCase().includes(title.toLowerCase()));
}

export function matchingRules(state: Pick<AppState, 'rules'>, thread: Thread): Rule[] {
  return state.rules.filter(rule => rule.enabled && matchesRule(rule, thread));
}

export function placement(state: AppState, thread: Thread): { view: View; reason: string; matches: Rule[] } {
  const matches = matchingRules(state, thread);
  if (thread.archive) return { view: 'archive', reason: 'Manually archived. Rules never restore it.', matches };
  if (thread.terminal && thread.sourceState?.state !== 'unknown') {
    const label = { merged: 'Merged PR', closed: 'Closed source', queued: "Currently in GitHub's merge queue" }[thread.terminal.reason];
    return { view: 'filtered', reason: thread.sourceState?.state === 'open'
      ? 'No new activity since terminal suppression. New activity follows your rules.'
      : `${label}. Terminal suppression takes precedence over rules.`, matches };
  }
  const winner = matches[0];
  const view = winner?.action.type === 'inbox' ? `inbox:${winner.action.inboxId}` as const : winner ? 'filtered' : 'inbox';
  return { view, reason: winner ? `Rule "${winner.name}" → ${viewLabel(state, view)}. First enabled match wins.` : 'Inbox. No enabled rule matches.', matches };
}
