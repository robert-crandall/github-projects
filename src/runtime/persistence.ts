export type PersistenceStatus = { saving: boolean; pending: boolean; error: string };
type Waiter = { resolve: () => void; reject: (error: Error) => void };

/** One writer owns the CAS revision chain, including edits arriving during a write. */
export class PersistenceQueue<T> {
  private generation = 0;
  private savedGeneration = 0;
  private running = false;
  private blocked: Error | null = null;
  private pending: T | undefined;
  private waiters: Waiter[] = [];

  constructor(
    private revision: string,
    private readonly write: (revision: string, value: T) => Promise<{ revision: string }>,
    private readonly changed: (status: PersistenceStatus) => void,
  ) {}

  get status(): PersistenceStatus {
    return { saving: this.running, pending: this.generation !== this.savedGeneration, error: this.blocked?.message ?? '' };
  }

  enqueue(value: T): void {
    this.pending = value;
    this.generation += 1;
    void this.pump();
  }

  flush(): Promise<void> {
    if (this.blocked) return Promise.reject(this.blocked);
    if (this.savedGeneration === this.generation) return Promise.resolve();
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  retry(): Promise<void> {
    this.blocked = null;
    void this.pump();
    return this.flush();
  }

  recover(revision: string): Promise<void> {
    if (this.running) return Promise.reject(new Error('Wait for the current save before recovery.'));
    this.revision = revision;
    return this.retry();
  }

  private async pump(): Promise<void> {
    if (this.running || this.blocked || this.pending === undefined) {
      this.changed(this.status);
      return;
    }
    this.running = true;
    this.changed(this.status);
    try {
      while (this.savedGeneration !== this.generation) {
        const generation = this.generation;
        const result = await this.write(this.revision, this.pending);
        if (!result.revision || result.revision === this.revision) throw new Error('Storage did not return a new revision. Pending work is retained.');
        this.revision = result.revision;
        this.savedGeneration = generation;
      }
      for (const waiter of this.waiters.splice(0)) waiter.resolve();
    } catch (error) {
      this.blocked = error instanceof Error ? error : new Error(String(error));
      for (const waiter of this.waiters.splice(0)) waiter.reject(this.blocked);
    } finally {
      this.running = false;
      this.changed(this.status);
    }
  }
}
