import express from 'express';
import { getSystemStatus } from '../controllers/statusController.js';

const router = express.Router();

// Root of /status returns the Public page
// Status Page (Public)
router.get('/', getSystemStatus);

// Admin Center Route (Host Specific or Path Specific)
router.get('/vtx/2026/admincenter', getSystemStatus);

// Incident Posting
import { createIncident, resolveAllIncidents } from '../controllers/statusController.js';
import bodyParser from 'express'; // Ensure body parser is used in app.js
router.post('/vtx/2026/admincenter/incidents', createIncident);
router.get('/vtx/2026/admincenter/resolve_all', resolveAllIncidents);

// Legacy/Short Admin Redirect (Optional)
router.get('/admin', (req, res) => res.redirect('/status/vtx/2026/admincenter'));

export default router;