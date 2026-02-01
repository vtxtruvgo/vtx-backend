import express from 'express';
import handler from '../controllers/aiBotController.js';

const router = express.Router();

router.post('/webhook', (req, res) => handler(req, res));

export default router;