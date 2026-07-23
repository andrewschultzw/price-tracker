import nodemailer, { Transporter } from 'nodemailer';
import { config, isEmailConfigured } from '../config.js';
import { logger } from '../logger.js';
import type { Tracker, TrackerUrlCondition } from '../db/queries.js';
import type { Confidence } from '../ai/confidence.js';
import { conditionLabel, formatPriceWithCondition } from './condition-label.js';

function emailSubjectPrefix(level: Confidence['level']): string {
  if (level === 'HIGH') return '[Strong Buy] ';
  if (level === 'MEDIUM') return '[Good Deal] ';
  return '';
}

/**
 * Email notification channel. Sends multipart HTML+plaintext alerts over
 * the configured Gmail SMTP transport. The SMTP account is app-wide
 * (configured in .env) and each user supplies only their own recipient
 * address via the `email_recipient` setting.
 *
 * Shape mirrors the other three channels exactly — a price alert and an
 * error alert function, both returning Promise<boolean> where false means
 * "did not send" (either misconfigured or SMTP error, logged inside).
 * A testEmail() function matches the ok/error return shape used by the
 * other channels' test helpers.
 */

let transport: Transporter | null = null;

function getTransport(): Transporter {
  if (transport) return transport;
  if (!isEmailConfigured()) {
    throw new Error('Email channel is not configured (missing SMTP_* env vars)');
  }
  transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    // Gmail's 465 is implicit TLS; 587 is STARTTLS. Pick based on port.
    secure: config.smtpPort === 465,
    auth: { user: config.smtpUser, pass: config.smtpPass },
  });
  return transport;
}

/**
 * Test-only helper to drop the cached transport so a re-mocked
 * createTransport takes effect on the next call. Do not call from
 * application code.
 */
