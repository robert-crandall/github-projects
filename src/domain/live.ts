import type { CaptureProposal, GitHubSnapshot, RankingProposal } from '../desktop-contract.ts';
import { isAppState } from '../storage.ts';
import { nextDailyDue, systemTimeZone, timestamp, validateTime, validateTimeZone } from './clock.ts';
import { isActionable } from './ranking.ts';
import type { AppState, Capture, Source, Step, WorkItem } from './types.ts';
import { eligibleActive } from './undo.ts';

export function createDesktopState(clock = new Date().toISOString()): AppState {
  const now = new Date(timestamp(clock)).toISOString();
  return {
    version: 1, runtime: 'desktop', clock: now, items: [], captures: [], projects: [],
    draft: '', undo: [], sync: { status: 'disconnected', lastSuccessAt: now }, interpretationError: false,
  };
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function boundedText(value: unknown, label: string, limit = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    throw new Error(`${label} must be nonempty text of at most ${limit} characters.`);
  }
  return value.trim();
}

export function proposedSteps(value: unknown): Step[] {
  if (!Array.isArray(value) || !value.length || value.length > 20) {
    throw new Error('Provide between 1 and 20 ordered routine steps.');
  }
  return value.map((title, index) => ({ id: `step-${index + 1}`, title: boundedText(title, 'Step', 500) }));
}

export function canonicalReviewUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password || url.port) return;
    const match = /^\/([a-z\d](?:[a-z\d-]*))\/([a-z\d_.-]+)\/pull\/([1-9]\d*)(?:\/(?:files|commits|checks))?\/?$/i.exec(url.pathname);
    if (!match) return;
    return `https://github.com/${match[1].toLowerCase()}/${match[2].toLowerCase()}/pull/${match[3]}`;
  } catch {
    return;
  }
}

