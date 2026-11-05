import { describe, expect, test } from 'bun:test';
import { classifyTaskActionGroup, groupTasksByAction } from './action-groups.ts';
import type { SavedAssessment } from '../../service/src/work-assessment.ts';
import type { WorkStyle } from '../../service/src/work-styles.ts';
import type { Task } from '../types.ts';

function gmailTask(id: string, overrides: Partial<NonNullable<NonNullable<Task['work']>['email']>> & { title?: string }): Task {
  const { title = overrides.subject ?? 'Email subject', ...email } = overrides;
  return {
    id,
    title,
    notes: '',
    status: 'open',
    createdAt: '2026-04-17T00:00:00.000Z',
    work: {
      identity: `reply:https://mail.google.com/mail/u/0/#inbox/${id}`,
      action: 'reply',
      url: `https://mail.google.com/mail/u/0/#inbox/${id}`,
      availability: 'actionable',
      availabilityReason: '',
      handledEvidenceIds: [],
      evidence: [],
      email: {
        messageId: id,
        threadId: id,
        from: 'Sender <sender@example.com>',
        senderEmail: 'sender@example.com',
        subject: title,
        snippet: '',
        ...email,
      },
    },
  };
}

describe('classifyTaskActionGroup', () => {
  test('routes shipping updates and receipts to safe-archive even when an unsubscribe link is present', () => {
    const ups = gmailTask('ups-1', {
      from: 'UPS <mcinfo@ups.com>',
      senderEmail: 'mcinfo@ups.com',
      subject: 'UPS Update: Package Scheduled for Delivery Tomorrow',
      snippet: 'Hi ROBERT, you have a package coming tomorrow.',
      unsubscribeUrl: 'https://www.ups.com/unsubscribe',
    });
    const receipt = gmailTask('receipt-1', {
      from: 'Apple <no_reply@email.apple.com>',
      senderEmail: 'no_reply@email.apple.com',
      subject: 'Your receipt from Apple.',
      snippet: 'Receipt for iCloud+ with 2 TB storage',
    });

    expect(classifyTaskActionGroup(ups)).toMatchObject({
      groupId: 'safe-archive',
      badge: 'Safe to archive',
    });
    expect(classifyTaskActionGroup(receipt)).toMatchObject({
      groupId: 'safe-archive',
      badge: 'Safe to archive',
    });
  });

  test('keeps urgent failure, unpaid invoice, or unrecognized automated alerts in needs-action', () => {
    const downAlert = gmailTask('down-1', {
      from: 'Healthchecks <noreply@healthchecks.io>',
      senderEmail: 'noreply@healthchecks.io',
      subject: 'DOWN | Postgres DB backups',
      snippet: 'Check "Postgres DB backups" is DOWN.',
      unsubscribeUrl: 'https://healthchecks.io/unsubscribe',
    });
    const invoiceDue = gmailTask('inv-1', {
      from: 'Vendor <billing@vendor.example.com>',
      senderEmail: 'billing@vendor.example.com',
      subject: 'Invoice 123 - payment due Friday',
      snippet: 'Please remit payment by Friday.',
    });
    const resetNotice = gmailTask('reset-1', {
      from: 'Account <noreply@example.com>',
      senderEmail: 'noreply@example.com',
      subject: 'Reset your password to keep access',
      snippet: 'Your password expires soon.',
    });

    expect(classifyTaskActionGroup(downAlert)).toMatchObject({
      groupId: 'needs-action',
      badge: 'Needs action',
    });
    expect(classifyTaskActionGroup(invoiceDue)).toMatchObject({
      groupId: 'needs-action',
      badge: 'Needs action',
    });
    expect(classifyTaskActionGroup(resetNotice)).toMatchObject({
      groupId: 'needs-action',
      badge: 'Needs action',
    });

    const subjectReplyReceipt = gmailTask('reply-receipt-1', {
      from: 'Alex <alex@company.com>',
      senderEmail: 'alex@company.com',
      subject: 'Can you send me your order receipt?',
      snippet: 'Please reply with a copy for expense reporting.',
    });
    const snippetReplyReceipt = gmailTask('reply-receipt-2', {
      from: 'Finance <finance@company.com>',
      senderEmail: 'finance@company.com',
      subject: 'Your order receipt #402',
      snippet: 'Please reply with a copy once signed.',
    });
    expect(classifyTaskActionGroup(subjectReplyReceipt)).toMatchObject({
      groupId: 'needs-action',
      badge: 'Needs action',
    });
    expect(classifyTaskActionGroup(snippetReplyReceipt)).toMatchObject({
      groupId: 'needs-action',
      badge: 'Needs action',
    });
  });

  test('routes newsletters and promotional emails with unsubscribeUrl or listId to unsubscribe-filter', () => {
    const promo = gmailTask('promo-1', {
      from: 'Nexaph <support@nexaph.com>',
      senderEmail: 'support@nexaph.com',
      subject: 'BOGO T30 + T60 SALE!',
      snippet: 'Limited time offer',
      unsubscribeUrl: 'https://nexaph.com/unsubscribe',
    });
    const listMail = gmailTask('list-1', {
      from: 'Weekly Digest <digest@example.com>',
      senderEmail: 'digest@example.com',
      subject: 'This week in engineering',
      listId: 'digest.example.com',
    });

    expect(classifyTaskActionGroup(promo)).toMatchObject({
      groupId: 'unsubscribe-filter',
      badge: 'Unsubscribe / Filter',
    });
    expect(classifyTaskActionGroup(listMail)).toMatchObject({
      groupId: 'unsubscribe-filter',
      badge: 'Unsubscribe / Filter',
    });
  });

  test('routes GitHub PRs to review-pr and issues to work-issue', () => {
    const prTask: Task = {
      id: 'pr-1',
      title: 'Review PR #42',
      notes: '',
      status: 'open',
      createdAt: '2026-04-17T00:00:00.000Z',
      work: {
        identity: 'review:https://github.com/owner/repo/pull/42',
        action: 'review',
        url: 'https://github.com/owner/repo/pull/42',
        reference: { repo: 'owner/repo', kind: 'pr', number: 42 },
        availability: 'actionable',
        availabilityReason: '',
        handledEvidenceIds: [],
        evidence: [],
      },
    };
    const issueTask: Task = {
      id: 'issue-1',
      title: 'Fix login timeout',
      notes: '',
      status: 'open',
      createdAt: '2026-04-17T00:00:00.000Z',
      work: {
        identity: 'fix:https://github.com/owner/repo/issues/99',
        action: 'fix',
        url: 'https://github.com/owner/repo/issues/99',
        reference: { repo: 'owner/repo', kind: 'issue', number: 99 },
        availability: 'actionable',
        availabilityReason: '',
        handledEvidenceIds: [],
        evidence: [],
      },
    };

    expect(classifyTaskActionGroup(prTask).groupId).toBe('review-pr');
    expect(classifyTaskActionGroup(issueTask).groupId).toBe('work-issue');
  });

  test('work style assignments override default heuristics and give action styles precedence over archive', () => {
    const archiveStyle: WorkStyle = { id: 'style-archive', name: 'Safe to archive', description: 'No reply needed' };
    const actionStyle: WorkStyle = { id: 'style-action', name: 'Needs action', description: 'Requires reading or reply' };
    const directEmail = {
      ...gmailTask('direct-1', {
        from: 'Alice <alice@example.com>',
        senderEmail: 'alice@example.com',
        subject: 'FYI notes from earlier',
      }),
      workStyleOverride: ['style-archive'],
    };

    expect(classifyTaskActionGroup(directEmail, [archiveStyle])).toMatchObject({
      groupId: 'safe-archive',
      reason: 'Work style: Safe to archive',
    });

    const conflictingTask = {
      ...directEmail,
      workStyleOverride: ['style-archive', 'style-action'],
    };
    expect(classifyTaskActionGroup(conflictingTask, [archiveStyle, actionStyle])).toMatchObject({
      groupId: 'needs-action',
      reason: 'Work style: Needs action',
    });
    expect(classifyTaskActionGroup(conflictingTask, [actionStyle, archiveStyle])).toMatchObject({
      groupId: 'needs-action',
      reason: 'Work style: Needs action',
    });
  });
});

