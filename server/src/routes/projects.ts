import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  listProjectsForUser, getProjectById, createProject, updateProject, deleteProject,
  addProjectTracker, removeProjectTracker, updateProjectTracker,
  getBasketMembersForProject, getRecentProjectNotifications,
  getTrackerById,
} from '../db/queries.js';

const router = Router();

const CreateProjectSchema = z.object({
  name: z.string().min(1).max(200),
  target_total: z.number().positive(),
});
const UpdateProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  target_total: z.number().positive().optional(),
  status: z.enum(['active', 'archived']).optional(),
});
const AddTrackerSchema = z.object({
  tracker_id: z.number().int().positive(),
  per_item_ceiling: z.number().positive().nullable().optional(),
  position: z.number().int().nonnegative().optional(),
});
const UpdateTrackerSchema = z.object({
  per_item_ceiling: z.number().positive().nullable().optional(),
  position: z.number().int().nonnegative().optional(),
});

// GET /api/projects?status=active|archived
router.get('/', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const rawStatus = req.query.status;
  const status = rawStatus === 'active' || rawStatus === 'archived' ? rawStatus : undefined;
  const projects = listProjectsForUser(userId, status);
  res.json(projects);
});

// POST /api/projects
router.post('/', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const parsed = CreateProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  }
  const id = createProject({ user_id: userId, name: parsed.data.name, target_total: parsed.data.target_total });
  const project = getProjectById(id);
  res.status(201).json(project);
});

// GET /api/projects/:id (project + members + recent notifications)
router.get('/:id', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  const project = getProjectById(id, userId);
  if (!project) return res.status(404).json({ error: 'not_found' });
  const members = getBasketMembersForProject(id);
  const recent_notifications = getRecentProjectNotifications(id, 10);
  res.json({ project, members, recent_notifications });
});

// PATCH /api/projects/:id
router.patch('/:id', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  const project = getProjectById(id, userId);
  if (!project) return res.status(404).json({ error: 'not_found' });
  const parsed = UpdateProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  }
  updateProject(id, parsed.data);
  res.json(getProjectById(id, userId));
});

// DELETE /api/projects/:id
router.delete('/:id', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  const project = getProjectById(id, userId);
  if (!project) return res.status(404).json({ error: 'not_found' });
  deleteProject(id);
  res.status(204).send();
});

// POST /api/projects/:id/trackers
router.post('/:id/trackers', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  const project = getProjectById(id, userId);
  if (!project) return res.status(404).json({ error: 'not_found' });

  const parsed = AddTrackerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  }
  // Cross-user guard: can only add own trackers
  const tracker = getTrackerById(parsed.data.tracker_id, userId);
  if (!tracker) return res.status(404).json({ error: 'tracker_not_found' });

  try {
    addProjectTracker({
      project_id: id,
      tracker_id: parsed.data.tracker_id,
      per_item_ceiling: parsed.data.per_item_ceiling ?? null,
      position: parsed.data.position ?? 0,
    });
  } catch (err) {
    // Likely a PK violation (duplicate membership)
    return res.status(409).json({ error: 'already_member' });
  }
  res.status(201).json(getBasketMembersForProject(id));
});

// DELETE /api/projects/:id/trackers/:trackerId
router.delete('/:id/trackers/:trackerId', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  const trackerId = Number(req.params.trackerId);
  const project = getProjectById(id, userId);
  if (!project) return res.status(404).json({ error: 'not_found' });
  removeProjectTracker(id, trackerId);
  res.status(204).send();
});

// PATCH /api/projects/:id/trackers/:trackerId
router.patch('/:id/trackers/:trackerId', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  const trackerId = Number(req.params.trackerId);
  const project = getProjectById(id, userId);
  if (!project) return res.status(404).json({ error: 'not_found' });
  const parsed = UpdateTrackerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  }
  updateProjectTracker(id, trackerId, parsed.data);
  res.json(getBasketMembersForProject(id));
});

export default router;
