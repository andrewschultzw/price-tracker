import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';

/**
 * Verify GitHub's X-Hub-Signature-256 over the RAW request body.
 * Must be the exact bytes GitHub sent — re-serialized JSON will not match.
 */
export function verifySignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader, 'ascii');
  const b = Buffer.from(expected, 'ascii');
  // timingSafeEqual throws on length mismatch — guard first.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const workflowRunSchema = z.object({
  action: z.string(),
  workflow_run: z.object({
    name: z.string(),
    conclusion: z.string().nullable(),
    head_branch: z.string(),
    head_sha: z.string(),
  }),
});

export function shouldDeploy(payload: unknown): { deploy: boolean; reason: string; sha: string | null } {
  const parsed = workflowRunSchema.safeParse(payload);
  if (!parsed.success) return { deploy: false, reason: 'not a workflow_run event', sha: null };

  const run = parsed.data.workflow_run;
  if (parsed.data.action !== 'completed') return { deploy: false, reason: `action is ${parsed.data.action}`, sha: null };
  if (run.name !== 'CI') return { deploy: false, reason: `workflow is ${run.name}`, sha: null };
  if (run.head_branch !== 'main') return { deploy: false, reason: `branch is ${run.head_branch}`, sha: null };
  if (run.conclusion !== 'success') return { deploy: false, reason: `conclusion is ${run.conclusion}`, sha: null };

  return { deploy: true, reason: 'CI success on main', sha: run.head_sha };
}
