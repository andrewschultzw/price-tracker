import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { initializeSchema } from './schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import {
  createProject, getProjectById, listProjectsForUser, updateProject, deleteProject,
  addProjectTracker, removeProjectTracker, updateProjectTracker,
  getActiveProjectIdsForTracker, getBasketMembersForProject,
  getLastProjectNotificationForChannel, getRecentProjectNotifications, addProjectNotification,
} from './queries.js';

function seedUser(email = 't@x.com'): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES (?, 'h', 'T', 'user', 1)`
  ).run(email).lastInsertRowid);
}

function seedTracker(userId: number, name = 'X', lastPrice: number | null = 50): number {
  return Number(getDb().prepare(
    `INSERT INTO trackers (name, url, user_id, threshold_price, status, check_interval_minutes, jitter_minutes, last_price)
     VALUES (?, ?, ?, 100, 'active', 60, 0, ?)`
  ).run(name, `https://example/${name}`, userId, lastPrice).lastInsertRowid);
}

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
  initializeSchema();
});

describe('project CRUD', () => {
  it('creates and retrieves a project', () => {
    const userId = seedUser();
    const id = createProject({ user_id: userId, name: 'NAS', target_total: 1200 });
    const p = getProjectById(id);
    expect(p?.name).toBe('NAS');
    expect(p?.target_total).toBe(1200);
    expect(p?.status).toBe('active');
  });

  it('getProjectById with userId scopes correctly (cross-user isolation)', () => {
    const u1 = seedUser('a@x.com');
    const u2 = seedUser('b@x.com');
    const id = createProject({ user_id: u1, name: 'P', target_total: 100 });
    expect(getProjectById(id, u1)).toBeDefined();
    expect(getProjectById(id, u2)).toBeUndefined();
  });

  it('listProjectsForUser filters by status when provided', () => {
    const u = seedUser();
    const a = createProject({ user_id: u, name: 'A', target_total: 100 });
    const b = createProject({ user_id: u, name: 'B', target_total: 100 });
    updateProject(b, { status: 'archived' });
    expect(listProjectsForUser(u, 'active').map(p => p.id)).toEqual([a]);
    expect(listProjectsForUser(u, 'archived').map(p => p.id)).toEqual([b]);
    expect(listProjectsForUser(u).map(p => p.id).sort()).toEqual([a, b].sort());
  });

  it('updateProject is partial (only specified fields change)', () => {
    const u = seedUser();
    const id = createProject({ user_id: u, name: 'A', target_total: 100 });
    updateProject(id, { name: 'B' });
    const p = getProjectById(id);
    expect(p?.name).toBe('B');
    expect(p?.target_total).toBe(100);
    expect(p?.status).toBe('active');
  });

  it('deleteProject cascades to project_trackers + project_notifications', () => {
    const u = seedUser();
    const t = seedTracker(u);
    const p = createProject({ user_id: u, name: 'P', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t });
    addProjectNotification({ project_id: p, channel: 'discord', basket_total: 50, target_total: 100, ai_commentary: null });
    deleteProject(p);
    expect(getProjectById(p)).toBeUndefined();
  });
});

describe('project membership', () => {
  it('addProjectTracker stores ceiling + position', () => {
    const u = seedUser();
    const t = seedTracker(u);
    const p = createProject({ user_id: u, name: 'P', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t, per_item_ceiling: 25, position: 3 });
    const members = getBasketMembersForProject(p);
    expect(members).toHaveLength(1);
    expect(members[0].per_item_ceiling).toBe(25);
    expect(members[0].position).toBe(3);
  });

  it('addProjectTracker rejects duplicate (project, tracker) pair via PK', () => {
    const u = seedUser();
    const t = seedTracker(u);
    const p = createProject({ user_id: u, name: 'P', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t });
    expect(() => addProjectTracker({ project_id: p, tracker_id: t })).toThrow();
  });

  it('removeProjectTracker removes only the matching row', () => {
    const u = seedUser();
    const t1 = seedTracker(u, 'A');
    const t2 = seedTracker(u, 'B');
    const p = createProject({ user_id: u, name: 'P', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t1 });
    addProjectTracker({ project_id: p, tracker_id: t2 });
    removeProjectTracker(p, t1);
    expect(getBasketMembersForProject(p).map(m => m.tracker_id)).toEqual([t2]);
  });

  it('updateProjectTracker updates ceiling without touching position', () => {
    const u = seedUser();
    const t = seedTracker(u);
    const p = createProject({ user_id: u, name: 'P', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t, per_item_ceiling: 25, position: 3 });
    updateProjectTracker(p, t, { per_item_ceiling: 30 });
    const members = getBasketMembersForProject(p);
    expect(members[0].per_item_ceiling).toBe(30);
    expect(members[0].position).toBe(3);
  });

  it('getBasketMembersForProject surfaces AI verdict fields when populated', () => {
    const u = seedUser();
    const t = seedTracker(u);
    getDb().prepare(`UPDATE trackers SET ai_verdict_tier='BUY', ai_verdict_reason='At low.' WHERE id=?`).run(t);
    const p = createProject({ user_id: u, name: 'P', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t });
    const members = getBasketMembersForProject(p);
    expect(members[0].ai_verdict_tier).toBe('BUY');
    expect(members[0].ai_verdict_reason).toBe('At low.');
  });
});

describe('cron lookup', () => {
  it('getActiveProjectIdsForTracker returns only active project ids', () => {
    const u = seedUser();
    const t = seedTracker(u);
    const a = createProject({ user_id: u, name: 'A', target_total: 100 });
    const b = createProject({ user_id: u, name: 'B', target_total: 100 });
    updateProject(b, { status: 'archived' });
    addProjectTracker({ project_id: a, tracker_id: t });
    addProjectTracker({ project_id: b, tracker_id: t });
    expect(getActiveProjectIdsForTracker(t)).toEqual([a]);
  });

  it('getActiveProjectIdsForTracker returns empty when tracker is in no projects', () => {
    const u = seedUser();
    const t = seedTracker(u);
    expect(getActiveProjectIdsForTracker(t)).toEqual([]);
  });
});

describe('project notifications', () => {
  it('addProjectNotification + getLastProjectNotificationForChannel returns latest row', async () => {
    const u = seedUser();
    const p = createProject({ user_id: u, name: 'P', target_total: 100 });
    addProjectNotification({ project_id: p, channel: 'discord', basket_total: 80, target_total: 100, ai_commentary: null });
    await new Promise(r => setTimeout(r, 1100));
    addProjectNotification({ project_id: p, channel: 'discord', basket_total: 75, target_total: 100, ai_commentary: 'AI-test' });
    const last = getLastProjectNotificationForChannel(p, 'discord');
    expect(last?.basket_total).toBe(75);
    expect(last?.ai_commentary).toBe('AI-test');
  });

  it('getRecentProjectNotifications respects the limit', () => {
    const u = seedUser();
    const p = createProject({ user_id: u, name: 'P', target_total: 100 });
    for (let i = 0; i < 15; i++) {
      addProjectNotification({ project_id: p, channel: 'discord', basket_total: i, target_total: 100, ai_commentary: null });
    }
    const rows = getRecentProjectNotifications(p, 5);
    expect(rows).toHaveLength(5);
  });
});
