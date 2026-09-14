import type { WaitingBucket, WaitingDigest, WaitingItem } from '../../service/src/schema.ts';
import type { TaskCapture } from '../types.ts';

export const waitingLabels: Record<WaitingBucket['id'], { title: string; summary: string; action: string }> = {
  'direct-review': { title: 'Review requested of me', summary: 'Direct reviews', action: 'I need to review.' },
  'team-review': { title: 'Team review requested - integrations/terraform-provider-core-maintainers', summary: 'Provider Core Maintainers team reviews', action: 'I need to review as a team member.' },
  'ready-to-merge': { title: 'My PR - ready to merge', summary: 'Ready to merge', action: 'I need to merge.' },
  'needs-fix': { title: 'My PR - needs my fix', summary: 'Needs my fix', action: 'I need to fix the listed blockers.' },
  mentioned: { title: 'Mentioned - may owe a reply', summary: 'Mentions', action: 'Check if I owe a reply. A mention is not proof.' },
  reviewed: { title: 'PR I reviewed - recent activity', summary: 'Reviewed PRs', action: 'May need a re-review. Recent activity is only a light signal.' },
  assigned: { title: 'Assigned issue', summary: 'Assigned issues', action: 'My task.' },
};

const reasonLabels: Record<WaitingItem['reasons'][number], string> = {
  'changes-requested': 'changes requested', conflicts: 'conflicts', ci: 'CI failing',
};
export function waitingIdentity(item: WaitingItem): string {
  return `${item.reference.repo}#${item.reference.number}`;
}
export function waitingKey(item: WaitingItem): string { return waitingIdentity(item).toLowerCase(); }
export function waitingUrl(item: WaitingItem): string {
  const { repo, kind, number } = item.reference;
  return `https://github.com/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${number}`;
}
export function waitingAge(item: WaitingItem, fetchedAt: string): number {
  return Math.max(0, Math.floor((Date.parse(fetchedAt) - Date.parse(item.updatedAt)) / 86_400_000));
}
export function waitingDate(digest: WaitingDigest, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(digest.fetchedAt));
}
export function waitingReasons(item: WaitingItem): string {
  return item.reasons.map(reason => reasonLabels[reason]).join(' / ');
}
export function waitingCaptures(digest: WaitingDigest, checked: ReadonlySet<string>): TaskCapture[] {
  return digest.buckets.flatMap(bucket => bucket.items.filter(item => checked.has(waitingKey(item))).map(item => ({
    title: item.title,
    notes: [
      waitingLabels[bucket.id].action,
      item.reasons.length ? `Fix: ${waitingReasons(item)}` : '',
      waitingUrl(item),
    ].filter(Boolean).join('\n'),
  })));
}
export function waitingSummary(digest: WaitingDigest, compact = false): string {
  return digest.buckets.map(bucket => `${waitingLabels[bucket.id][compact ? 'summary' : 'title']}: ${bucket.items.length}`).join('; ');
}
export function waitingCoverage(digest: WaitingDigest): string {
  if (!digest.limitedQueries.length) return '';
  const names = digest.limitedQueries.map(id => id === 'authored' ? 'My authored PRs' : waitingLabels[id].title);
  return `Search limit reached (50 results): ${names.join('; ')}. More items may be waiting.`;
}
function markdownText(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/[\u2013\u2014]/g, '-').replace(/([\\`*_[\]<>])/g, '\\$1');
}
export function waitingMarkdown(digest: WaitingDigest, timeZone: string, checked: ReadonlySet<string> = new Set()): string {
  const coverage = waitingCoverage(digest);
  if (!digest.buckets.length) return coverage
    ? `No waiting items found in the returned results.\n\n${coverage}`
    : 'Nothing is waiting on you right now.';
  const lines = [`# Waiting on me - ${waitingDate(digest, timeZone)}`, '', waitingSummary(digest)];
  if (coverage) lines.push('', coverage);
  for (const bucket of digest.buckets) {
    lines.push('', `## ${waitingLabels[bucket.id].title}`, '');
    for (const item of bucket.items) {
      const reasons = waitingReasons(item);
      lines.push(`- [${checked.has(waitingKey(item)) ? 'x' : ' '}] ${waitingIdentity(item)} - ${markdownText(item.title)}${reasons ? ` (fix: ${reasons})` : ''} (${item.author ? `@${item.author}` : 'author unavailable'}, ${waitingAge(item, digest.fetchedAt)}d) ${waitingUrl(item)}`);
    }
  }
  return lines.join('\n');
}
