import { nextDailyDue } from './clock.ts';
import { routineSteps } from './fixtures.ts';
import type { Routine, Step, WorkItem } from './types.ts';

export type Interpretation =
  | { kind: 'review'; title: string; nextStep: string; review: NonNullable<WorkItem['review']>; explanation: string }
  | { kind: 'routine'; title: string; nextStep: string; routine: Routine; steps: Step[]; explanation: string }
  | { kind: 'unsupported'; explanation: string };

export function knownReviewIdentity(text: string): string | undefined {
  const references = [
    ['harbor', '42'], ['harbor', '43'], ['terraform-provider', '87'],
  ];
  const matches = references.filter(([repo, number]) => {
    const url = new RegExp(`demo://github/${repo}/pull/${number}(?![\\w/])`, 'i');
    const shorthand = new RegExp(`(?<![\\w/#-])${repo}#${number}(?![\\w/-])`, 'i');
    return url.test(text) || shorthand.test(text);
  });
  if (matches.length !== 1) return undefined;
  return `demo://github/${matches[0][0]}/pull/${matches[0][1]}`;
}

export function interpretText(original: string, clock: string): Interpretation {
  const text = original.trim();
  const scheduled = /^(?:every day|daily)\s+at\s+(10\s*a\.?m\.?|(?:[01]\d|2[0-3]):[0-5]\d)\s*,?\s+(.+?)\s*,?\s+then\s+(.+?)\s*$/i.exec(text);
  if (scheduled) {
    const announce = scheduled[2];
    const increase = scheduled[3];
    const clearAnnouncement = /^(?:alert|notify)\s+(?:the\s+)?(?:slack(?:\s+channels?)?|channels?)(?:\s+that\s+I\s+am\s+increasing\s+(?:a|the)\s+feature[- ]flag)?$/i.test(announce)
      || /^announce\s+(?:the\s+)?change\s+(?:to|in|on)\s+(?:the\s+)?(?:slack(?:\s+channels?)?|channels?)$/i.test(announce);
    const clearIncrease = /^increase\s+(?:(?:the|a)\s+)?(?:feature[- ]flag|flag)[.!]?$/i.test(increase)
      || (/^increase\s+it[.!]?$/i.test(increase) && /\bfeature[- ]flag\b/i.test(announce));
    if (clearAnnouncement && clearIncrease) {
      const time = /am|a\.m/i.test(scheduled[1]) ? '10:00' : scheduled[1];
      return {
        kind: 'routine', title: 'Daily feature-flag rollout', nextStep: 'Announce change',
        routine: { time, nextDueAt: nextDailyDue(clock, time), occurrences: [] },
        steps: routineSteps(),
        explanation: `Local rule: daily at ${time} UTC, announce first, then increase the flag. No external actions run.`,
      };
    }
  }

  const reviewPhrase = /^(?:drive[- ]by(?: request)?:\s*)?(?:(?:can|could|would)\s+you\s+|please\s+|(?:i\s+)?need\s+to\s+)?review\b/i.test(text);
  const ambiguousSchedule = /\b(?:daily|every day|tomorrow|by\s+\w+|at\s+\d|maybe|perhaps)\b/i.test(text);
  if (reviewPhrase && !ambiguousSchedule) {
    const identity = knownReviewIdentity(text);
    return {
      kind: 'review', title: text, review: { request: 'manual', ...(identity ? { identity } : {}) },
      nextStep: identity ? 'Read the PR and leave a review in your usual tool.' : 'Find the PR reference before reviewing.',
      explanation: identity
        ? 'Local rule: review request linked to a known synthetic PR. No deadline or effort estimate inferred.'
        : 'Local rule: unlinked review request. No PR, deadline, or diff size invented.',
    };
  }
  return {
    kind: 'unsupported',
    explanation: 'Saved as an ordinary task. The local rules cannot confidently interpret this text; no schedule or external action was inferred.',
  };
}
