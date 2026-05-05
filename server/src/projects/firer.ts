// server/src/projects/firer.ts
import { evaluateBasket } from './basket.js';
import {
  getProjectById, getBasketMembersForProject,
  getLastProjectNotificationForChannel, addProjectNotification,
} from '../db/queries.js';
import {
  getEnabledChannels, getCooldownHoursForChannel, CHANNEL_NAMES,
} from '../scheduler/cron.js';
import type { ChannelName } from '../scheduler/cron.js';
import { sendDiscordBasketAlert } from '../notifications/discord.js';
import { sendNtfyBasketAlert } from '../notifications/ntfy.js';
import { sendEmailBasketAlert } from '../notifications/email.js';
import { sendGenericBasketAlert } from '../notifications/webhook.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { buildBasketAlertCopyPrompt } from '../ai/prompts.js';
import { callClaude } from '../ai/client.js';
import { AIGenerationError } from '../ai/types.js';
import type { Project, BasketState, BasketMember } from './types.js';

function isWithinCooldown(lastSentAt: string, cooldownHours: number): boolean {
  if (cooldownHours <= 0) return false;
  const lastMs = new Date(lastSentAt + 'Z').getTime();
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  return Date.now() - lastMs < cooldownMs;
}

async function maybeGenerateAICommentary(args: {
  project: Project;
  basket: BasketState;
  members: BasketMember[];
}): Promise<string | null> {
  if (process.env.AI_ENABLED !== 'true') return null;
  if (args.basket.total === null) return null;
  try {
    const prompt = buildBasketAlertCopyPrompt({
      project: args.project, basket: args.basket, members: args.members,
    });
    const result = await Promise.race([
      callClaude(prompt).then(r => r.text),
      new Promise<null>(resolve => setTimeout(() => resolve(null), config.aiAlertCopyTimeoutMs)),
    ]);
    return result;
  } catch (err) {
    if (err instanceof AIGenerationError) {
      logger.info({ category: err.category, project_id: args.project.id }, 'ai_basket_copy_skip');
      return null;
    }
    logger.error({ err: String(err), project_id: args.project.id }, 'ai_basket_copy_unexpected');
    return null;
  }
}

export async function evaluateAndFireForProject(projectId: number): Promise<void> {
  try {
    const project = getProjectById(projectId);
    if (!project) {
      logger.info({ project_id: projectId }, 'basket_eval_skip_missing');
      return;
    }
    if (project.status !== 'active') {
      logger.info({ project_id: projectId, status: project.status }, 'basket_eval_skip_inactive');
      return;
    }

    const members = getBasketMembersForProject(projectId);
    const basket = evaluateBasket(project, members);

    if (!basket.eligible) {
      logger.info({ project_id: projectId, ineligible_reason: basket.ineligible_reason }, 'basket_eval_skip');
      return;
    }
    if (basket.total === null) return;  // Type narrowing — eligible implies non-null total

    const channels = getEnabledChannels(project.user_id);
    if (!channels.discord && !channels.ntfy && !channels.webhook && !channels.email) {
      logger.info({ project_id: projectId }, 'basket_alert_no_channels_enabled');
      return;
    }

    // Determine eligible channels (after cooldown gate).
    const eligibleChannels: ChannelName[] = [];
    for (const name of CHANNEL_NAMES) {
      if (!channels[name]) continue;
      const cooldownHours = getCooldownHoursForChannel(project.user_id, name);
      if (cooldownHours > 0) {
        const last = getLastProjectNotificationForChannel(projectId, name);
        if (last && isWithinCooldown(last.sent_at, cooldownHours)) {
          logger.info({ project_id: projectId, channel: name, cooldownHours }, 'basket_alert_cooldown');
          continue;
        }
      }
      eligibleChannels.push(name);
    }
    if (eligibleChannels.length === 0) return;

    // Generate AI commentary once for all eligible channels.
    const aiCommentary = await maybeGenerateAICommentary({ project, basket, members });

    // Dispatch in parallel; record notifications only for successful sends.
    const dispatch = await Promise.allSettled(eligibleChannels.map(async (name) => {
      let ok = false;
      switch (name) {
        case 'discord':
          ok = await sendDiscordBasketAlert(project, basket, members, channels.discord!, aiCommentary);
          break;
        case 'ntfy':
          ok = await sendNtfyBasketAlert(project, basket, members, channels.ntfy!, channels.ntfyToken, aiCommentary);
          break;
        case 'email':
          ok = await sendEmailBasketAlert(project, basket, members, channels.email!, aiCommentary);
          break;
        case 'webhook':
          ok = await sendGenericBasketAlert(project, basket, members, channels.webhook!, aiCommentary);
          break;
      }
      return { name, ok };
    }));

    for (let i = 0; i < dispatch.length; i++) {
      const result = dispatch[i];
      if (result.status === 'fulfilled' && result.value.ok) {
        addProjectNotification({
          project_id: projectId,
          channel: result.value.name,
          basket_total: basket.total,
          target_total: project.target_total,
          ai_commentary: aiCommentary,
        });
        logger.info({ project_id: projectId, channel: result.value.name, basket_total: basket.total, target_total: project.target_total }, 'basket_alert_fire');
      } else {
        const channelName = result.status === 'fulfilled' ? result.value.name : eligibleChannels[i];
        logger.warn({ project_id: projectId, channel: channelName, err: result.status === 'rejected' ? String(result.reason) : 'send returned false' }, 'basket_alert_failed');
      }
    }
  } catch (err) {
    logger.error({ project_id: projectId, err: String(err) }, 'basket_eval_unexpected');
  }
}
