import { expect, test } from 'bun:test';
import type { WaitingDigest, WaitingItem } from '../../service/src/schema.ts';
import { waitingAge, waitingCaptures, waitingCoverage, waitingDate, waitingKey, waitingMarkdown, waitingUrl } from './waiting.ts';

const item: WaitingItem = {
  reference: { repo: 'Octo/project', number: 42, kind: 'pr' }, title: 'Keep notes',
  author: 'octocat', updatedAt: '2026-09-07T16:00:00Z', reasons: [],
};
const digest: WaitingDigest = {
  fetchedAt: '2026-09-14T16:00:00Z', viewer: 'viewer', limitedQueries: [],
  buckets: [
    { id: 'direct-review', items: [item] },
    { id: 'team-review', items: [{ ...item, reference: { ...item.reference, number: 43 } }] },
  ],
};

test('digest Markdown keeps direct and exact team counts distinct with only nonempty checklists', () => {
  expect(waitingMarkdown(digest, 'UTC')).toBe([
    '# Waiting on me - 2026-09-14', '',
    'Review requested of me: 1; Team review requested - integrations/terraform-provider-core-maintainers: 1', '',
    '## Review requested of me', '',
    '- [ ] Octo/project#42 - Keep notes (@octocat, 7d) https://github.com/Octo/project/pull/42', '',
    '## Team review requested - integrations/terraform-provider-core-maintainers', '',
    '- [ ] Octo/project#43 - Keep notes (@octocat, 7d) https://github.com/Octo/project/pull/43',
  ].join('\n'));
});

test('empty and limited digests distinguish absence of matches from full coverage', () => {
  expect(waitingMarkdown({ ...digest, buckets: [] }, 'UTC')).toBe('Nothing is waiting on you right now.');
  const limited: WaitingDigest = { ...digest, buckets: [], limitedQueries: ['authored', 'team-review'] };
  const markdown = waitingMarkdown(limited, 'UTC');
  expect(markdown).toContain('No waiting items found in the returned results.');
  expect(markdown).not.toContain('Nothing is waiting');
  expect(waitingCoverage(limited)).toContain('My authored PRs; Team review requested - integrations/terraform-provider-core-maintainers');
  expect(markdown).toContain('More items may be waiting.');
});

test('Markdown preserves fix causes and escapes untrusted multiline titles without rendering source markup', () => {
  const fix: WaitingItem = { ...item, author: null, title: 'Fix — [link](https://evil.test)\n<script>*markup*</script>',
    reasons: ['changes-requested', 'conflicts', 'ci'] };
  const text = waitingMarkdown({ ...digest, buckets: [{ id: 'needs-fix', items: [fix] }] }, 'UTC');
  expect(text.split('\n').filter(line => line.startsWith('- [')).length).toBe(1);
  expect(text).toContain('Fix - \\[link\\](https://evil.test) \\<script\\>\\*markup\\*\\</script\\>');
  expect(text).toContain('(fix: changes requested / conflicts / CI failing)');
  expect(text).toContain('(author unavailable, 7d)');
  expect(text).not.toContain('—');
});

test('local checkmarks affect only the copied checklist, not the source snapshot', () => {
  const original = structuredClone(digest);
  const checked = new Set([waitingKey(item)]);
  expect(waitingMarkdown(digest, 'UTC', checked)).toContain('- [x] Octo/project#42');
  expect(waitingMarkdown(digest, 'UTC', checked)).toContain('- [ ] Octo/project#43');
  expect(digest).toEqual(original);
  expect(waitingMarkdown(digest, 'UTC')).not.toContain('- [x]');
});

test('ages use the snapshot clock, dates use the workspace zone, and issue URLs stay issues', () => {
  expect(waitingAge(item, '2026-09-08T15:59:59Z')).toBe(0);
  expect(waitingAge(item, '2026-09-08T16:00:00Z')).toBe(1);
  expect(waitingAge(item, '2026-09-06T16:00:00Z')).toBe(0);
  expect(waitingDate({ ...digest, fetchedAt: '2026-09-14T00:30:00Z' }, 'America/Los_Angeles')).toBe('2026-09-13');
  expect(waitingUrl({ ...item, reference: { ...item.reference, kind: 'issue' } })).toBe('https://github.com/Octo/project/issues/42');
});

test('only checked digest items become captures, preserving actions, uncertainty, fix causes and source URLs', () => {
  const selected: WaitingDigest = { ...digest, buckets: [
    ...digest.buckets,
    { id: 'needs-fix', items: [{ ...item, reference: { ...item.reference, number: 44 }, reasons: ['changes-requested', 'ci'] }] },
    { id: 'mentioned', items: [{ ...item, reference: { ...item.reference, number: 45 } }] },
    { id: 'assigned', items: [{ ...item, reference: { ...item.reference, number: 46, kind: 'issue' } }] },
  ] };
  const original = structuredClone(selected);
  const checked = new Set(['octo/project#42', 'octo/project#44', 'octo/project#45', 'octo/project#46', 'unknown#1']);
  expect(waitingCaptures(selected, checked)).toEqual([
    { title: 'Keep notes', notes: 'I need to review.\nhttps://github.com/Octo/project/pull/42' },
    { title: 'Keep notes', notes: 'I need to fix the listed blockers.\nFix: changes requested / CI failing\nhttps://github.com/Octo/project/pull/44' },
    { title: 'Keep notes', notes: 'Check if I owe a reply. A mention is not proof.\nhttps://github.com/Octo/project/pull/45' },
    { title: 'Keep notes', notes: 'My task.\nhttps://github.com/Octo/project/issues/46' },
  ]);
  expect(waitingCaptures(selected, new Set())).toEqual([]);
  expect(selected).toEqual(original);
  expect(checked.size).toBe(5);
});
