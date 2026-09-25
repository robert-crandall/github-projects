import { createHash } from 'node:crypto';
import { z } from 'zod';
import { checkAbort, ServiceError } from './errors.ts';
import { parse, requireStatus, type ApiResponse, type GitHubApi } from './github.ts';
import { referenceSchema, repoSchema, type Reference } from './schema.ts';
import { CODE_LIMITS, shaSchema, codePathSchema } from './code-review-schema.ts';
export { CODE_LIMITS, shaSchema, codePathSchema } from './code-review-schema.ts';
const branchSchema = z.string().min(1).max(250).refine(branch =>
  !/[\x00-\x20\x7f\\%?#:~^*[\]]/.test(branch)
  && branch.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
const sideSchema = z.enum(['head', 'base']);
export type CodeSide = z.infer<typeof sideSchema>;
export const listCodeSchema = z.strictObject({
  side: sideSchema, prefix: z.string().max(1024).refine(prefix => prefix === ''
    || codePathSchema.safeParse(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix).success),
  offset: z.number().int().min(0).max(CODE_LIMITS.treeEntries),
});
export const readCodeSchema = z.strictObject({
  side: sideSchema, path: codePathSchema,
  startLine: z.number().int().positive().max(CODE_LIMITS.fileBytes),
  endLine: z.number().int().positive().max(CODE_LIMITS.fileBytes),
}).refine(value => value.endLine >= value.startLine && value.endLine - value.startLine < CODE_LIMITS.lines);
export const codeHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// This transport is separate from GhApi: gh follows redirects before returning headers.
export class CodeGitHubApi implements GitHubApi {
  private readBytes = 0;
  constructor(private readonly credential: string, private readonly fetcher: typeof fetch = fetch) {}
  async request(method: 'GET' | 'DELETE' | 'PUT' | 'POST', endpoint: string, signal: AbortSignal, body?: unknown): Promise<ApiResponse> {
    const match = /^\/repos\/([^/]+\/[^/?]+)(\/.*)?$/.exec(endpoint);
    const route = match?.[2] ?? '';
    const allowed = match && repoSchema.safeParse(match[1]).success && (
      route === '' || /^\/(?:issues|pulls)\/[1-9]\d{0,15}$/.test(route)
      || /^\/git\/trees\/[a-f0-9]{40}\?recursive=1$/.test(route)
      || /^\/git\/blobs\/[a-f0-9]{40}$/.test(route)
      || /^\/compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40}\?per_page=1$/.test(route)
      || (() => {
        if (!route.startsWith('/commits/')) return false;
        try {
          const ref = decodeURIComponent(route.slice(9));
          return branchSchema.safeParse(ref).success && encodeURIComponent(ref) === route.slice(9);
        } catch { return false; }
      })()
    );
    if (method !== 'GET' || body !== undefined || !allowed) throw new ServiceError('invalid_input');
    checkAbort(signal);
    try {
      const response = await this.fetcher(`https://api.github.com${endpoint}`, {
        method: 'GET', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${this.credential}`, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28' },
      });
      const headers = Object.fromEntries(response.headers.entries());
      if (response.status !== 200) {
        await response.body?.cancel();
        requireStatus({ status: response.status, headers, body: null });
      }
      const reader = response.body?.getReader();
      if (!reader) throw new ServiceError('invalid_output');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          checkAbort(signal);
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          this.readBytes += next.value.byteLength;
          if (size > CODE_LIMITS.responseBytes || this.readBytes > CODE_LIMITS.readBytes) throw new ServiceError('limit');
          chunks.push(next.value);
        }
      } finally { await reader.cancel(); }
      checkAbort(signal);
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new ServiceError('invalid_output'); }
      return { status: response.status, headers, body: value, bytes: size };
    } catch (error) {
      checkAbort(signal);
      if (error instanceof ServiceError) throw error;
      throw new ServiceError('unavailable', true);
    }
  }
}

const repositorySchema = z.object({ full_name: repoSchema, default_branch: branchSchema });
const sourceSchema = z.object({
  number: z.number().int().positive().safe(), html_url: z.string(), title: z.string().max(1000),
  body: z.string().nullable(), updated_at: z.iso.datetime(), state: z.enum(['open', 'closed']),
  pull_request: z.object({}).optional(),
});
const prRevisionSchema = z.object({ sha: shaSchema, repo: z.object({ full_name: repoSchema }).nullable() });
const pullSchema = sourceSchema.extend({
  head: prRevisionSchema, base: prRevisionSchema,
  changed_files: z.number().int().nonnegative(), draft: z.boolean(), merged: z.boolean(),
});
const commitSchema = z.object({ sha: shaSchema, commit: z.object({ tree: z.object({ sha: shaSchema }) }) });
const treeEntrySchema = z.object({
  path: z.string(), mode: z.string(), type: z.enum(['blob', 'tree', 'commit']),
  sha: shaSchema, size: z.number().int().nonnegative().optional(),
});
const fileSchema = z.object({
  filename: z.string(), previous_filename: z.string().optional(),
  status: z.enum(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']),
  additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(),
  patch: z.string().optional(),
});
export type CodeChange = z.infer<typeof fileSchema> & { patchComplete: boolean };
export type CodeRevision = { repo: string; sha: string; tree: string };
export type CodeRead = {
  id: string; side: CodeSide; repo: string; revision: string; blob: string; path: string;
  startLine: number; endLine: number; totalLines: number; text: string;
};
export type CodeSource = {
  reference: Reference; url: string; title: string; body: string; updatedAt: string;
  state: string; fingerprint: string; observedAt: string;
  head: CodeRevision; base: CodeRevision | null; baseTip: string | null;
  defaultBranch: string | null; draft: boolean | null; merged: boolean | null;
};

export class CodeContext {
  source!: CodeSource;
  readonly changes: CodeChange[] = [];
  readonly reads: CodeRead[] = [];
  readonly warnings = new Set<string>([
    'Repository inspection is selective, not a whole-repository correctness or completion guarantee.',
    'Issue/PR comments, reviews, checks and private task notes are not included.',
  ]);
  private readonly trees = new Map<CodeSide, z.infer<typeof treeEntrySchema>[]>();
  private readonly changedLines = new Map<string, Map<number, string>>();
  private sourceFingerprint = '';
  private defaultBranch = '';
  private expectedFiles: number | null = null;
  private comparedFiles = 0;
  private requests = 0;
  private readBytes = 0;
  private contextBytes = 0;
  private toolCalls = 0;
  private fatal?: ServiceError;
  private closed = false;
  private readonly stop = new AbortController();
  readonly signal: AbortSignal;
  constructor(private readonly api: GitHubApi, private readonly ref: Reference, signal: AbortSignal) {
    this.signal = AbortSignal.any([signal, this.stop.signal]);
  }

  private check() {
    checkAbort(this.signal);
    if (this.closed) throw new ServiceError('cancelled', false, 'read');
    if (this.fatal) throw this.fatal;
  }
  close() {
    this.closed = true;
    this.stop.abort(new ServiceError('cancelled', false, 'read'));
  }
  private async get(path: string) {
    this.check();
    if (this.requests >= CODE_LIMITS.requests) throw new ServiceError('limit');
    this.requests++;
    const response = await this.api.request('GET', path, this.signal);
    this.check();
    requireStatus(response);
    this.readBytes += response.bytes ?? bytes(response.body);
    if (this.readBytes > CODE_LIMITS.readBytes) throw new ServiceError('limit');
    return response.body;
  }
  deliver<T>(value: T): T {
    this.check();
    const size = bytes(value);
    if (this.contextBytes + size > CODE_LIMITS.contextBytes) throw new ServiceError('limit');
    this.contextBytes += size;
    return value;
  }
  private async current() {
    const raw = await this.get(`/repos/${this.ref.repo}/${this.ref.kind === 'pr' ? 'pulls' : 'issues'}/${this.ref.number}`);
    const value = this.ref.kind === 'pr' ? parse(pullSchema, raw) : parse(sourceSchema, raw);
    const url = `https://github.com/${this.ref.repo}/${this.ref.kind === 'pr' ? 'pull' : 'issues'}/${this.ref.number}`;
    if (value.number !== this.ref.number || !same(value.html_url, url)) throw new ServiceError('invalid_output');
    if (this.ref.kind === 'issue' && value.pull_request) throw new ServiceError('unsupported');
    return value;
  }
  private async revision(repo: string, ref: string): Promise<CodeRevision> {
    const commit = parse(commitSchema, await this.get(`/repos/${repo}/commits/${encodeURIComponent(ref)}`));
    if (shaSchema.safeParse(ref).success && commit.sha !== ref) throw new ServiceError('invalid_output');
    return { repo, sha: commit.sha, tree: commit.commit.tree.sha };
  }
  async initialize() {
    parse(referenceSchema, this.ref);
    const current = await this.current();
    this.sourceFingerprint = codeHash(current);
    let head: CodeRevision;
    let base: CodeRevision | null = null;
    let baseTip: string | null = null;
    let draft: boolean | null = null;
    let merged: boolean | null = null;
    if (this.ref.kind === 'pr') {
      const pr = parse(pullSchema, current);
      draft = pr.draft; merged = pr.merged;
      if (!pr.head.repo || !pr.base.repo) throw new ServiceError('unsupported');
      if (!same(pr.base.repo.full_name, this.ref.repo)) throw new ServiceError('invalid_output');
      head = await this.revision(pr.head.repo.full_name, pr.head.sha);
      baseTip = pr.base.sha;
      const comparison = parse(z.object({
        base_commit: z.object({ sha: shaSchema }), merge_base_commit: z.object({ sha: shaSchema }),
        files: z.array(fileSchema).max(300),
      }), await this.get(`/repos/${this.ref.repo}/compare/${baseTip}...${head.sha}?per_page=1`));
      if (comparison.base_commit.sha !== baseTip) throw new ServiceError('invalid_output');
      base = await this.revision(this.ref.repo, comparison.merge_base_commit.sha);
      const files = comparison.files.slice(0, CODE_LIMITS.changedFiles);
      this.expectedFiles = pr.changed_files;
      this.comparedFiles = comparison.files.length;
      if (comparison.files.length !== pr.changed_files) {
        this.warnings.add(`Changed-file list is incomplete: GitHub compare returned ${comparison.files.length} of ${pr.changed_files} reported files (upstream cap 300).`);
      }
      if (comparison.files.length > files.length) {
        this.warnings.add(`Changed-file list is incomplete: local cap retains ${files.length} of ${comparison.files.length} returned files.`);
      }
      const seen = new Set<string>();
      let patchBytes = 0;
      for (const file of files) {
        if (seen.has(file.filename)) throw new ServiceError('invalid_output');
        seen.add(file.filename);
        const safePath = codePathSchema.safeParse(file.filename).success
          && (!file.previous_filename || codePathSchema.safeParse(file.previous_filename).success);
        patchBytes += Buffer.byteLength(file.patch ?? '');
        const patch = safePath && patchBytes <= CODE_LIMITS.patchBytes ? file.patch : undefined;
        const change = { ...file, patch, patchComplete: false };
        change.patchComplete = this.indexPatch(change);
        this.changes.push(change);
        if (!change.patchComplete) this.warnings.add(`Patch unavailable, truncated, binary or unsupported: ${file.filename}`);
      }
      await this.assertUnchanged();
    } else {
      const repo = parse(repositorySchema, await this.get(`/repos/${this.ref.repo}`));
      if (!same(repo.full_name, this.ref.repo)) throw new ServiceError('invalid_output');
      this.defaultBranch = repo.default_branch;
      head = await this.revision(this.ref.repo, repo.default_branch);
    }
    const body = current.body ?? '';
    const clipped = new TextDecoder('utf-8', { ignoreBOM: true })
      .decode(Buffer.from(body).subarray(0, CODE_LIMITS.sourceBytes), { stream: true });
    if (clipped !== body) this.warnings.add('Source body is truncated at the UTF-8 byte limit.');
    this.source = {
      reference: this.ref, url: current.html_url, title: current.title, body: clipped,
      updatedAt: current.updated_at, state: current.state, fingerprint: this.sourceFingerprint,
      observedAt: new Date().toISOString(), head, base, baseTip,
      defaultBranch: this.defaultBranch || null,
      draft, merged,
    };
    await this.loadTree('head', head);
    if (base) await this.loadTree('base', base);
    return this;
  }
  private async loadTree(side: CodeSide, revision: CodeRevision) {
    const tree = parse(z.object({ sha: shaSchema, truncated: z.boolean(), tree: z.array(treeEntrySchema) }),
      await this.get(`/repos/${revision.repo}/git/trees/${revision.tree}?recursive=1`));
    if (tree.sha !== revision.tree) throw new ServiceError('invalid_output');
    if (tree.truncated || tree.tree.length > CODE_LIMITS.treeEntries) this.warnings.add(`${side} repository tree is truncated.`);
    const paths = new Set<string>();
    const entries = tree.tree.slice(0, CODE_LIMITS.treeEntries).filter(entry => {
      if (!codePathSchema.safeParse(entry.path).success) {
        this.warnings.add(`${side} tree contains unsupported paths.`);
        return false;
      }
      if (paths.has(entry.path)) throw new ServiceError('invalid_output');
      paths.add(entry.path);
      return true;
    });
    this.trees.set(side, entries);
  }
  private indexPatch(file: CodeChange): boolean {
    if (!file.patch || !codePathSchema.safeParse(file.filename).success
      || (file.status === 'renamed' && !file.previous_filename)
      || (file.previous_filename && !codePathSchema.safeParse(file.previous_filename).success)) return false;
    const head = new Map<number, string>(), base = new Map<number, string>();
    let oldLine = 0, newLine = 0, oldRemaining = 0, newRemaining = 0, hunks = 0;
    for (const line of file.patch.split('\n')) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
      if (hunk) {
        if (oldRemaining || newRemaining) return false;
        oldLine = Number(hunk[1]); newLine = Number(hunk[3]);
        oldRemaining = Number(hunk[2] ?? 1); newRemaining = Number(hunk[4] ?? 1);
        hunks++;
      } else if (line.startsWith('\\ No newline at end of file')) continue;
      else if (hunks && line.startsWith('+')) { head.set(newLine++, line.slice(1)); newRemaining--; }
      else if (hunks && line.startsWith('-')) { base.set(oldLine++, line.slice(1)); oldRemaining--; }
      else if (hunks && line.startsWith(' ')) { newLine++; oldLine++; newRemaining--; oldRemaining--; }
      else return false;
      if (oldRemaining < 0 || newRemaining < 0 || !Number.isSafeInteger(oldLine) || !Number.isSafeInteger(newLine)) return false;
    }
    if (!hunks || oldRemaining || newRemaining || head.size !== file.additions || base.size !== file.deletions) return false;
    this.changedLines.set(`head:${file.filename}`, head);
    this.changedLines.set(`base:${file.previous_filename ?? file.filename}`, base);
    return true;
  }
  async assertUnchanged() {
    if (codeHash(await this.current()) !== this.sourceFingerprint) throw new ServiceError('source_changed', true, 'read');
    if (this.ref.kind === 'issue' && this.source) {
      const repo = parse(repositorySchema, await this.get(`/repos/${this.ref.repo}`));
      if (!same(repo.full_name, this.ref.repo)) throw new ServiceError('invalid_output');
      if (repo.default_branch !== this.defaultBranch
        || (await this.revision(this.ref.repo, this.defaultBranch)).sha !== this.source.head.sha) {
        throw new ServiceError('source_changed', true, 'read');
      }
    }
  }
  async tool<T>(operation: () => Promise<T> | T, signal?: AbortSignal) {
    this.check();
    if (++this.toolCalls > CODE_LIMITS.toolCalls) {
      this.fatal = new ServiceError('limit');
      this.stop.abort(this.fatal);
      throw this.fatal;
    }
    const abort = () => this.stop.abort(new ServiceError('cancelled', false, 'read'));
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      this.check();
      return this.deliver(await operation());
    }
    catch (error) {
      this.check();
      if (!(error instanceof ServiceError)) throw error;
      if (['cancelled', 'deadline', 'authentication', 'rate_limit', 'limit'].includes(error.dto.code)) {
        this.fatal = error;
        this.stop.abort(error);
        throw error;
      }
      this.warnings.add(`A scoped code tool failed: ${error.dto.code}.`);
      return this.deliver({ error: error.dto });
    } finally { signal?.removeEventListener('abort', abort); }
  }
  list(raw: unknown) {
    const input = listCodeSchema.safeParse(raw);
    if (!input.success) throw new ServiceError('invalid_input');
    const entries = this.trees.get(input.data.side);
    if (!entries) throw new ServiceError('invalid_input');
    const matching = entries.filter(entry => entry.path.startsWith(input.data.prefix));
    return {
      side: input.data.side, revision: this.pin(input.data.side),
      entries: matching.slice(input.data.offset, input.data.offset + 100),
      nextOffset: matching.length > input.data.offset + 100 ? input.data.offset + 100 : null,
    };
  }
  private pin(side: CodeSide) {
    const pin = side === 'head' ? this.source.head : this.source.base;
    if (!pin) throw new ServiceError('invalid_input');
    return pin;
  }
  async read(raw: unknown): Promise<CodeRead> {
    const input = readCodeSchema.safeParse(raw);
    if (!input.success) throw new ServiceError('invalid_input');
    const { side, path, startLine, endLine } = input.data;
    const unread = (reason: string, code: 'access' | 'unsupported'): never => {
      this.warnings.add(`Cannot read ${side}:${path}: ${reason}.`);
      throw new ServiceError(code);
    };
    const pin = this.pin(side);
    const entry = this.trees.get(side)?.find(entry => entry.path === path);
    if (!entry) return unread('path is absent from the bounded tree', 'access');
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) return unread('not a regular file (directory, symlink or submodule)', 'unsupported');
    if (entry.size === undefined || entry.size > CODE_LIMITS.fileBytes) return unread('file exceeds the byte limit or has unknown size', 'unsupported');
    let body: unknown;
    try { body = await this.get(`/repos/${pin.repo}/git/blobs/${entry.sha}`); }
    catch (error) {
      if (error instanceof ServiceError && error.dto.code === 'access') return unread('GitHub denied access or the blob is unavailable', 'access');
      throw error;
    }
    const blob = parse(z.object({
      sha: shaSchema, encoding: z.literal('base64'), size: z.number().int().nonnegative(), content: z.string(),
    }), body);
    if (blob.sha !== entry.sha || blob.size !== entry.size) throw new ServiceError('invalid_output');
    const encoded = blob.content.replace(/\n/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new ServiceError('invalid_output');
    const buffer = Buffer.from(encoded, 'base64');
    if (buffer.length !== blob.size || buffer.length > CODE_LIMITS.fileBytes) throw new ServiceError('invalid_output');
    const digest = createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');
    if (digest !== entry.sha) throw new ServiceError('invalid_output');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch { return unread('file is not valid UTF-8', 'unsupported'); }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return unread('binary file', 'unsupported');
    const lines = text.split('\n');
    if (text.endsWith('\n')) lines.pop();
    if (startLine > lines.length) throw new ServiceError('invalid_input');
    const result = {
      id: `read-${this.reads.length + 1}`, side, repo: pin.repo, revision: pin.sha, blob: entry.sha,
      path, startLine, endLine: Math.min(endLine, lines.length), totalLines: lines.length,
      text: lines.slice(startLine - 1, endLine).join('\n'),
    };
    // Only returned evidence can ground an answer, not a read that exceeded the delivery budget.
    if (this.contextBytes + bytes(result) > CODE_LIMITS.contextBytes) throw new ServiceError('limit');
    this.reads.push(result);
    return result;
  }
  isChanged(side: CodeSide, path: string, line: number, text?: string) {
    const lines = this.changedLines.get(`${side}:${path}`);
    return lines?.has(line) === true && (text === undefined || lines.get(line) === text);
  }
  coverage() {
    this.check();
    let reviewed = 0, changed = 0;
    for (const [key, lines] of this.changedLines) {
      changed += lines.size;
      for (const [line, text] of lines) {
        if (this.reads.some(read => `${read.side}:${read.path}` === key && read.startLine <= line && read.endLine >= line
          && read.text.split('\n')[line - read.startLine] === text)) reviewed++;
      }
    }
    const changesComplete = this.ref.kind === 'pr' && this.changes.every(file => file.patchComplete)
      && ![...this.warnings].some(warning => warning.startsWith('Changed-file list')) && reviewed === changed;
    return {
      status: 'partial' as const,
      knownChangedLines: changed, reviewedChangedLines: reviewed,
      files: {
        expected: this.expectedFiles, compared: this.comparedFiles, retained: this.changes.length,
        omitted: Math.max(0, (this.expectedFiles ?? 0) - this.changes.length),
        incompletePatches: this.changes.filter(file => !file.patchComplete).length,
      },
      changes: this.ref.kind === 'issue' ? 'not-applicable' as const : changesComplete ? 'complete' as const : 'partial' as const,
      warnings: [...this.warnings, ...(!this.reads.length ? ['No source-code lines were read.'] : [])],
      requests: this.requests, readBytes: this.readBytes, contextBytes: this.contextBytes, toolCalls: this.toolCalls,
    };
  }
}
