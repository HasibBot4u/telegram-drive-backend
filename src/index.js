import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { apiRateLimiter, authRateLimiter } from './middleware/rateLimiter.js';
import authRoutes from './routes/auth.js';
import folderRoutes from './routes/folders.js';
import fileRoutes from './routes/files.js';
import transferRoutes from './routes/transfers.js';
import settingsRoutes from './routes/settings.js';

const app = express();
const PORT = process.env.PORT || 3000;

// CORS - allow everything (fine for personal app)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range'],
  exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'],
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health checks - used by UptimeRobot to keep server alive
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Telegram Drive Backend is running',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', uptime: process.uptime() });
});

// ROUTES - carefully ordered to avoid path conflicts
// Auth routes (strictest rate limit, no auth middleware needed)
app.use('/api/auth', authRateLimiter, authRoutes);

// Folder routes - folderRoutes applies authMiddleware internally
app.use('/api/folders', apiRateLimiter, folderRoutes);

// File routes - mounted at /api so routes inside files.js keep their full path
// This covers: /api/folders/:chatId/files, /api/files/*, /api/search, /api/files/*/thumbnail
// fileRoutes applies authMiddleware internally
app.use('/api', apiRateLimiter, fileRoutes);

// Transfer routes - mounted at /api so routes inside transfers.js keep their full path
// This covers: /api/upload, /api/upload/*/progress, /api/upload/*/cancel,
// /api/upload/*/retry, /api/download/*, /api/stream/*
// transferRoutes applies authMiddleware per-route internally
app.use('/api', apiRateLimiter, transferRoutes);

// Settings routes - settingsRoutes applies authMiddleware internally
// This covers: /api/settings, /api/settings/storage/clear-cache, /api/settings/storage/info
app.use('/api/settings', apiRateLimiter, settingsRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: `Route ${req.method} ${req.path} not found`,
    code: 'NOT_FOUND',
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: err.message || 'Internal server error',
    code: 'INTERNAL_ERROR',
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Telegram Drive Backend running on port ${PORT}`);
  console.log(`📦 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🗄️  Supabase: ${process.env.SUPABASE_URL ? 'Connected' : '❌ MISSING SUPABASE_URL'}`);
  console.log(`🔐 JWT: ${process.env.JWT_SECRET ? 'Configured' : '❌ MISSING JWT_SECRET'}`);
});

export default app;
