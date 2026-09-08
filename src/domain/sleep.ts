import type { WorkItem } from './types.ts';

export function canonicalGitHubReference(value: string | undefined): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port || url.search || url.hash) return;
    const match = /^\/([a-z\d-]+)\/([a-z\d_.-]+)\/(pull|issues)\/([1-9]\d*)\/?$/i.exec(url.pathname);
    if (match) return `https://github.com/${match[1].toLowerCase()}/${match[2].toLowerCase()}/${match[3].toLowerCase()}/${match[4]}`;
  } catch {
    return;
  }
}

export function githubReferences(item: WorkItem): string[] {
  return [...new Set([item.review?.identity, ...item.sources.map(source => source.reference)]
    .map(canonicalGitHubReference).filter((reference): reference is string => !!reference))];
}

export function wakeItem(item: WorkItem, at: string, reason: NonNullable<WorkItem['wake']>['reason']): void {
  item.status = 'available';
  item.wake = { at, reason };
  delete item.sleep;
  delete item.availableAt;
  delete item.reason;
}
