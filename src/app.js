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
// Mount Status Routes at Root to handle Public Page AND Admin Routes
app.use('/', statusRoutes);

app.use('/api/ai', aiRoutes);
// Analytics Route (Offload to Neon)
import analyticsRoutes from './routes/analyticsRoutes.js';
app.use('/api/analytics', analyticsRoutes);

app.use('/status', statusRoutes); // Accessible at /status (HTML)

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

// Safe Error Handling
app.use((err, req, res, next) => {
  console.error("Critical Server Error:", err);
  res.status(500).send(`
        <html><body>
        <h1>System Recovering...</h1>
        <p>The status page encountered an internal error. Please check back in 1 minute.</p>
        <pre>${process.env.NODE_ENV === 'development' ? err.stack : err.message}</pre>
        </body></html>
    `);
});

export default app;