describe('groupTasksByAction', () => {
  test('groups tasks into ordered buckets and aggregates sender clusters by senderEmail', () => {
    const tasks: Task[] = [
      gmailTask('ups-1', {
        from: 'UPS <mcinfo@ups.com>',
        senderEmail: 'mcinfo@ups.com',
        subject: 'UPS Update: Package Scheduled for Delivery Tomorrow',
      }),
      gmailTask('ups-2', {
        from: 'UPS <mcinfo@ups.com>',
        senderEmail: 'mcinfo@ups.com',
        subject: 'UPS Update: Follow Your Delivery on a Live Map',
      }),
      gmailTask('promo-1', {
        from: 'Nexaph <support@nexaph.com>',
        senderEmail: 'support@nexaph.com',
        subject: 'BOGO SALE!',
        unsubscribeUrl: 'https://nexaph.com/unsubscribe',
      }),
      gmailTask('direct-1', {
        from: 'Tax Advisor <cpa@example.com>',
        senderEmail: 'cpa@example.com',
        subject: 'Question about your 2025 return',
      }),
    ];

    const groups = groupTasksByAction(tasks, [], new Map<string, SavedAssessment>());
    expect(groups.map(group => group.definition.id)).toEqual([
      'needs-action',
      'safe-archive',
      'unsubscribe-filter',
    ]);

    const safeArchive = groups.find(group => group.definition.id === 'safe-archive')!;
    expect(safeArchive.tasks).toHaveLength(2);
    expect(safeArchive.senderClusters).toEqual([
      {
        key: 'from:mcinfo@ups.com',
        label: 'UPS',
        from: 'mcinfo@ups.com',
        senderEmail: 'mcinfo@ups.com',
        taskIds: ['ups-1', 'ups-2'],
      },
    ]);
  });
});
