import {
  addDays, dateAtTime, nextDailyDue, nextRoutineDue, outstanding, reconcileClock, systemTimeZone, timestamp, validateTime, validateTimeZone,
} from './clock.ts';
import { arrivalReview, createInitialState, SAMPLE_IDS } from './fixtures.ts';
import { interpretText } from './interpretation.ts';
import { isActionable, reconcileAiRanking } from './ranking.ts';
import { applyCaptureProposal, applyRankingProposal, boundedText, interpretationFailure, mergeGitHubSnapshot, proposedSteps } from './live.ts';
import type { AppState, Capture, Command, Occurrence, Scenario, WorkItem } from './types.ts';
import { eligibleActive, recordDecision, retainUndoForItems, undoDecision } from './undo.ts';
import { githubReferences, wakeItem } from './sleep.ts';

function requiredText(text: string, label: string): string {
  if (!text.trim()) throw new Error(`${label} cannot be empty.`);
  return text.trim();
}

function getItem(state: AppState, id: string): WorkItem {
  const item = state.items.find(candidate => candidate.id === id);
  if (!item) throw new Error('This work item does not exist.');
  return item;
}

function requireActionable(item: WorkItem, state: AppState): void {
  if (!isActionable(item, state)) throw new Error('This action is not available now.');
}

function requireOpen(item: WorkItem): void {
  if (item.status === 'completed' || item.status === 'removed') {
    throw new Error('Restore this action before changing its status.');
  }
}

function getOccurrence(item: WorkItem): Occurrence {
  const occurrence = outstanding(item);
  if (item.kind !== 'routine' || !occurrence) throw new Error('This routine has no outstanding occurrence.');
  return occurrence;
}

function clearActive(state: AppState, id: string): void {
  if (state.activeId === id) delete state.activeId;
}

function finishOccurrence(item: WorkItem, state: AppState, status: 'completed' | 'skipped'): void {
  const occurrence = getOccurrence(item);
  occurrence.status = status;
  occurrence.finishedAt = state.clock;
  occurrence.reminderDismissed = true;
  delete occurrence.snoozedUntil;
  const routine = item.routine!;
  const zone = routine.timeZone ?? 'UTC';
  const tomorrow = dateAtTime(addDays(state.clock, 1, zone), routine.time, zone);
  routine.nextDueAt = timestamp(tomorrow) > timestamp(routine.nextDueAt) ? tomorrow : routine.nextDueAt;
}

function capture(state: AppState, id: string, text: string): AppState {
  requiredText(id, 'Capture ID');
  const title = requiredText(text, 'Capture');
  const itemId = `capture-${id}`;
  if (state.captures.some(entry => entry.id === id) || state.items.some(item => item.id === itemId)) {
    throw new Error('This capture ID is already in use.');
  }
  state.items.push({
    id: itemId, title, kind: 'task', status: 'available',
    createdAt: state.clock, updatedAt: state.clock,
    sources: [{ id, kind: 'capture', label: 'Your capture' }],
    notes: '', steps: [], nextStep: 'Choose a concrete next step.',
  });
  state.captures.push({
    id, original: text, createdAt: state.clock, itemId, interpretation: 'pending',
    ...(state.runtime === 'desktop' ? { timeZone: systemTimeZone() } : {}),
  });
  state.draft = '';
  return state;
}

