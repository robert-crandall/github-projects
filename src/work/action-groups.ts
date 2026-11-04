import type { SavedAssessment } from '../../service/src/work-assessment.ts';
import type { WorkStyle } from '../../service/src/work-styles.ts';
import type { Task } from '../types.ts';
import { taskStyles } from './styles.ts';

export type ActionGroupId =
  | 'needs-action'
  | 'review-pr'
  | 'work-issue'
  | 'safe-archive'
  | 'unsubscribe-filter';

export interface ActionGroupDefinition {
  id: ActionGroupId;
  title: string;
  description: string;
  badgeLabel: string;
}

export const ACTION_GROUP_DEFINITIONS: readonly ActionGroupDefinition[] = [
  {
    id: 'needs-action',
    title: 'Needs reading or reply',
    description: 'Direct emails, urgent alerts, and follow-ups that likely need your eyes.',
    badgeLabel: 'Needs action',
  },
  {
    id: 'review-pr',
    title: 'Review or merge PR',
    description: 'Pull requests waiting on your review, fixes, or merge.',
    badgeLabel: 'PR review',
  },
  {
    id: 'work-issue',
    title: 'Work on issue',
    description: 'Assigned or actionable GitHub issues.',
    badgeLabel: 'Issue',
  },
  {
    id: 'safe-archive',
    title: 'Safe to archive',
    description: 'Receipts, shipping updates, routine confirmations, and resolved alerts.',
    badgeLabel: 'Safe to archive',
  },
  {
    id: 'unsubscribe-filter',
    title: 'Unsubscribe or filter sender',
    description: 'Newsletters, marketing, and bulk senders with unsubscribe or mailing-list headers.',
    badgeLabel: 'Unsubscribe / Filter',
  },
] as const;

export interface TaskActionClassification {
  groupId: ActionGroupId;
  badge: string;
  reason: string;
  senderKey?: string;
  senderLabel?: string;
}

export interface SenderCluster {
  key: string;
  label: string;
  from?: string;
  list?: string;
  senderEmail?: string;
  listId?: string;
  taskIds: string[];
  unsubscribeUrl?: string;
}

export interface ActionGroupTaskItem {
  task: Task;
  classification: TaskActionClassification;
}

export interface ActionGroupBucket {
  definition: ActionGroupDefinition;
  tasks: ActionGroupTaskItem[];
  classifications: Map<string, TaskActionClassification>;
  senderClusters: SenderCluster[];
}

const BADGE_BY_GROUP: Record<ActionGroupId, string> = {
  'needs-action': 'Needs action',
  'review-pr': 'PR review',
  'work-issue': 'Issue',
  'safe-archive': 'Safe to archive',
  'unsubscribe-filter': 'Unsubscribe / Filter',
};

const URGENT_EMAIL_PATTERN =
  /\b(down\s*\||action required\b|urgent\b|payment failed\b|past due\b|declined\b|fraud alert\b|unexpected charge\b|unusual activity\b|security alert:\s*unusual\b|immediate attention\b)/i;

const SHIPPING_EMAIL_PATTERN =
  /\b(pre-arrival|driver is arriving|out for delivery|scheduled for delivery|package\b.*\bdelivered|your package|shipment|tracking number|has shipped|order shipped|ups update|ups my choice|fedex|usps|dhl)\b/i;

const RECEIPT_EMAIL_PATTERN =
  /\b(order receipt|your\b.*\breceipt|payment received|payment confirmation|order confirmation|auto-?pay|statement is ready|booking confirmation|reservation confirmed|e-?receipt|purchase receipt)\b/i;

const STATUS_FYI_EMAIL_PATTERN =
  /\b(up\s*\||resolved\s*\||recovery\s*\||verification code\b|one-time passcode\b|security code\b|new sign-in\b|backup[s]?\s+succeeded\b)/i;

const AUTOMATED_SENDER_PATTERN =
  /(?:^|[<@\s])(no-?reply|noreply|do-not-reply|notifications?|alerts?|receipts?|orders?|billing|auto-confirm)@/i;

const PROMO_EMAIL_PATTERN =
  /\b(unsubscribe|newsletter|weekly digest|daily digest|points have moved|rewards|special offer|%\s*off|limited time|sale ends|promotional|webinar|survey)\b/i;

const WORK_STYLE_GROUP_PRIORITY: Record<ActionGroupId, number> = {
  'needs-action': 1,
  'review-pr': 2,
  'work-issue': 3,
  'unsubscribe-filter': 4,
  'safe-archive': 5,
};

