import { parentPort } from 'node:worker_threads';
import * as jobs from './jobs.ts';

parentPort!.on('message', async (m: { fn: string; args: unknown }) => {
  try {
    const f = (jobs as unknown as Record<string, (a: unknown) => unknown>)[m.fn];
    if (!f) throw new Error(`no job ${m.fn}`);
    parentPort!.postMessage({ ok: true, value: await f(m.args) });
  } catch (e) {
    parentPort!.postMessage({ ok: false, error: String((e as Error)?.stack ?? e) });
  }
});
