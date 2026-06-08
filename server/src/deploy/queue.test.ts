import { describe, it, expect } from 'vitest';
import { createDeployQueue } from './queue.js';

/** A deferred promise we can resolve from the test to control timing. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('createDeployQueue', () => {
  it('runs a single deploy', async () => {
    const calls: string[] = [];
    const q = createDeployQueue(async (sha) => { calls.push(sha); });
    q.enqueue('a');
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual(['a']);
  });

  it('coalesces events that arrive while a deploy is running into one rerun', async () => {
    const calls: string[] = [];
    const gate = deferred();
    const q = createDeployQueue(async (sha) => {
      calls.push(sha);
      if (calls.length === 1) await gate.promise; // hold the first deploy open
    });

    q.enqueue('first');                 // starts running, blocks on gate
    await new Promise((r) => setImmediate(r));
    q.enqueue('second');                // arrives while running -> rerun flag
    q.enqueue('third');                 // overwrites rerun flag -> latest wins
    gate.resolve();                     // let first finish
    await new Promise((r) => setTimeout(r, 10));

    expect(calls).toEqual(['first', 'third']); // 'second' coalesced away
  });

  it('reports running state', async () => {
    const gate = deferred();
    const q = createDeployQueue(async () => { await gate.promise; });
    expect(q.isRunning()).toBe(false);
    q.enqueue('a');
    await new Promise((r) => setImmediate(r));
    expect(q.isRunning()).toBe(true);
    gate.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(q.isRunning()).toBe(false);
  });

  it('keeps running after a deploy throws', async () => {
    const calls: string[] = [];
    const q = createDeployQueue(async (sha) => {
      calls.push(sha);
      if (sha === 'boom') throw new Error('deploy failed');
    });
    q.enqueue('boom');
    await new Promise((r) => setTimeout(r, 10));
    q.enqueue('ok');
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual(['boom', 'ok']);
    expect(q.isRunning()).toBe(false);
  });
});
