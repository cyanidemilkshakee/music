const crypto = require('crypto');
const express = require('express');
const path = require('path');
const compression = require('compression');

const apiRoutes = require('./routes/api');
const mediaRoutes = require('./routes/media');
const database = require('./services/db');

const app = express();

const PORT = 1111;
const HOST = '127.0.0.1';
const isProduction = process.env.NODE_ENV === 'production';

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const REQUEST_TIMEOUT_MS = parsePositiveInteger(process.env.REQUEST_TIMEOUT_MS, 2 * 60 * 1000);
const JSON_LIMIT = process.env.JSON_LIMIT || '2mb';

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

app.disable('x-powered-by');
app.set('trust proxy', false);

app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(compression());
app.use(express.json({ limit: JSON_LIMIT }));

app.use(express.static(PUBLIC_DIR, {
  dotfiles: 'ignore',
  fallthrough: true,
  setHeaders(res, filePath) {
    if (path.extname(filePath).toLowerCase() === '.html') {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

app.use('/api', mediaRoutes);
app.use('/api', apiRoutes);

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found.', requestId: req.id });
});

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'), error => {
      if (error) next(error);
    });
    return;
  }
  next();
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const status = err.type === 'entity.parse.failed'
    ? 400
    : Number(err.statusCode || err.status || 500);
  const safeStatus = status >= 400 && status <= 599 ? status : 500;
  const expose = err.expose || safeStatus < 500;
  const message = expose ? err.message : 'Internal Server Error';

  if (safeStatus >= 500) {
    console.error(`[${req.id}] ${req.method} ${req.originalUrl}`, err);
  }

  const payload = {
    error: message,
    requestId: req.id
  };
  if (err.detail && expose) payload.detail = err.detail;
  if (!isProduction && !expose && err.message) payload.detail = err.message;

  res.status(safeStatus).json(payload);
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Local Amp is running at http://${HOST}:${PORT}`);
});

server.requestTimeout = REQUEST_TIMEOUT_MS;
server.headersTimeout = REQUEST_TIMEOUT_MS + 5000;
server.keepAliveTimeout = 5000;

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use on ${HOST}.`);
  } else {
    console.error('Server failed:', error);
  }
  process.exitCode = 1;
});

let shuttingDown = false;
function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Shutting down Local Amp (${reason}).`);

  const forceTimer = setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(exitCode || 1);
  }, 8000);
  forceTimer.unref();

  server.close(() => {
    try {
      database.close();
    } catch (error) {
      console.error('Database close failed:', error);
      exitCode = exitCode || 1;
    }
    clearTimeout(forceTimer);
    process.exit(exitCode);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', reason => {
  console.error('Unhandled promise rejection:', reason);
  shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', error => {
  console.error('Uncaught exception:', error);
  shutdown('uncaughtException', 1);
});
