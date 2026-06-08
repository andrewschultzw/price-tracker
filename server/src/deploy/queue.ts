import { logger } from '../logger.js';

export interface DeployQueue {
  enqueue: (sha: string) => void;
  isRunning: () => boolean;
}

/**
 * Single-slot coalescing queue. While a deploy runs, the newest incoming SHA
 * is remembered (older pending SHAs are discarded); when the current deploy
 * finishes, it runs once more for that newest SHA. Converges to the latest
 * green commit without stacking N builds.
 */
export function createDeployQueue(deployFn: (sha: string) => Promise<void>): DeployQueue {
  let running = false;
  let pending: string | null = null;

  async function drain(sha: string): Promise<void> {
    running = true; // Must stay synchronous (before any await) so two drains can never race.
    let next: string | null = sha;
    try {
      while (next) {
        const current = next;
        pending = null;
        try {
          await deployFn(current);
        } catch (err) {
          logger.error({ err, sha: current }, 'deploy failed; live service remains on previous build');
        }
        next = pending;
        // No await between the while-exit and finally's running=false (single-threaded), so an enqueue can't slip in and be lost.
      }
    } finally {
      running = false;
    }
  }

  return {
    enqueue(sha: string) {
      if (running) {
        pending = sha;
        logger.info({ sha }, 'deploy in progress; coalescing into rerun');
        return;
      }
      void drain(sha);
    },
    isRunning: () => running,
  };
}
