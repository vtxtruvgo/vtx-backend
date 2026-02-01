import express from 'express';
import {
    trackView,
    getOverviewStats,
    getUserGrowth,
    getPostActivity,
    getEngagementMetrics,
    getLiveTickerData,
    syncAnalyticsData
} from '../controllers/analyticsController.js';

const router = express.Router();

// POST endpoint for tracking views
router.post('/view', trackView);

// GET endpoints for analytics dashboard
router.get('/overview', getOverviewStats);
router.get('/user-growth', getUserGrowth);
router.get('/post-activity', getPostActivity);
router.get('/engagement', getEngagementMetrics);
router.get('/ticker', getLiveTickerData);

// POST endpoint for syncing data from Supabase to Neon (admin only)
router.post('/sync', syncAnalyticsData);

export default router;