function deduplicate(state: AppState, saved: Capture, provisional: WorkItem, target: WorkItem): void {
  for (const source of provisional.sources) {
    if (!target.sources.some(existing => existing.id === source.id && existing.kind === source.kind)) {
      target.sources.push(source);
    }
  }
  if (provisional.notes && !target.notes.includes(provisional.notes)) {
    target.notes = target.notes ? `${target.notes}\n\n${provisional.notes}` : provisional.notes;
  }
  for (const entry of state.captures) {
    if (entry.itemId === provisional.id) entry.itemId = target.id;
  }
  saved.itemId = target.id;
  // Provisional decisions were not applied to the existing obligation. Their
  // snapshots must not later undo an unrelated decision on that obligation.
  const targetActive = isActionable(target, state) ? target.id : undefined;
  for (const entry of state.undo) {
    entry.itemsBefore = entry.itemsBefore.filter(snapshot => snapshot.id !== provisional.id);
    entry.itemsAfter = entry.itemsAfter.filter(snapshot => snapshot.id !== provisional.id);
    if (entry.activeBefore === provisional.id) entry.activeBefore = targetActive;
    if (entry.activeAfter === provisional.id) entry.activeAfter = targetActive;
  }
  state.items = state.items.filter(item => item.id !== provisional.id);
  if (state.activeId === provisional.id) state.activeId = target.id;
  eligibleActive(state);
}

function interpret(state: AppState, captureId: string): AppState {
  const saved = state.captures.find(entry => entry.id === captureId);
  if (!saved) throw new Error('This capture does not exist.');
  if (saved.interpretation === 'review' || saved.interpretation === 'routine') return state;
  const item = getItem(state, saved.itemId);
  if (state.interpretationError) {
    saved.interpretation = 'error';
    saved.explanation = 'Simulated interpretation failure. Your original capture and saved task are intact; retry after recovery.';
    return state;
  }
  const result = interpretText(saved.original, state.clock);
  saved.interpretation = result.kind;
  saved.explanation = result.explanation;
  if (result.kind === 'unsupported') return state;

  if (result.kind === 'review') {
    const identity = result.review.identity;
    if (identity) {
      for (const source of item.sources) {
        if (source.kind === 'capture' && source.id === saved.id) source.reference = identity;
      }
      const existing = state.items.find(candidate =>
        candidate.id !== item.id && candidate.kind === 'review' && candidate.review?.identity === identity,
      );
      if (existing) {
        deduplicate(state, saved, item, existing);
        return state;
      }
    }
    item.review = result.review;
  } else {
    item.routine = result.routine;
    item.steps = result.steps;
  }
  item.kind = result.kind;
  if (item.title === saved.original.trim()) item.title = result.title;
  if (item.nextStep === 'Choose a concrete next step.') item.nextStep = result.nextStep;
  item.updatedAt = state.clock;
  eligibleActive(state);
  return state;
}

function resetSamples(state: AppState): AppState {
  const seed = createInitialState();
  const captured = new Set(state.captures.map(entry => entry.itemId));
  const captureIds = new Set(state.captures.map(entry => entry.id));
  const retainedItems = state.items.filter(item =>
    !SAMPLE_IDS.has(item.id) || captured.has(item.id)
    || item.sources.some(source => source.kind === 'capture' && captureIds.has(source.id)),
  );
  const retained = new Set(retainedItems.map(item => item.id));
  const referencedProjects = new Set(retainedItems.map(item => item.projectId).filter(Boolean));
  const keptProjects = state.projects.filter(project =>
    referencedProjects.has(project.id) || !seed.projects.some(sample => sample.id === project.id),
  );
  const samples = seed.items.filter(item => !retained.has(item.id));
  for (const item of samples) {
    if (item.routine) item.routine.nextDueAt = dateAtTime(state.clock, item.routine.time);
  }
  const next: AppState = {
    ...state,
    items: [...samples, ...retainedItems],
    projects: [...seed.projects.filter(project => !keptProjects.some(kept => kept.id === project.id)), ...keptProjects],
    undo: retainUndoForItems(state.undo, retained),
    sync: { status: 'ok', lastSuccessAt: state.clock },
    interpretationError: false,
  };
  if (!next.activeId || !retained.has(next.activeId)) delete next.activeId;
  const reconciled = reconcileClock(next, state.clock);
  eligibleActive(reconciled);
  return reconciled;
}

