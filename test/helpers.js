import { createApp } from '../src/app.js';

export function makeApp(opts = {}) {
  return createApp({ dbFile: ':memory:', latencyChunkMs: 5, ...opts });
}

export async function wait(api, id, tries = 300) {
  for (let i = 0; i < tries; i += 1) {
    const job = api.collector.getJob(id);
    if (job && job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`job ${id} did not settle`);
}

export async function collect(api, purpose, extra = {}) {
  const started = await api.runJob({ purpose, ...extra });
  return { started, job: await wait(api, started.jobId) };
}

export function buildAndQuery(env, purpose, opts = {}) {
  return env.indexer.build({ purpose, ...opts }).then(() => env.indexer.query({ purpose }));
}
