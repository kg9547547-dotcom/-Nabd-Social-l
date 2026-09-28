import 'dotenv/config';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import { createServer as createViteServer } from 'vite';
import { initDatabase } from './src/server/db/index.js';
import { apiRouter } from './src/server/routes/api.js';
import { getUploadsPath } from './src/server/storage/upload.js';
import { setupSocketServer } from './src/server/realtime/socket.js';
import { getCloudMediaFromPostgres } from './src/db/repository.js';
import { isPostgresConfigured } from './src/db/index.js';

async function startServer() {
  await initDatabase();

  const app = express();
  app.disable('x-powered-by');
  const server = http.createServer(app);

  // High-concurrency HTTP tuning for 60+ simultaneous users
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.maxHeadersCount = 1000;
  server.setMaxListeners(200);

  // Attach Socket.io real-time server on the same HTTP server (port 3000)
  setupSocketServer(server);

  app.use(
    compression({
      threshold: 1024,
      level: 6
    })
  );
  app.use(cookieParser());
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Serve uploaded files from disk storage with caching headers to reduce bandwidth under load
  app.use(
    '/uploads',
    express.static(getUploadsPath(), {
      maxAge: '7d',
      etag: true
    })
  );

  // If local disk was reset on container restart, serve and restore media directly from Cloud SQL / Firebase Storage
  app.get('/uploads/:filename', async (req, res, next) => {
    try {
      const safeFilename = path.basename(req.params.filename || '');
      if (!safeFilename || !isPostgresConfigured()) {
        return next();
      }
      const mediaRow = await getCloudMediaFromPostgres(safeFilename);
      if (!mediaRow) return next();

      if (mediaRow.firebaseUrl) {
        return res.redirect(302, mediaRow.firebaseUrl);
      }
      if (mediaRow.dataBase64) {
        const buf = Buffer.from(mediaRow.dataBase64, 'base64');
        try {
          const localPath = path.join(getUploadsPath(), safeFilename);
          fs.writeFileSync(localPath, buf);
        } catch {
          // ignore disk cache write warning
        }
        res.setHeader('Content-Type', mediaRow.mimeType || 'application/octet-stream');
        res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
        return res.send(buf);
      }
      return next();
    } catch {
      return next();
    }
  });

  // API Routes
  app.use('/api', apiRouter);

  // Error handler for Multer / API errors
  app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'خطأ في معالجة الطلب' });
    }
    next();
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = Number(process.env.PORT) || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Nabd Social Hub] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});