import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import aiRoutes from './routes/aiRoutes.js';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Enable Form Support for Admin Console

// Status Page & Root Handler
import statusRoutes from './routes/statusRoutes.js';
import { getSystemStatus } from './controllers/statusController.js';

// If accessing via status subdomain or root, show status page
app.get('/', (req, res, next) => {
  // Optional: Check hostname if you want to be strict, but for now serve status at root
  // to make status.codekraft.truvgo.me work out of the box.
  return getSystemStatus(req, res);
});

app.use('/api/ai', aiRoutes);
// Analytics Route (Offload to Neon)
import analyticsRoutes from './routes/analyticsRoutes.js';
app.use('/api/analytics', analyticsRoutes);

app.use('/status', statusRoutes); // Accessible at /status (HTML)

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

export default app;