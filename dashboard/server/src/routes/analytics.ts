import { Router } from 'express';
import { FlowInsightsService } from '../services/flowInsights';

const router = Router();
const service = new FlowInsightsService();
const ALLOWED_WINDOW_DAYS = new Set([7, 14, 30]);

export function parseAnalyticsWindowDays(days: string | string[] | undefined): 7 | 14 | 30 {
  const rawValue = Array.isArray(days) ? days[0] : days;
  const parsed = Number.parseInt(rawValue ?? '', 10);
  if (ALLOWED_WINDOW_DAYS.has(parsed)) {
    return parsed as 7 | 14 | 30;
  }
  return 7;
}

// Insights "Flow": stuck work, waits and health are current state; days=7|14|30
// windows only throughput and who moved work.
router.get('/flow', async (req, res) => {
  try {
    const windowDays = parseAnalyticsWindowDays(req.query.days as string | string[] | undefined);
    res.json(await service.get(windowDays));
  } catch (error) {
    console.error('Failed to build flow insights:', error);
    res.status(500).json({ error: 'Failed to build flow insights' });
  }
});

export default router;