function classifySingleWorkStyle(style: WorkStyle): ActionGroupId | null {
  const text = `${style.name} ${style.description}`;
  if (/\b(reply|urgent|action|important|respond|read)\b/i.test(style.name)) {
    return 'needs-action';
  }
  if (/\b(review|pr\b|pull request)\b/i.test(style.name)) {
    return 'review-pr';
  }
  if (/\b(implement|issue|bug)\b/i.test(style.name)) {
    return 'work-issue';
  }
  if (/\b(unsubscribe|filter|newsletter|marketing|promo|spam)\b/i.test(style.name)) {
    return 'unsubscribe-filter';
  }
  if (/\b(archive|receipt|shipping|fyi|low[\s-]?priority|auto[\s-]?archive)\b/i.test(style.name)) {
    return 'safe-archive';
  }
  if (/\b(unsubscribe|newsletter)\b/i.test(text)) {
    return 'unsubscribe-filter';
  }
  if (/\b(safe to archive|auto-?archive)\b/i.test(text)) {
    return 'safe-archive';
  }
  return null;
}

function matchWorkStyleGroup(styles: WorkStyle[]): { groupId: ActionGroupId; styleName: string } | null {
  let best: { groupId: ActionGroupId; styleName: string } | null = null;
  for (const style of styles) {
    const groupId = classifySingleWorkStyle(style);
    if (!groupId) continue;
    if (!best || WORK_STYLE_GROUP_PRIORITY[groupId] < WORK_STYLE_GROUP_PRIORITY[best.groupId]) {
      best = { groupId, styleName: style.name };
    }
  }
  return best;
}