export function resetEmailTransportForTesting(): void {
  transport = null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function formatMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

function priceAlertText(
  tracker: Tracker,
  price: number,
  condition?: TrackerUrlCondition | null,
  low?: { tier: string; context: string } | null,
): string {
  const lines = [
    `${tracker.name} dropped to ${formatPriceWithCondition(price, condition)}`,
    '',
  ];
  if (tracker.threshold_price) {
    lines.push(
      `Target: ${formatMoney(tracker.threshold_price)}`,
      `Savings: ${formatMoney(tracker.threshold_price - price)}`,
    );
  }
  if (low) lines.push(`Record: ${low.context}`);
  lines.push(`Seller: ${hostOf(tracker.url)}`);
  const condLabel = conditionLabel(condition);
  if (condLabel) lines.push(`Condition: ${condLabel}`);
  lines.push('', `Buy now: ${tracker.url}`);
  return lines.join('\n');
}

function priceAlertHtml(
  tracker: Tracker,
  price: number,
  condition?: TrackerUrlCondition | null,
  low?: { tier: string; context: string } | null,
): string {
  const host = hostOf(tracker.url);
  const condLabel = conditionLabel(condition);
  // Inline tag in the headline price line so the condition is visible at a
  // glance — same shape as the other channels' "$239 (Warehouse)" rendering.
  const priceHeadline = condLabel
    ? `${formatMoney(price)} <span style="font-size: 16px; color: #6b7280; font-weight: 500;">(${escapeHtml(condLabel)})</span>`
    : formatMoney(price);
  const targetRows = tracker.threshold_price
    ? `<tr><td style="color: #6b7280;">Target</td><td style="font-weight: 600;">${formatMoney(tracker.threshold_price)}</td></tr>
    <tr><td style="color: #6b7280;">Savings</td><td style="font-weight: 600; color: #16a34a;">${formatMoney(tracker.threshold_price - price)}</td></tr>`
    : '';
  const recordRow = low
    ? `<tr><td style="color: #6b7280;">Record</td><td style="font-weight: 600;">${escapeHtml(low.context)}</td></tr>`
    : '';
  const conditionRow = condLabel
    ? `<tr><td style="color: #6b7280;">Condition</td><td style="font-weight: 600;">${escapeHtml(condLabel)}</td></tr>`
    : '';
  return `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1a1a1a; max-width: 520px; margin: 0 auto; padding: 24px;">
  <h2 style="margin: 0 0 8px 0; font-size: 18px;">${escapeHtml(tracker.name)}</h2>
  <div style="font-size: 28px; font-weight: 700; color: #16a34a; margin: 8px 0 16px 0;">${priceHeadline}</div>
  <table style="border-collapse: collapse; margin-bottom: 20px;" cellpadding="4">
    ${targetRows}
    ${recordRow}
    <tr><td style="color: #6b7280;">Seller</td><td>${escapeHtml(host)}</td></tr>
    ${conditionRow}
  </table>
  <a href="${escapeAttr(tracker.url)}" style="display: inline-block; background: #2563eb; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 8px; font-weight: 500;">Buy now</a>
</body></html>`;
}

function errorAlertText(tracker: Tracker, error: string): string {
  return [
    `Tracker error: ${tracker.name}`,
    '',
    `${error}`,
    `${tracker.consecutive_failures} consecutive failures.`,
    '',
    `Tracker URL: ${tracker.url}`,
  ].join('\n');
}

function errorAlertHtml(tracker: Tracker, error: string): string {
  return `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1a1a1a; max-width: 520px; margin: 0 auto; padding: 24px;">
  <h2 style="margin: 0 0 8px 0; font-size: 18px;">Tracker error: ${escapeHtml(tracker.name)}</h2>
  <div style="background: #fef2f2; color: #991b1b; padding: 12px 16px; border-radius: 8px; margin: 12px 0;">${escapeHtml(error)}</div>
  <p style="color: #6b7280;">${tracker.consecutive_failures} consecutive failures.</p>
  <a href="${escapeAttr(tracker.url)}" style="color: #2563eb;">Open tracker URL</a>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}

export async function sendEmailPriceAlert(
  tracker: Tracker,
  currentPrice: number,
  recipient: string,
  aiCommentary?: string | null,
  confidence?: Confidence | null,
  condition?: TrackerUrlCondition | null,
  low?: { tier: string; context: string } | null,
): Promise<boolean> {
  // Record-low alerts (phase 1) fire without a threshold; all others need one.
  if (!tracker.threshold_price && !low) return false;
  const baseText = priceAlertText(tracker, currentPrice, condition, low);
  const baseHtml = priceAlertHtml(tracker, currentPrice, condition, low);

  // Plaintext: aiCommentary then "About this deal" line.
  const textParts: string[] = [baseText];
  if (aiCommentary) textParts.push(aiCommentary);
  if (confidence && confidence.reasons.length > 0) {
    textParts.push(`About this deal: ${confidence.reasons.join(' · ')}`);
  }
  const text = textParts.join('\n\n');

  // HTML: inject aiCommentary + reasons block before </body>.
  const htmlInjections: string[] = [];
  if (aiCommentary) {
    htmlInjections.push(`<p style="margin-top: 16px; color: #374151;">${escapeHtml(aiCommentary)}</p>`);
  }
  if (confidence && confidence.reasons.length > 0) {
    const reasonsHtml = confidence.reasons.map(r => escapeHtml(r)).join(' &middot; ');
    htmlInjections.push(
      `<p style="margin-top: 16px; color: #374151;"><strong>About this deal:</strong> ${reasonsHtml}</p>`,
    );
  }
  const html = htmlInjections.length > 0
    ? baseHtml.replace('</body>', `${htmlInjections.join('\n')}\n</body>`)
    : baseHtml;

  const subjectPrefix = confidence ? emailSubjectPrefix(confidence.level) : '';
  // Tag the subject too so the condition is readable in the inbox preview
  // before opening — formatPriceWithCondition() returns plain "$X" for 'new'
  // (no parens) so today's subject lines stay identical when winning URL is new.
  const priceTagged = formatPriceWithCondition(currentPrice, condition);

  try {
    await getTransport().sendMail({
      from: config.smtpFrom,
      to: recipient,
      subject: low && !tracker.threshold_price
        ? `${subjectPrefix}Record low: ${tracker.name} is ${priceTagged}`
        : `${subjectPrefix}Price drop: ${tracker.name} is ${priceTagged}`,
      text,
      html,
    });
    logger.info({ trackerId: tracker.id, price: currentPrice }, 'Email price alert sent');
    return true;
  } catch (err) {
    logger.error({ err, trackerId: tracker.id }, 'Email price alert failed');
    return false;
  }
}

export async function sendEmailErrorAlert(
  tracker: Tracker,
  errorMsg: string,
  recipient: string,
): Promise<boolean> {
  try {
    await getTransport().sendMail({
      from: config.smtpFrom,
      to: recipient,
      subject: `Tracker error: ${tracker.name}`,
      text: errorAlertText(tracker, errorMsg),
      html: errorAlertHtml(tracker, errorMsg),
    });
    logger.info({ trackerId: tracker.id }, 'Email error alert sent');
    return true;
  } catch (err) {
    logger.error({ err, trackerId: tracker.id }, 'Email error alert failed');
    return false;
  }
}

import type { Project as ProjectType2, BasketState as BasketStateType2, BasketMember as BasketMemberType2 } from '../projects/types.js';

function basketEmailText(project: ProjectType2, basket: BasketStateType2, members: BasketMemberType2[], aiCommentary?: string | null): string {
  if (basket.total === null) return '';
  const memberLines = members.map(m => `  • ${m.tracker_name} — ${formatMoney(m.last_price ?? 0)}`).join('\n');
  const base = `Bundle ready: ${project.name}\n\n` +
    `Total: ${formatMoney(basket.total)} (target ${formatMoney(project.target_total)}, savings ${formatMoney(project.target_total - basket.total)})\n\n` +
    `Items:\n${memberLines}\n`;
  return aiCommentary ? `${base}\n${aiCommentary}\n` : base;
}

function basketEmailHtml(project: ProjectType2, basket: BasketStateType2, members: BasketMemberType2[], aiCommentary?: string | null): string {
  if (basket.total === null) return '';
  const memberRows = members.map(m =>
    `<li>${escapeHtml(m.tracker_name)} — <strong>${formatMoney(m.last_price ?? 0)}</strong></li>`
  ).join('');
  const aiBlock = aiCommentary ? `<p><em>${escapeHtml(aiCommentary)}</em></p>` : '';
  return `<h2>Bundle ready: ${escapeHtml(project.name)}</h2>` +
    `<p>Total: <strong>${formatMoney(basket.total)}</strong> ` +
    `(target ${formatMoney(project.target_total)}, savings ${formatMoney(project.target_total - basket.total)})</p>` +
    `<ul>${memberRows}</ul>${aiBlock}`;
}

export async function sendEmailBasketAlert(
  project: ProjectType2,
  basket: BasketStateType2,
  members: BasketMemberType2[],
  recipient: string,
  aiCommentary?: string | null,
): Promise<boolean> {
  if (basket.total === null) return false;
  try {
    await getTransport().sendMail({
      from: config.smtpFrom,
      to: recipient,
      subject: `Bundle ready: ${project.name} hit ${formatMoney(basket.total)}`,
      text: basketEmailText(project, basket, members, aiCommentary ?? null),
      html: basketEmailHtml(project, basket, members, aiCommentary ?? null),
    });
    logger.info({ projectId: project.id, total: basket.total }, 'Email basket alert sent');
    return true;
  } catch (err) {
    logger.error({ err, projectId: project.id }, 'Email basket alert failed');
    return false;
  }
}

/**
 * Send a purchase-arm notification. `title` and `plainText` come from
 * `purchaseArmContent()` in purchase-arm.ts so the copy stays canonical
 * and consistent across all channels.
 */
export async function sendEmailPurchaseArm(
  trackerName: string,
  currentPrice: number,
  buyUrl: string,
  recipient: string,
  title: string,
  plainText: string,
): Promise<boolean> {
  const html = `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1a1a1a; max-width: 520px; margin: 0 auto; padding: 24px;">
  <h2 style="margin: 0 0 8px 0; font-size: 18px;">${escapeHtml(title)}</h2>
  <div style="font-size: 28px; font-weight: 700; color: #16a34a; margin: 8px 0 16px 0;">${formatMoney(currentPrice)}</div>
  <p style="color: #374151;">${escapeHtml(plainText)}</p>
  <a href="${escapeAttr(buyUrl)}" style="display: inline-block; background: #16a34a; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 8px; font-weight: 500;">Review &amp; buy</a>
</body></html>`;

  try {
    await getTransport().sendMail({
      from: config.smtpFrom,
      to: recipient,
      subject: title,
      text: plainText,
      html,
    });
    logger.info({ trackerName, price: currentPrice }, 'Email purchase arm sent');
    return true;
  } catch (err) {
    logger.error({ err, trackerName }, 'Email purchase arm failed');
    return false;
  }
}

/**
 * Settings page "Send test email" endpoint backing. Returns the same
 * {ok, error} shape the other channels' test helpers use so the UI
 * branch is uniform.
 */
/** Digest delivery (phase 3). */
export async function sendEmailDigest(
  recipient: string,
  subject: string,
  text: string,
  html: string,
): Promise<boolean> {
  try {
    await getTransport().sendMail({ from: config.smtpFrom, to: recipient, subject, text, html });
    logger.info('Email digest sent');
    return true;
  } catch (err) {
    logger.error({ err }, 'Email digest failed');
    return false;
  }
}

export async function testEmail(recipient: string): Promise<{ ok: boolean; error?: string }> {
  if (!isEmailConfigured()) {
    return { ok: false, error: 'Email channel is not configured on the server' };
  }
  try {
    await getTransport().sendMail({
      from: config.smtpFrom,
      to: recipient,
      subject: 'Price Tracker — Test email',
      text: 'This is a test email from Price Tracker. If you got this, your notifications are wired up correctly.',
      html: '<p>This is a test email from Price Tracker. If you got this, your notifications are wired up correctly.</p>',
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
