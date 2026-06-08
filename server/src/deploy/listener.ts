import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../logger.js';
import { loadDeployConfig } from './config.js';
import { createDeployQueue } from './queue.js';
import { createListenerApp } from './app.js';

const config = loadDeployConfig(process.env);

/** Run scripts/deploy-local.sh <sha>, streaming output to the logger. */
function runDeployScript(sha: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = path.join(config.repoRoot, 'scripts', 'deploy-local.sh');
    logger.info({ sha, script }, 'starting deploy');
    const child = spawn('bash', [script, sha], {
      cwd: config.repoRoot,
      env: { ...process.env, DEPLOY_PUBLIC_URL: config.publicUrl },
    });
    child.stdout.on('data', (d) => logger.info({ sha }, `deploy: ${d.toString().trimEnd()}`));
    child.stderr.on('data', (d) => logger.warn({ sha }, `deploy: ${d.toString().trimEnd()}`));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        logger.info({ sha }, 'deploy succeeded');
        resolve();
      } else {
        reject(new Error(`deploy-local.sh exited ${code}`));
      }
    });
  });
}

const queue = createDeployQueue(runDeployScript);
const app = createListenerApp({ secret: config.secret, queue });

// Bind localhost only — the sole ingress is the CF tunnel -> NPM proxy host.
app.listen(config.port, '127.0.0.1', () => {
  logger.info({ port: config.port, repoRoot: config.repoRoot }, 'deploy-listener up on 127.0.0.1');
});
