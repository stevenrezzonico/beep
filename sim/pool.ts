import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';

/** Tiny worker pool: runs exported functions of sim/jobs.ts in parallel worker threads. */
export class Pool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: { fn: string; args: unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  private pending = new Map<Worker, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

  constructor(size = Math.max(1, cpus().length)) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { execArgv: ['--import', 'tsx'] });
      w.on('message', (m: { ok: boolean; value?: unknown; error?: string }) => {
        const p = this.pending.get(w)!;
        this.pending.delete(w);
        if (m.ok) p.resolve(m.value);
        else p.reject(new Error(m.error));
        this.idle.push(w);
        this.pump();
      });
      w.on('error', (e) => {
        const p = this.pending.get(w);
        if (p) p.reject(e);
      });
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  run<T>(fn: string, args: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ fn, args, resolve: resolve as (v: unknown) => void, reject });
      this.pump();
    });
  }

  private pump(): void {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop()!;
      const j = this.queue.shift()!;
      this.pending.set(w, j);
      w.postMessage({ fn: j.fn, args: j.args });
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}
