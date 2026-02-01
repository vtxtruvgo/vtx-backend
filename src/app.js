import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import aiRoutes from './routes/aiRoutes.js';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'active', service: 'VTX Backend', version: '1.0.0' });
});

app.use('/api/ai', aiRoutes);
// Analytics Route (Offload to Neon)
import analyticsRoutes from './routes/analyticsRoutes.js';
app.use('/api/analytics', analyticsRoutes);

// Status Page
import statusRoutes from './routes/statusRoutes.js';
app.use('/status', statusRoutes); // Accessible at /status (HTML) and /status?format=json (JSON)

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

export default app;