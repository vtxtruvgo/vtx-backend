import express from 'express';
import { trackView } from '../controllers/analyticsController.js';

const router = express.Router();

router.post('/view', trackView);

export default router;