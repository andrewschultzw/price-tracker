import { sendDiscordPurchaseArm } from './discord.js';
import { sendNtfyPurchaseArm } from './ntfy.js';
import { sendWebPushPurchaseArm } from './web-push.js';
import type { EnabledChannels } from '../scheduler/cron.js';
import { logger } from '../logger.js';

export function purchaseArmContent(
  trackerName: string,
  currentPrice: number,
  threshold: number,
  buyUrl: string,
): { title: string; body: string } {
  return {
    title: `🛒 Ready to buy: ${trackerName}`,
    body: `${trackerName} hit $${currentPrice.toFixed(2)} (your buy limit $${threshold.toFixed(2)}). Approve → ${buyUrl}`,
  };
}

export async function firePurchaseArm(
  trackerName: string,
  currentPrice: number,
  threshold: number,
  buyUrl: string,
  channels: EnabledChannels,
  userId: number,
): Promise<string[]> {
  const tasks: { name: string; p: Promise<boolean> }[] = [];

  if (channels.discord) {
    tasks.push({ name: 'discord', p: sendDiscordPurchaseArm(trackerName, currentPrice, threshold, buyUrl, channels.discord) });
  }
  if (channels.ntfy) {
    tasks.push({ name: 'ntfy', p: sendNtfyPurchaseArm(trackerName, currentPrice, threshold, buyUrl, channels.ntfy, channels.ntfyToken) });
  }
  if (channels.web_push) {
    tasks.push({ name: 'web_push', p: sendWebPushPurchaseArm(trackerName, currentPrice, threshold, buyUrl, userId) });
  }

  const results = await Promise.all(tasks.map(t => t.p));
  const sent = tasks.filter((_, i) => results[i]).map(t => t.name);
  logger.info({ trackerName, sent }, 'purchase_arm_dispatched');
  return sent;
}