function scenario(state: AppState, selected: Scenario): AppState {
  switch (selected) {
    case 'before': {
      let to = dateAtTime(state.clock, '09:40');
      if (timestamp(to) < timestamp(state.clock)) to = addDays(to, 1);
      return reconcileClock(state, to);
    }
    case 'due': {
      const today = dateAtTime(state.clock, '10:00');
      if (timestamp(state.clock) < timestamp(today)) return reconcileClock(state, today);
      const nextDue = state.items
        .filter(item => item.kind === 'routine' && item.routine && item.status === 'available')
        .map(item => item.routine!.nextDueAt)
        .filter(dueAt => timestamp(dueAt) > timestamp(state.clock))
        .sort((a, b) => timestamp(a) - timestamp(b))[0];
      return reconcileClock(state, nextDue ?? nextDailyDue(state.clock, '10:00'));
    }
    case 'arrival': {
      if (!state.items.some(item => item.id === 'new-review')) {
        const arrival = arrivalReview(state.clock);
        const existing = state.items.find(item =>
          item.kind === 'review' && item.review?.identity === arrival.review!.identity,
        );
        if (existing) {
          if (!existing.sources.some(source => source.id === 'sample-arrival')) existing.sources.push(...arrival.sources);
          existing.review = { ...existing.review!, ...arrival.review };
          existing.evidence = arrival.evidence;
        } else state.items.push(arrival);
      }
      return state;
    }
    case 'missed':
      return reconcileClock(state, addDays(state.clock, 3));
    case 'empty': {
      const before = structuredClone(state);
      for (const item of state.items) {
        if (!isActionable(item, state)) continue;
        item.status = 'deferred';
        item.reason = 'Demo: no actionable work';
        item.updatedAt = state.clock;
      }
      eligibleActive(state);
      return recordDecision(before, state, 'Demo: no actionable work');
    }
    case 'sync-error':
      state.sync.status = 'error';
      return state;
    case 'interpretation-error':
      state.interpretationError = !state.interpretationError;
      return state;
    case 'recover':
      state.sync = { status: 'ok', lastSuccessAt: state.clock };
      state.interpretationError = false;
      return state;
    case 'reset':
      return resetSamples(state);
    default:
      throw new Error('Unknown demo scenario.');
  }
}

