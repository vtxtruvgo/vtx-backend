import express from 'express';
import { getSystemStatus } from '../controllers/statusController.js';

const router = express.Router();

// Root of /status returns the page
router.get('/', getSystemStatus);

export default router;