function senderIdentity(task: Task): { key?: string; label?: string; from?: string; list?: string } {
  const email = task.work?.email;
  if (!email) return {};
  const cleanEmail = email.senderEmail?.trim().toLowerCase();
  const cleanList = email.listId?.trim().toLowerCase();
  const displayFrom = email.from.replace(/<[^>]+>/g, '').replace(/"/g, '').trim() || cleanEmail || email.from;
  if (cleanEmail) {
    return { key: `from:${cleanEmail}`, label: displayFrom, from: cleanEmail, ...(cleanList ? { list: cleanList } : {}) };
  }
  if (cleanList) {
    return { key: `list:${cleanList}`, label: cleanList, list: cleanList };
  }
  return { label: displayFrom };
}

export function isGmailTask(task: Task): boolean {
  return Boolean(task.work?.email || task.work?.evidence.some(item => item.source === 'gmail'));
}

export function classifyTaskActionGroup(
  task: Task,
  styles: WorkStyle[] = [],
  assessment?: SavedAssessment,
): TaskActionClassification {
  const sender = senderIdentity(task);
  const withBadge = (
    groupId: ActionGroupId,
    reason: string,
    extra: { senderKey?: string; senderLabel?: string } = {},
  ): TaskActionClassification => ({
    groupId,
    badge: BADGE_BY_GROUP[groupId],
    reason,
    ...(extra.senderKey ? { senderKey: extra.senderKey } : {}),
    ...(extra.senderLabel ? { senderLabel: extra.senderLabel } : {}),
  });

  const assignedStyles = styles.length > 0 ? taskStyles(task, styles, assessment) : [];
  const styleMatch = matchWorkStyleGroup(assignedStyles);
  if (styleMatch) {
    return withBadge(styleMatch.groupId, `Work style: ${styleMatch.styleName}`, {
      senderKey: sender.key,
      senderLabel: sender.label,
    });
  }

  const ref = task.work?.reference;
  const action = task.work?.action;
  if (ref?.kind === 'issue' || action === 'implement') {
    return withBadge('work-issue', ref ? `Issue · ${ref.repo}#${ref.number}` : 'Work on issue');
  }

  if (ref?.kind === 'pr' || action === 'review' || action === 'merge' || action === 'fix') {
    const label = action === 'fix' ? 'Fix PR' : action === 'merge' ? 'Merge PR' : 'PR review';
    return withBadge('review-pr', ref ? `${label} · ${ref.repo}#${ref.number}` : label);
  }

  if (isGmailTask(task)) {
    const email = task.work?.email;
    const subject = email?.subject || task.title;
    const from = email?.from || '';
    const snippet = email?.snippet || '';
    const combined = `${subject}\n${from}\n${snippet}`;
    const senderExtra = { senderKey: sender.key, senderLabel: sender.label };

    if (URGENT_EMAIL_PATTERN.test(subject) || URGENT_EMAIL_PATTERN.test(snippet)) {
      return withBadge(
        'needs-action',
        sender.label ? `Attention required · ${sender.label}` : 'Attention required',
        senderExtra,
      );
    }

    if (SHIPPING_EMAIL_PATTERN.test(subject) || SHIPPING_EMAIL_PATTERN.test(from)) {
      return withBadge(
        'safe-archive',
        sender.label ? `Shipping update · ${sender.label}` : 'Shipping update',
        senderExtra,
      );
    }

    if (RECEIPT_EMAIL_PATTERN.test(subject) || RECEIPT_EMAIL_PATTERN.test(snippet)) {
      return withBadge(
        'safe-archive',
        sender.label ? `Receipt / confirmation · ${sender.label}` : 'Receipt / confirmation',
        senderExtra,
      );
    }

    if (STATUS_FYI_EMAIL_PATTERN.test(subject)) {
      return withBadge(
        'safe-archive',
        sender.label ? `Status / verification · ${sender.label}` : 'Status / verification',
        senderExtra,
      );
    }

    if (email?.unsubscribeUrl || email?.listId || PROMO_EMAIL_PATTERN.test(combined)) {
      const detail = email?.unsubscribeUrl
        ? 'Unsubscribe link available'
        : email?.listId
          ? `Mailing list · ${email.listId}`
          : 'Newsletter / bulk email';
      return withBadge(
        'unsubscribe-filter',
        sender.label ? `${detail} · ${sender.label}` : detail,
        senderExtra,
      );
    }

    if (AUTOMATED_SENDER_PATTERN.test(from) || (email?.senderEmail && AUTOMATED_SENDER_PATTERN.test(email.senderEmail))) {
      return withBadge(
        'needs-action',
        sender.label ? `Automated notification · ${sender.label}` : 'Automated notification',
        senderExtra,
      );
    }

    return withBadge(
      'needs-action',
      sender.label ? `Direct email · ${sender.label}` : 'Direct email',
      senderExtra,
    );
  }

  return withBadge(
    'needs-action',
    task.work?.notification ? 'GitHub notification' : 'Follow-up task',
  );
}

export function groupTasksByAction(
  tasks: readonly Task[],
  styles: WorkStyle[] = [],
  assessments?: ReadonlyMap<string, SavedAssessment>,
): ActionGroupBucket[] {
  const byGroup = new Map<ActionGroupId, {
    tasks: ActionGroupTaskItem[];
    classifications: Map<string, TaskActionClassification>;
    clusters: Map<string, SenderCluster>;
    firstRankIndex: number;
  }>();

  for (const def of ACTION_GROUP_DEFINITIONS) {
    byGroup.set(def.id, {
      tasks: [],
      classifications: new Map(),
      clusters: new Map(),
      firstRankIndex: Number.POSITIVE_INFINITY,
    });
  }

  tasks.forEach((task, index) => {
    const classification = classifyTaskActionGroup(task, styles, assessments?.get(task.id));
    const bucket = byGroup.get(classification.groupId)!;
    if (bucket.tasks.length === 0) {
      bucket.firstRankIndex = index;
    }
    bucket.tasks.push({ task, classification });
    bucket.classifications.set(task.id, classification);

    const sender = senderIdentity(task);
    if (sender.key && (sender.from || sender.list)) {
      const existing = bucket.clusters.get(sender.key);
      const unsubscribeUrl = task.work?.email?.unsubscribeUrl;
      if (existing) {
        existing.taskIds.push(task.id);
        if (!existing.unsubscribeUrl && unsubscribeUrl) {
          existing.unsubscribeUrl = unsubscribeUrl;
        }
      } else {
        bucket.clusters.set(sender.key, {
          key: sender.key,
          label: sender.label ?? sender.from ?? sender.list ?? sender.key,
          ...(sender.from ? { from: sender.from, senderEmail: sender.from } : {}),
          ...(sender.list ? { list: sender.list, listId: sender.list } : {}),
          taskIds: [task.id],
          ...(unsubscribeUrl ? { unsubscribeUrl } : {}),
        });
      }
    }
  });

  const isLowPriorityGroup = (id: ActionGroupId) => id === 'safe-archive' || id === 'unsubscribe-filter';
  const orderedDefinitions = [...ACTION_GROUP_DEFINITIONS].sort((a, b) => {
    const aLow = isLowPriorityGroup(a.id);
    const bLow = isLowPriorityGroup(b.id);
    if (aLow !== bLow) return aLow ? 1 : -1;
    if (!aLow && !bLow) {
      const aFirst = byGroup.get(a.id)!.firstRankIndex;
      const bFirst = byGroup.get(b.id)!.firstRankIndex;
      if (aFirst !== bFirst) return aFirst - bFirst;
    }
    return ACTION_GROUP_DEFINITIONS.indexOf(a) - ACTION_GROUP_DEFINITIONS.indexOf(b);
  });

  return orderedDefinitions
    .map(definition => {
      const entry = byGroup.get(definition.id)!;
      const senderClusters = [...entry.clusters.values()].sort(
        (a, b) => b.taskIds.length - a.taskIds.length || a.label.localeCompare(b.label),
      );
      return {
        definition,
        tasks: entry.tasks,
        classifications: entry.classifications,
        senderClusters,
      };
    })
    .filter(bucket => bucket.tasks.length > 0);
}
