import nodemailer, { Transporter } from 'nodemailer';
import { config, isEmailConfigured } from '../config.js';
import { logger } from '../logger.js';
import type { Tracker } from '../db/queries.js';

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

function priceAlertText(tracker: Tracker, price: number): string {
  const threshold = tracker.threshold_price!;
  const savings = threshold - price;
  return [
    `${tracker.name} dropped to ${formatMoney(price)}`,
    '',
    `Target: ${formatMoney(threshold)}`,
    `Savings: ${formatMoney(savings)}`,
    `Seller: ${hostOf(tracker.url)}`,
    '',
    `Buy now: ${tracker.url}`,
  ].join('\n');
}

function priceAlertHtml(tracker: Tracker, price: number): string {
  const threshold = tracker.threshold_price!;
  const savings = threshold - price;
  const host = hostOf(tracker.url);
  return `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1a1a1a; max-width: 520px; margin: 0 auto; padding: 24px;">
  <h2 style="margin: 0 0 8px 0; font-size: 18px;">${escapeHtml(tracker.name)}</h2>
  <div style="font-size: 28px; font-weight: 700; color: #16a34a; margin: 8px 0 16px 0;">${formatMoney(price)}</div>
  <table style="border-collapse: collapse; margin-bottom: 20px;" cellpadding="4">
    <tr><td style="color: #6b7280;">Target</td><td style="font-weight: 600;">${formatMoney(threshold)}</td></tr>
    <tr><td style="color: #6b7280;">Savings</td><td style="font-weight: 600; color: #16a34a;">${formatMoney(savings)}</td></tr>
    <tr><td style="color: #6b7280;">Seller</td><td>${escapeHtml(host)}</td></tr>
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
): Promise<boolean> {
  if (!tracker.threshold_price) return false;
  const baseText = priceAlertText(tracker, currentPrice);
  const baseHtml = priceAlertHtml(tracker, currentPrice);
  const text = aiCommentary ? `${baseText}\n\n${aiCommentary}` : baseText;
  const html = aiCommentary
    ? baseHtml.replace('</body>', `<p style="margin-top: 16px; color: #374151;">${escapeHtml(aiCommentary)}</p>\n</body>`)
    : baseHtml;
  try {
    await getTransport().sendMail({
      from: config.smtpFrom,
      to: recipient,
      subject: `Price drop: ${tracker.name} is ${formatMoney(currentPrice)}`,
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
 * Settings page "Send test email" endpoint backing. Returns the same
 * {ok, error} shape the other channels' test helpers use so the UI
 * branch is uniform.
 */
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