function applyCommandInternal(state: AppState, command: Command): AppState {
  if (command.type === 'advance') return reconcileClock(state, command.to);
  if (command.type === 'undo') return undoDecision(state);
  const next = structuredClone(state);
  switch (command.type) {
    case 'draft':
      next.draft = command.text;
      return next;
    case 'capture':
      return capture(next, command.id, command.text);
    case 'interpret':
      if (state.runtime === 'desktop') throw new Error('Desktop captures require a Copilot proposal, not demo interpretation.');
      return interpret(next, command.captureId);
    case 'scenario':
      if (state.runtime === 'desktop') throw new Error('Demo scenarios cannot change a desktop workspace.');
      return scenario(next, command.scenario);
    case 'github-sync':
      return mergeGitHubSnapshot(next, command.snapshot);
    case 'sync-error':
      next.sync = { ...next.sync, status: 'error', error: boundedText(command.error, 'GitHub error') };
      return next;
    case 'ai-interpret':
      return applyCaptureProposal(next, command.captureId, command.proposal);
    case 'interpret-error':
      return interpretationFailure(next, command.captureId, command.error);
    case 'ai-rank':
      return applyRankingProposal(next, command.proposal);
    case 'clear-ai-rank':
      delete next.aiRanking;
      return next;
    case 'project': {
      const name = requiredText(command.name, 'Project name');
      requiredText(command.id, 'Project ID');
      const project = next.projects.find(entry => entry.id === command.id);
      if (project) Object.assign(project, { name, notes: command.notes });
      else next.projects.push({ id: command.id, name, notes: command.notes });
      return next;
    }
    case 'notes': {
      const item = getItem(next, command.id);
      item.notes = command.text;
      if (JSON.stringify(item) !== JSON.stringify(getItem(state, item.id))) item.updatedAt = next.clock;
      return next;
    }
    case 'pause':
      if (!next.activeId) throw new Error('There is no active action to pause.');
      delete next.activeId;
      return recordDecision(state, next, 'Pause action');
  }

  const item = getItem(next, command.id);
  switch (command.type) {
    case 'start': {
      requireActionable(item, next);
      next.activeId = item.id;
      item.startedAt ??= next.clock;
      const occurrence = outstanding(item);
      if (occurrence) occurrence.reminderDismissed = true;
      break;
    }
    case 'complete':
      requireActionable(item, next);
      if (item.kind === 'routine') {
        const occurrence = getOccurrence(item);
        if (!occurrence.steps.length || occurrence.steps.some(step => !step.doneAt)) {
          throw new Error('Complete every routine step in order before finishing.');
        }
        finishOccurrence(item, next, 'completed');
      } else {
        item.status = 'completed';
        item.completedAt = next.clock;
      }
      clearActive(next, item.id);
      break;
    case 'sleep':
    case 'defer':
      requireOpen(item);
      if (command.type === 'sleep') {
        if (typeof command.wakeOnPing !== 'boolean') throw new Error('Choose whether a new GitHub ping should wake this action.');
        if (command.wakeOnPing && (next.runtime !== 'desktop' || !githubReferences(item).length)) {
          throw new Error('Wake on ping requires a linked GitHub issue or PR in the desktop app.');
        }
        item.sleep = { since: next.clock, wakeOnPing: command.wakeOnPing };
        if (command.reason?.trim()) item.reason = command.reason.trim();
        else delete item.reason;
      } else {
        item.reason = requiredText(command.reason, 'Deferral reason');
        delete item.sleep;
      }
      if (command.until && timestamp(command.until) <= timestamp(next.clock)) {
        throw new Error('Choose a future wake-up time.');
      }
      item.status = 'deferred';
      delete item.wake;
      if (command.until) item.availableAt = new Date(timestamp(command.until)).toISOString();
      else delete item.availableAt;
      clearActive(next, item.id);
      break;
    case 'wait':
      requireOpen(item);
      item.status = 'waiting';
      item.reason = requiredText(command.reason, 'Waiting reason');
      delete item.availableAt;
      delete item.sleep;
      clearActive(next, item.id);
      break;
    case 'restore': {
      const occurrence = outstanding(item);
      if (item.status === 'available' && !item.availableAt && !occurrence?.snoozedUntil) {
        throw new Error('This action is already available.');
      }
      wakeItem(item, next.clock, 'manual');
      delete item.completedAt;
      if (occurrence) delete occurrence.snoozedUntil;
      if (next.runtime === 'desktop' && item.routine) {
        const future = nextRoutineDue(next.clock, item.routine);
        if (timestamp(future) > timestamp(item.routine.nextDueAt)) item.routine.nextDueAt = future;
      }
      break;
    }
    case 'remove':
      if (item.status === 'removed') throw new Error('This action is already removed.');
      item.status = 'removed';
      delete item.sleep;
      clearActive(next, item.id);
      break;
    case 'edit':
      item.title = requiredText(command.title, 'Action title');
      item.nextStep = command.nextStep;
      if (command.projectId && !next.projects.some(project => project.id === command.projectId)) {
        throw new Error('This project does not exist.');
      }
      if (command.projectId) item.projectId = command.projectId;
      else delete item.projectId;
      if (command.routineTime !== undefined) {
        validateTime(command.routineTime);
        if (!item.routine && next.runtime !== 'desktop') throw new Error('Only a routine has a daily schedule.');
        const zone = command.routineTimeZone ?? item.routine?.timeZone ?? (next.runtime === 'desktop' && !item.routine ? systemTimeZone() : 'UTC');
        validateTimeZone(zone);
        if (!item.routine) {
          if (item.kind !== 'task') throw new Error('Only an ordinary task can be converted to a routine.');
          item.kind = 'routine';
          item.routine = { time: command.routineTime, timeZone: zone, nextDueAt: nextDailyDue(next.clock, command.routineTime, zone), occurrences: [] };
          item.steps = proposedSteps(command.routineSteps ?? [requiredText(command.nextStep, 'Routine step')]);
        } else if (command.routineTime !== item.routine.time || zone !== (item.routine.timeZone ?? 'UTC')) {
          item.routine.time = command.routineTime;
          item.routine.timeZone = zone;
          item.routine.nextDueAt = nextRoutineDue(next.clock, item.routine);
        }
      }
      if (command.routineTimeZone !== undefined && command.routineTime === undefined) {
        if (!item.routine) throw new Error('Choose a daily time before setting a routine timezone.');
        validateTimeZone(command.routineTimeZone);
        if (command.routineTimeZone !== (item.routine.timeZone ?? 'UTC')) {
          item.routine.timeZone = command.routineTimeZone;
          item.routine.nextDueAt = nextRoutineDue(next.clock, item.routine);
        }
      }
      if (command.routineSteps !== undefined) {
        if (!item.routine) throw new Error('Only a routine has ordered step templates.');
        item.steps = proposedSteps(command.routineSteps);
      }
      for (const capture of next.captures) {
        if (next.runtime === 'desktop' && capture.itemId === item.id && (capture.interpretation === 'pending' || capture.interpretation === 'error')) {
          capture.actionEdited = true;
        }
      }
      break;
    case 'step': {
      requireActionable(item, next);
      const steps = item.kind === 'routine' ? getOccurrence(item).steps : item.steps;
      const index = steps.findIndex(step => step.id === command.stepId);
      if (index < 0) throw new Error('This checklist step does not exist.');
      if (item.kind === 'routine') {
        if (command.done && steps.slice(0, index).some(step => !step.doneAt)) {
          throw new Error('Complete the earlier routine steps first.');
        }
        if (!command.done && steps.slice(index + 1).some(step => step.doneAt)) {
          throw new Error('Uncheck the later routine steps first.');
        }
      }
      if (command.done) steps[index].doneAt ??= next.clock;
      else delete steps[index].doneAt;
      break;
    }
    case 'snooze': {
      requireActionable(item, next);
      const occurrence = getOccurrence(item);
      if (!Number.isFinite(command.minutes) || command.minutes <= 0) {
        throw new Error('Choose a positive number of minutes to snooze.');
      }
      const until = timestamp(next.clock) + command.minutes * 60_000;
      if (!Number.isFinite(new Date(until).getTime())) throw new Error('The snooze time is out of range.');
      occurrence.snoozedUntil = new Date(until).toISOString();
      occurrence.reminderDismissed = true;
      clearActive(next, item.id);
      break;
    }
    case 'skip':
      requireOpen(item);
      if (item.status !== 'available') throw new Error('Restore this routine before skipping it.');
      finishOccurrence(item, next, 'skipped');
      clearActive(next, item.id);
      break;
    case 'dismiss-reminder':
      getOccurrence(item).reminderDismissed = true;
      break;
    default:
      throw new Error('Unknown command.');
  }
  if (JSON.stringify(item) !== JSON.stringify(getItem(state, item.id))) item.updatedAt = next.clock;
  eligibleActive(next);
  return recordDecision(state, next, command.type);
}

export function applyCommand(state: AppState, command: Command): AppState {
  const next = applyCommandInternal(state, command);
  if (state.runtime === 'desktop') {
    if (['capture', 'edit', 'complete', 'defer', 'sleep', 'wait', 'restore', 'remove', 'step', 'skip', 'undo'].includes(command.type)) {
      delete next.aiRanking;
    }
    reconcileAiRanking(next);
  }
  return next;
}
