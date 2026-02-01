import express from 'express';
import { getSystemStatus } from '../controllers/statusController.js';

const router = express.Router();

// Root of /status returns the Public page
router.get('/', getSystemStatus);

// Admin Dashboard
router.get('/admin', getSystemStatus); // Controller handles the 'admin' view logic based on path

export default router;