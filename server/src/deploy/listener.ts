import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../logger.js';
import { loadDeployConfig } from './config.js';
import { createDeployQueue } from './queue.js';
import { createListenerApp } from './app.js';
import { notifyDeployFailure } from './notify.js';

const config = loadDeployConfig(process.env);

// 15 min is ample for npm ci + build of server + client. A hang past this would
// wedge the deploy queue forever (running stays true), so we kill the child and
// reject — the queue then logs and stays usable for the next push.
const DEPLOY_TIMEOUT_MS = 15 * 60 * 1000;

/** Run scripts/deploy-local.sh <sha>, streaming output to the logger. */
function runDeployScript(sha: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = path.join(config.repoRoot, 'scripts', 'deploy-local.sh');
    logger.info({ sha, script }, 'starting deploy');
    const child = spawn('bash', [script, sha], {
      cwd: config.repoRoot,
      env: { ...process.env, DEPLOY_PUBLIC_URL: config.publicUrl },
    });
    const watchdog = setTimeout(() => {
      logger.error({ sha, timeoutMs: DEPLOY_TIMEOUT_MS }, 'deploy timed out; killing child process');
      child.kill('SIGKILL');
    }, DEPLOY_TIMEOUT_MS);
    child.stdout.on('data', (d) => logger.info({ sha }, `deploy: ${d.toString().trimEnd()}`));
    child.stderr.on('data', (d) => logger.warn({ sha }, `deploy: ${d.toString().trimEnd()}`));
    child.on('error', (err) => { clearTimeout(watchdog); reject(err); });
    child.on('close', (code, signal) => {
      clearTimeout(watchdog);
      if (code === 0) {
        logger.info({ sha }, 'deploy succeeded');
        resolve();
      } else {
        reject(new Error(`deploy-local.sh failed (code=${code ?? 'null'} signal=${signal ?? 'none'})`));
      }
    });
  });
}

const queue = createDeployQueue(async (sha) => {
  try {
    await runDeployScript(sha);
  } catch (err) {
    await notifyDeployFailure(
      config.alertNtfyUrl,
      sha,
      err instanceof Error ? err.message : String(err),
      config.alertNtfyToken,
    );
    throw err; // rethrow so the queue logs it too
  }
});
const app = createListenerApp({ secret: config.secret, queue });

// Bind host defaults to localhost; set DEPLOY_BIND_HOST=0.0.0.0 where a reverse
// proxy on another host must reach the listener. The HMAC gate is the security
// boundary regardless of interface.
app.listen(config.port, config.bindHost, () => {
  logger.info(
    { port: config.port, bindHost: config.bindHost, repoRoot: config.repoRoot },
    'deploy-listener up',
  );
});
