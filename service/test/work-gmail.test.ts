import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkGmail, buildGmailctlRuleSnippet, insertGmailctlRuleIntoJsonnet, parseEmailAddress } from '../src/work-gmail.ts';
import { gmailWorkstream } from '../src/work-schema.ts';

describe('WorkGmail and gmailctl integration', () => {
  test('parses sender display name and email address', () => {
    expect(parseEmailAddress('"GitHub Billing" <billing@github.com>')).toEqual({
      name: 'GitHub Billing',
      email: 'billing@github.com',
    });
    expect(parseEmailAddress('alerts@monarchmoney.com')).toEqual({
      name: 'alerts@monarchmoney.com',
      email: 'alerts@monarchmoney.com',
    });
  });

  test('inserts a gmailctl filter rule before the closing rules array in config.jsonnet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gmailctl-test-'));
    try {
      const configPath = join(dir, 'config.jsonnet');
      writeFileSync(configPath, [
        'local lib = import \'gmailctl.libsonnet\';',
        '{',
        '  version: \'v1alpha3\',',
        '  rules: [',
        '    // Don\'t match bracket [ or ] in comments',
        '    {',
        '      filter: { from: "existing@example.com", subject: "don\'t [break]" },',
        '      actions: { archive: true },',
        '    },',
        '  ],',
        '}',
        '',
      ].join('\n'));

      const applied: Array<{ command: string; args: readonly string[] }> = [];
      const gmail = new WorkGmail({
        gmailctlConfigPath: configPath,
        resolveGmailctl: async () => '/opt/homebrew/bin/gmailctl',
        runner: async (command, args) => {
          applied.push({ command, args });
          return { code: 0, stdout: 'Applied', stderr: '' };
        },
      });

      const controller = new AbortController();
      const result = await gmail.addGmailctlFilter({
        operationId: 'op-filter-1',
        from: 'newsletter@example.com',
        subject: 'Weekly Digest',
        archive: true,
        markRead: true,
        deleteIt: false,
        apply: true,
      }, controller.signal);

      expect(result.status).toBe('confirmed');
      expect(result.applied).toBe(true);
      expect(applied).toEqual([{
        command: '/opt/homebrew/bin/gmailctl',
        args: ['apply', '--config', dir, '--yes'],
      }]);

      const updated = readFileSync(configPath, 'utf8');
      expect(updated).toContain("from: 'newsletter@example.com'");
      expect(updated).toContain("subject: 'Weekly Digest'");
      expect(updated).toContain('archive: true');
      expect(updated).toContain('markRead: true');

      // Duplicate rule is not inserted twice
      const second = insertGmailctlRuleIntoJsonnet(updated, buildGmailctlRuleSnippet({
        from: 'newsletter@example.com',
        subject: 'Weekly Digest',
        archive: true,
        markRead: true,
        deleteIt: false,
      }));
      expect(second).toBe(updated);

      // Missing trailing comma before closing bracket (with trailing comment) gets a separating comma
      const noTrailingComma = [
        '{',
        '  rules: [',
        '    { filter: { from: "a@example.com" }, actions: { archive: true } } // trailing comment',
        '  ]',
        '}',
      ].join('\n');
      const withComma = insertGmailctlRuleIntoJsonnet(noTrailingComma, buildGmailctlRuleSnippet({
        from: 'b@example.com',
        archive: true,
        markRead: false,
        deleteIt: false,
      }));
      expect(withComma).toContain('{ filter: { from: "a@example.com" }, actions: { archive: true } }, // trailing comment');
      expect(withComma).toContain("from: 'b@example.com'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('collects unread Gmail threads and archives threads via Gmail REST API', async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const gmail = new WorkGmail({
      credentialsLoader: async () => ({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'refresh-token',
      }),
      fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({
          url,
          method: init?.method ?? 'GET',
          body: typeof init?.body === 'string' ? init.body : undefined,
        });
        if (url.includes('oauth2.googleapis.com/token')) {
          return new Response(JSON.stringify({ access_token: 'tok-123' }), { status: 200 });
        }
        if (url.includes('/users/me/messages?')) {
          return new Response(JSON.stringify({
            messages: [{ id: 'msg_1', threadId: 'thr_abc' }],
          }), { status: 200 });
        }
        if (url.includes('/users/me/messages/msg_1?format=full')) {
          return new Response(JSON.stringify({
            id: 'msg_1',
            threadId: 'thr_abc',
            internalDate: String(Date.parse('2026-04-06T12:00:00.000Z')),
            labelIds: ['INBOX', 'UNREAD'],
            snippet: 'Unexpected charge of $89.99 on your Visa ending in 1234',
            payload: {
              headers: [
                { name: 'From', value: '"Chase Alerts" <no-reply@alertsp.chase.com>' },
                { name: 'Subject', value: 'A $89.99 transaction was charged to your account' },
                { name: 'List-Unsubscribe', value: '<https://alertsp.chase.com/unsubscribe>' },
              ],
            },
          }), { status: 200 });
        }
        if (url.includes('/users/me/threads/thr_abc/modify')) {
          return new Response(JSON.stringify({ id: 'thr_abc' }), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      }) as typeof fetch,
    });

    const controller = new AbortController();
    const stream = gmailWorkstream();
    const collected = await gmail.collect({
      stream,
      model: '',
      since: null,
      knownUrls: [],
      observeOnly: false,
    }, controller.signal);

    expect(collected.warnings).toEqual([]);
    expect(collected.candidates).toHaveLength(1);
    const candidate = collected.candidates[0]!;
    expect(candidate.url).toBe('https://mail.google.com/mail/u/0/#inbox/thr_abc');
    expect(candidate.email).toEqual({
      messageId: 'msg_1',
      threadId: 'thr_abc',
      from: '"Chase Alerts" <no-reply@alertsp.chase.com>',
      senderEmail: 'no-reply@alertsp.chase.com',
      subject: 'A $89.99 transaction was charged to your account',
      snippet: 'Unexpected charge of $89.99 on your Visa ending in 1234',
      unsubscribeUrl: 'https://alertsp.chase.com/unsubscribe',
    });

    const archived = await gmail.archive({
      operationId: 'op-arch-1',
      messageId: 'msg_1',
      threadId: 'thr_abc',
      markRead: true,
    }, controller.signal);
    expect(archived.status).toBe('confirmed');
    expect(archived.threadId).toBe('thr_abc');
    const modifyReq = requests.find(req => req.url.includes('/threads/thr_abc/modify'));
    expect(modifyReq?.method).toBe('POST');
    expect(JSON.parse(modifyReq?.body ?? '{}')).toEqual({ removeLabelIds: ['INBOX', 'UNREAD'] });
  });
});
