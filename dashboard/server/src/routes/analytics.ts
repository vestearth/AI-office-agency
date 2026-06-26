import { Router, Request, Response } from 'express';
import { AnalyticsService } from '../services/analytics';

const router = Router();
const service = new AnalyticsService();
const ALLOWED_WINDOW_DAYS = new Set([7, 14, 30]);

export function parseAnalyticsWindowDays(days: string | string[] | undefined): 7 | 14 | 30 {
  const rawValue = Array.isArray(days) ? days[0] : days;
  const parsed = Number.parseInt(rawValue ?? '', 10);
  if (ALLOWED_WINDOW_DAYS.has(parsed)) {
    return parsed as 7 | 14 | 30;
  }
  return 7;
}

router.get('/', async (req, res) => {
  try {
    const windowDays = parseAnalyticsWindowDays(req.query.days as string | string[] | undefined);
    res.json(await service.getAnalytics({ windowDays }));
  } catch (error) {
    console.error('Failed to fetch combined analytics:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

router.get('/summary', async (req, res) => {
  try {
    const windowDays = parseAnalyticsWindowDays(req.query.days as string | string[] | undefined);
    res.json(await service.getSummary({ windowDays }));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch analytics summary' });
  }
});

router.get('/trends', async (req, res) => {
  try {
    const windowDays = parseAnalyticsWindowDays(req.query.days as string | string[] | undefined);
    res.json(await service.getTrends({ windowDays }));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch analytics trends' });
  }
});

router.get('/failures', async (req, res) => {
  try {
    const windowDays = parseAnalyticsWindowDays(req.query.days as string | string[] | undefined);
    res.json(await service.getFailures({ windowDays }));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch failure insights' });
  }
});

router.get('/agents', async (req, res) => {
  try {
    const windowDays = parseAnalyticsWindowDays(req.query.days as string | string[] | undefined);
    res.json(await service.getAgents({ windowDays }));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch agent metrics' });
  }
});

router.get('/conductors', async (req, res) => {
  try {
    const windowDays = parseAnalyticsWindowDays(req.query.days as string | string[] | undefined);
    res.json(await service.getConductors({ windowDays }));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch conductor metrics' });
  }
});

router.get('/long-running', async (req, res) => {
  try {
    res.json(await service.getLongRunning());
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch long-running tasks' });
  }
});

export default router;
