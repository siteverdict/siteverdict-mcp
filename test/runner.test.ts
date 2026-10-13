import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApifyHttpRunner, type FetchLike } from '../src/apify/runner.js';
import { ApifyError, AuthError, CancelledError } from '../src/lib/errors.js';

const BASE = 'https://api.apify.test';
const TOKEN = 'apify_api_SECRET123';

interface Call {
  method: string;
  url: string;
  auth?: string;
  body?: unknown;
}

function fakeApify(script: (call: Call, n: number) => Response | Promise<Response>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers);
    const call: Call = { method: init?.method ?? 'GET', url, auth: headers.get('authorization') ?? undefined, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return script(call, calls.length);
  };
  return { fetch, calls };
}

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
const run = (status: string, extra: Record<string, unknown> = {}) => ({ id: 'RUN1', status, defaultDatasetId: 'DS1', defaultKeyValueStoreId: 'KV1', usageTotalUsd: 0.042, ...extra });

const baseReq = { actorId: 'me/siteverdict-ai-search-readiness', input: { startUrls: [{ url: 'https://a.com/' }] }, token: TOKEN, waitSecs: 30, runTimeoutSecs: 600, maxTotalChargeUsd: 1.5 };

test('start → poll → items, with bearer auth, spend cap and progress', async () => {
  const { fetch, calls } = fakeApify((c) => {
    if (c.method === 'POST') return ok(run('RUNNING'));
    if (c.url.includes('/actor-runs/RUN1')) return ok(run('SUCCEEDED'));
    if (c.url.includes('/datasets/DS1/items')) return new Response(JSON.stringify([{ type: 'summary', score: 80 }]), { status: 200 });
    return new Response('nope', { status: 500 });
  });
  const progress: number[] = [];
  const r = await new ApifyHttpRunner(BASE, fetch, 1).run({ ...baseReq, signal: new AbortController().signal, onProgress: (p) => progress.push(p) });
  assert.equal(r.status, 'SUCCEEDED');
  assert.deepEqual(r.items, [{ type: 'summary', score: 80 }]);
  assert.equal(r.usageTotalUsd, 0.042);
  assert.equal(r.consoleUrl, 'https://console.apify.com/view/runs/RUN1');
  assert.match(calls[0]!.url, /\/v2\/acts\/me~siteverdict-ai-search-readiness\/runs\?timeout=600&maxTotalChargeUsd=1.5/);
  assert.equal(calls[0]!.auth, `Bearer ${TOKEN}`);
  assert.ok(!calls.some((c) => c.url.includes(TOKEN)), 'token must never be in a URL');
  assert.deepEqual(calls[0]!.body, baseReq.input);
  assert.equal(progress.at(-1), 100);
});

test('wait deadline returns RUNNING without aborting the paid run', async () => {
  const { fetch, calls } = fakeApify(async (c) => {
    if (c.method === 'POST') return ok(run('RUNNING'));
    await new Promise((r) => setTimeout(r, 1100));
    return ok(run('RUNNING'));
  });
  const r = await new ApifyHttpRunner(BASE, fetch, 1).run({ ...baseReq, waitSecs: 1, signal: new AbortController().signal });
  assert.equal(r.status, 'RUNNING');
  assert.equal(r.runId, 'RUN1');
  assert.deepEqual(r.items, []);
  assert.ok(!calls.some((c) => c.url.endsWith('/abort')));
});

test('client cancellation aborts the Apify run', async () => {
  const ac = new AbortController();
  const { fetch, calls } = fakeApify((c) => {
    if (c.method === 'POST' && c.url.endsWith('/abort')) return ok(run('ABORTING'));
    if (c.method === 'POST') return ok(run('RUNNING'));
    ac.abort();
    throw new DOMException('aborted', 'AbortError');
  });
  await assert.rejects(new ApifyHttpRunner(BASE, fetch, 1).run({ ...baseReq, signal: ac.signal }), CancelledError);
  assert.ok(calls.some((c) => c.method === 'POST' && c.url.endsWith('/v2/actor-runs/RUN1/abort')));
});

test('maps HTTP errors to clear messages and redacts tokens', async () => {
  const mk = (status: number, message = 'x') => fakeApify(() => new Response(JSON.stringify({ error: { message: `${message} apify_api_LEAKED` } }), { status })).fetch;
  const signal = new AbortController().signal;
  await assert.rejects(new ApifyHttpRunner(BASE, mk(401)).run({ ...baseReq, signal }), AuthError);
  await assert.rejects(new ApifyHttpRunner(BASE, mk(404, 'Actor not found')).run({ ...baseReq, signal }), (e: unknown) => {
    assert.ok(e instanceof ApifyError);
    assert.match(e.message, /not found/);
    assert.doesNotMatch(e.message, /LEAKED/);
    return true;
  });
  await assert.rejects(new ApifyHttpRunner(BASE, mk(402)).run({ ...baseReq, signal }), /credit/);
});

test('GETs retry on 5xx then succeed', async () => {
  let fails = 1;
  const { fetch } = fakeApify((c) => {
    if (c.method === 'POST') return ok(run('RUNNING'));
    if (c.url.includes('/actor-runs/') && fails-- > 0) return new Response('{}', { status: 503 });
    if (c.url.includes('/actor-runs/')) return ok(run('SUCCEEDED'));
    return new Response('[]', { status: 200 });
  });
  const r = await new ApifyHttpRunner(BASE, fetch, 1).run({ ...baseReq, signal: new AbortController().signal });
  assert.equal(r.status, 'SUCCEEDED');
});