function captureReviewUrl(text: string): string | undefined {
  const urls = text.match(/https:\/\/[^\s<>"`]+/gi) ?? [];
  const identities = new Set(urls.map(url => canonicalReviewUrl(url.replace(/[),.!?;:]+$/, ''))).filter(Boolean));
  return identities.size === 1 ? [...identities][0] : undefined;
}

function explicitDailyTime(original: string): string | undefined {
  if (/\b(?:maybe|perhaps|if|unless|weekdays?|weekends?|except|until|starting|don't|not|never)\b/i.test(original)) return;
  const matches = [...original.matchAll(/\b(?:every day|daily)\s+at\s+((?:[01]?\d|2[0-3]):[0-5]\d(?:\s*[ap]\.?m\.?)?|(?:1[0-2]|[1-9])\s*[ap]\.?m\.?)(?![\w:])/gi)];
  if (matches.length !== 1) return;
  const allTimes = original.match(/\b(?:(?:[01]?\d|2[0-3]):[0-5]\d(?:\s*[ap]\.?m\.?)?|(?:1[0-2]|[1-9])\s*[ap]\.?m\.?)(?![\w:])/gi);
  if (allTimes?.length !== 1 || /\b(?:or|alternat(?:e|ing)|twice|once a week)\b/i.test(original)) return;
  const token = matches[0][1].toLowerCase().replace(/[.\s]/g, '');
  const parts = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(token)!;
  let hours = Number(parts[1]);
  if (parts[3]) {
    if (hours < 1 || hours > 12) return;
    hours = hours % 12 + (parts[3] === 'pm' ? 12 : 0);
  }

  return `${String(hours).padStart(2, '0')}:${parts[2] ?? '00'}`;
}

function explicitTimeZone(original: string, fallback: string): string | undefined {
  const zones = original.match(/\b(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?\b/g) ?? [];
  const utc = /\b(?:UTC|GMT)\b/i.test(original);
  if (/\b(?:PST|PDT|MST|MDT|CST|CDT|EST|EDT|CET|CEST|BST|IST|JST|AEST|AEDT)\b/i.test(original)) return;
  if (zones.length > 1 || (zones.length && utc)) return;
  const zone = utc ? 'UTC' : zones[0] ?? fallback;
  try { validateTimeZone(zone); return zone; } catch { return; }
}

function validateProposedReferences(original: string, texts: string[]): void {
  const links = (text: string) => text.match(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"`]+/gi)?.map(url => url.replace(/[),.!?;:]+$/, '')) ?? [];
  const originalLinks = new Set(links(original).map(url => canonicalReviewUrl(url) ?? url));
  for (const url of texts.flatMap(links)) {
    if (!/^https?:\/\//i.test(url) || !originalLinks.has(canonicalReviewUrl(url) ?? url)) {
      throw new Error('A proposed reference is not supported by the original capture.');
    }
  }
}

function mergeSources(left: Source[], right: Source[]): Source[] {
  const combined = structuredClone(left);
  for (const source of right) {
    const index = combined.findIndex(existing => existing.id === source.id && existing.kind === source.kind);
    if (index < 0) combined.push(structuredClone(source));
    else combined[index] = { ...combined[index], ...source };
  }
  return combined;
}

function decisionWeight(item: WorkItem, state: AppState): number {
  if (item.status === 'completed' || item.status === 'removed') return 1000;
  if (item.status !== 'available') return 900;
  if (state.activeId === item.id) return 800;
  if (item.startedAt || item.steps.some(step => step.doneAt)) return 700;
  if (state.undo.some(entry => entry.itemsAfter.some(snapshot => snapshot.id === item.id))) return 600;
  return item.sources.some(source => source.kind === 'capture') ? 500 : 0;
}

function coalesceReviews(state: AppState, first: WorkItem, second: WorkItem): WorkItem {
  const [keep, removed] = decisionWeight(second, state) > decisionWeight(first, state) ? [second, first] : [first, second];
  keep.sources = mergeSources(keep.sources, removed.sources);
  if (removed.notes && !keep.notes.includes(removed.notes)) keep.notes = [keep.notes, removed.notes].filter(Boolean).join('\n\n');
  for (const step of removed.steps) {
    const existing = keep.steps.find(candidate => candidate.id === step.id);
    if (!existing) keep.steps.push(structuredClone(step));
    else existing.doneAt ??= step.doneAt;
  }
  keep.projectId ??= removed.projectId;
  for (const capture of state.captures) if (capture.itemId === removed.id) capture.itemId = keep.id;
  // Remap the original decision snapshots, not today's merged fields. The
  // conditional inverse can still undo the decision without reverting evidence.
  for (const entry of state.undo) {
    for (const key of ['itemsBefore', 'itemsAfter'] as const) {
      const alreadyPresent = entry[key].some(item => item.id === keep.id);
      entry[key] = entry[key].filter(item => item.id !== removed.id || !alreadyPresent)
        .map(item => item.id === removed.id ? { ...item, id: keep.id } : item);
    }
    if (entry.activeBefore === removed.id) entry.activeBefore = keep.id;
    if (entry.activeAfter === removed.id) entry.activeAfter = keep.id;
  }
  if (state.activeId === removed.id) state.activeId = keep.id;
  state.items = state.items.filter(item => item.id !== removed.id);
  return keep;
}

function reviewRequest(left: WorkItem['review'], right: WorkItem['review']): WorkItem['review'] {
  if (!left) return right;
  if (!right) return left;
  const priority = { direct: 0, team: 1, manual: 2 };
  return { ...left, ...right, request: priority[left.request] < priority[right.request] ? left.request : right.request };
}

export function mergeGitHubSnapshot(state: AppState, snapshot: GitHubSnapshot): AppState {
  if (!object(snapshot) || !Array.isArray(snapshot.items) || snapshot.items.length > 2000
    || !Array.isArray(snapshot.warnings) || snapshot.warnings.length > 100) throw new Error('Invalid GitHub snapshot.');
  boundedText(snapshot.login, 'GitHub login', 100);
  snapshot.warnings.forEach(warning => boundedText(warning, 'GitHub warning'));
  const fetchedAt = new Date(timestamp(snapshot.fetchedAt)).toISOString();
  if (!isAppState({ ...createDesktopState(fetchedAt), items: snapshot.items })) throw new Error('Invalid GitHub work items.');
  for (const item of snapshot.items) {
    if (!item.id || item.routine || item.kind === 'routine' || item.status !== 'available'
      || !item.sources.length || item.sources.some(source => source.kind !== 'github' || !safeGitHubReference(source.reference))
      || (item.kind === 'review' && !item.review?.identity)
      || (item.review?.identity && !canonicalReviewUrl(item.review.identity))) {
      throw new Error('GitHub items must contain safe source evidence, not local decisions.');
    }
  }
  if (state.sync.status !== 'disconnected' && timestamp(fetchedAt) < timestamp(state.sync.lastSuccessAt)) return state;
  const incoming = structuredClone(snapshot.items);
  for (const item of incoming) {
    if (item.review?.identity) item.review.identity = canonicalReviewUrl(item.review.identity);
  }
  const seen = new Set<string>();
  for (const fresh of incoming) {
    let existing = state.items.find(item => item.id === fresh.id);
    if (existing && (existing.kind !== fresh.kind || existing.review?.identity !== fresh.review?.identity)) {
      throw new Error('A GitHub item ID changed its underlying action.');
    }
    const duplicates = fresh.kind === 'review' && fresh.review?.identity
      ? state.items.filter(item => item.kind === 'review' && item.review?.identity === fresh.review!.identity) : [];
    for (const duplicate of duplicates) {
      if (!existing) existing = duplicate;
      else if (existing.id !== duplicate.id) existing = coalesceReviews(state, existing, duplicate);
    }
    if (!existing) {
      fresh.signalCurrent = true;
      state.items.push(fresh);
      existing = fresh;
    } else {
      const alreadySeen = seen.has(existing.id);
      existing.sources = mergeSources(alreadySeen ? existing.sources : existing.sources.filter(source => source.kind !== 'github'), fresh.sources);
      existing.review = alreadySeen ? reviewRequest(existing.review, fresh.review) : structuredClone(fresh.review);
      if (fresh.evidence !== undefined) existing.evidence = fresh.evidence;
      else delete existing.evidence;
      existing.signalCurrent = true;
    }
    seen.add(existing.id);
  }
  for (const item of state.items) {
    if (!snapshot.warnings.length && item.sources.some(source => source.kind === 'github') && !seen.has(item.id)) {
      item.signalCurrent = false;
    }
  }
  state.sync = { status: 'ok', lastSuccessAt: fetchedAt, login: snapshot.login, warnings: [...snapshot.warnings] };
  delete state.aiRanking;
  eligibleActive(state);
  return state;
}

function safeGitHubReference(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.port
      && /^\/[a-z\d-]+\/[a-z\d_.-]+\/(?:pull|issues)\/[1-9]\d*\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function getCapture(state: AppState, id: string): Capture {
  const saved = state.captures.find(capture => capture.id === id);
  if (!saved) throw new Error('This capture does not exist.');
  return saved;
}

export function interpretationFailure(state: AppState, id: string, error: string): AppState {
  const saved = getCapture(state, id);
  if (saved.interpretation !== 'pending' && saved.interpretation !== 'error') return state;
  saved.interpretation = 'error';
  saved.explanation = boundedText(error, 'Interpretation error');
  return state;
}

export function applyCaptureProposal(state: AppState, id: string, proposal: CaptureProposal): AppState {
  const saved = getCapture(state, id);
  if (saved.interpretation !== 'pending' && saved.interpretation !== 'error') return state;
  if (!object(proposal) || !['task', 'review', 'routine'].includes(proposal.kind)) throw new Error('Unsupported capture proposal kind.');
  const title = boundedText(proposal.title, 'Proposed title', 500);
  const nextStep = boundedText(proposal.nextStep, 'Proposed next step', 1000);
  let explanation = boundedText(proposal.explanation, 'Proposal explanation');
  if (proposal.reviewUrl !== undefined) boundedText(proposal.reviewUrl, 'Review URL', 1000);
  if (proposal.dailyTime !== undefined) validateTime(proposal.dailyTime);
  const steps = proposal.steps === undefined ? undefined : proposedSteps(proposal.steps);
  validateProposedReferences(saved.original, [title, nextStep, explanation, ...(steps?.map(step => step.title) ?? [])]);
  let item = state.items.find(item => item.id === saved.itemId)!;
  if (!item) throw new Error('The saved capture has no work item.');
  if (item.kind !== 'task' || item.routine) {
    saved.interpretation = item.kind === 'review' ? 'review' : item.kind === 'routine' ? 'routine' : 'task';
    saved.explanation = 'I kept your edited action instead of replacing it with the delayed AI proposal.';
    return state;
  }
  let kind = proposal.kind;
  let identity: string | undefined;
  if (kind === 'review') {
    identity = captureReviewUrl(saved.original);
    if (proposal.reviewUrl && (!identity || canonicalReviewUrl(proposal.reviewUrl) !== identity)) {
      throw new Error('The proposed review URL is not supported by the original capture.');
    }
    if (!identity) {
      kind = 'task';
      explanation = 'Saved as a task: the capture needs one unambiguous HTTPS GitHub PR reference before it can become a linked review.';
    }
  } else if (proposal.reviewUrl) {
    throw new Error('Only a review proposal may include a review URL.');
  }
  if (kind === 'routine') {
    const time = explicitDailyTime(saved.original);
    const zone = explicitTimeZone(saved.original, saved.timeZone ?? systemTimeZone());
    if (state.activeId === item.id || item.startedAt) {
      kind = 'task';
      explanation = 'I kept the task you already started. Edit its schedule explicitly if you want future daily occurrences.';
    } else if (!time || time !== proposal.dailyTime || !zone) {
      kind = 'task';
      explanation = 'Saved as a task: the capture does not support one explicit daily time matching this proposal. Edit the schedule to clarify it.';
    } else {
      item.routine = { time, timeZone: zone, nextDueAt: nextDailyDue(state.clock, time, zone), occurrences: [] };
      item.steps = steps ?? [{ id: 'step-1', title: nextStep }];
    }
  }
  if (kind === 'review' && identity) {
    const existing = state.items.find(candidate => candidate.id !== item.id && candidate.kind === 'review' && candidate.review?.identity === identity);
    if (existing && (
      (item.status !== 'available' && existing.status !== 'available'
        && (item.status !== existing.status || item.reason !== existing.reason || item.availableAt !== existing.availableAt))
      || (state.activeId === existing.id && item.status !== 'available')
      || (state.activeId === item.id && existing.status !== 'available')
    )) {
      kind = 'task';
      explanation = 'Saved separately as a task: this PR already has a conflicting local decision. I kept both decisions and your active action unchanged.';
    }
  }
  item.kind = kind;
  if (!saved.actionEdited && item.title === saved.original.trim()) item.title = title;
  if (!saved.actionEdited && item.nextStep === 'Choose a concrete next step.') item.nextStep = nextStep;
  if (kind === 'review' && identity) {
    item.review = { identity, request: 'manual' };
    for (const source of item.sources) if (source.kind === 'capture' && source.id === saved.id) source.reference = identity;
    const existing = state.items.find(candidate => candidate.id !== item.id && candidate.kind === 'review' && candidate.review?.identity === identity);
    if (existing) {
      const review = reviewRequest(existing.review, item.review);
      const evidence = existing.evidence;
      const signalCurrent = existing.signalCurrent;
      item = coalesceReviews(state, existing, item);
      item.review = review;
      item.evidence = evidence;
      item.signalCurrent = signalCurrent;
    }
  }
  item.updatedAt = state.clock;
  saved.interpretation = kind;
  saved.explanation = explanation;
  delete state.aiRanking;
  eligibleActive(state);
  return state;
}

export function applyRankingProposal(state: AppState, proposal: RankingProposal): AppState {
  if (!object(proposal) || !Array.isArray(proposal.orderedIds) || !Array.isArray(proposal.reasons)
    || proposal.orderedIds.length > 40 || proposal.reasons.length > 40) throw new Error('Invalid AI ranking; at most 40 candidates are supported.');
  const summary = boundedText(proposal.summary, 'Ranking summary');
  const eligible = new Set(state.items.filter(item => isActionable(item, state)).map(item => item.id));
  const ids = new Set<string>();
  for (const id of proposal.orderedIds) {
    boundedText(id, 'Ranked ID', 500);
    if (!eligible.has(id) || ids.has(id)) throw new Error('AI ranking contains an unknown, duplicate, or unavailable item.');
    ids.add(id);
  }
  const explained = new Set<string>();
  for (const reason of proposal.reasons) {
    if (!object(reason) || !ids.has(reason.id) || explained.has(reason.id)) throw new Error('AI ranking reasons must name unique ranked items.');
    boundedText(reason.reason, 'Ranking reason', 500);
    explained.add(reason.id);
  }
  if (explained.size !== ids.size || (!ids.size && eligible.size)) throw new Error('Every ranked item needs a reason; an available ranking cannot be empty.');
  state.aiRanking = { orderedIds: [...ids], reasons: structuredClone(proposal.reasons), summary, generatedAt: state.clock };
  return state;
}
