'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { runAgent } = require('./agent');

const app  = express();
const PORT = process.env.PORT || 3000;

// Ensure required runtime directories exist on startup
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
const LOGS_DIR = path.join(__dirname, 'logs');
try {
  if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
} catch (e) {
  // Ignore filesystem errors if read-only or restricted
}

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/screenshots', express.static(SCREENSHOTS_DIR, {
  setHeaders: (res) => {
    // Prevent browser caching of screenshots so new runs always show fresh images
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  },
}));

// ── Health check endpoint ──────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// ── Run agent with Server-Sent Events streaming ────────────────────────────
app.post('/api/run', async (req, res) => {
  // Validate request body
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Request body must be a JSON object' });
  }

  const { instruction } = req.body;
  if (!instruction || typeof instruction !== 'string' || !instruction.trim()) {
    return res.status(400).json({ error: 'Missing or empty "instruction" field' });
  }

  const runId = String(Date.now());
  req.body.runId = runId;

  // Set up SSE headers
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  const send = (data) => {
    try {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      }
    } catch (err) {
      console.error(`SSE write error: ${err.message}`);
    }
  };

  send({ type: 'metadata', runId });

  try {
    const result = await runAgent(req.body, (level, msg) => {
      send({ type: 'log', level, msg });
    });
    send({ type: 'done', result, runId });
  } catch (err) {
    console.error(`Agent runtime error: ${err.stack || err.message}`);
    send({ type: 'error', msg: err.message || 'Unknown error occurred' });
  }

  if (!res.writableEnded) {
    res.end();
  }
});

// ── Return screenshot list after a run ────────────────────────────────────
app.get('/api/screenshots', (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    let runId = req.query.runId;
    if (!runId) {
      const rootDir = path.join(__dirname, 'screenshots');
      if (fs.existsSync(rootDir)) {
        const subdirs = fs.readdirSync(rootDir)
          .filter(f => f.startsWith('run_') && fs.statSync(path.join(rootDir, f)).isDirectory())
          .sort();
        if (subdirs.length > 0) {
          runId = subdirs[subdirs.length - 1].replace('run_', '');
        }
      }
    }

    const dir = runId 
      ? path.join(__dirname, 'screenshots', `run_${runId}`)
      : path.join(__dirname, 'screenshots');

    if (!fs.existsSync(dir)) return res.json([]);
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.png'))
      .sort();
    
    const prefix = runId ? `/screenshots/run_${runId}` : '/screenshots';
    res.json(files.map(f => `${prefix}/${f}`));
  } catch (err) {
    console.error(`Screenshot listing error: ${err.message}`);
    res.status(500).json({ error: 'Failed to list screenshots' });
  }
});

// ── Return the latest run details (logs, summary, screenshots) ───────────
app.get('/api/latest', (req, res) => {
  try {
    const rootDir = path.join(__dirname, 'screenshots');
    let latestRunId = null;
    if (fs.existsSync(rootDir)) {
      const subdirs = fs.readdirSync(rootDir)
        .filter(f => f.startsWith('run_') && fs.statSync(path.join(rootDir, f)).isDirectory())
        .sort();
      if (subdirs.length > 0) {
        latestRunId = subdirs[subdirs.length - 1].replace('run_', '');
      }
    }

    // Read summary.json if exists
    let summary = null;
    const summaryPath = path.join(__dirname, 'logs', 'summary.json');
    if (fs.existsSync(summaryPath)) {
      try {
        summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
      } catch (e) {
        // Ignore parse errors
      }
    }

    // Read latest log file
    let latestLog = null;
    const logDir = path.join(__dirname, 'logs');
    if (fs.existsSync(logDir)) {
      const logFiles = fs.readdirSync(logDir)
        .filter(f => f.startsWith('agent_') && f.endsWith('.log'))
        .map(f => ({ name: f, time: fs.statSync(path.join(logDir, f)).mtimeMs }))
        .sort((a, b) => b.time - a.time);
      if (logFiles.length > 0) {
        latestLog = fs.readFileSync(path.join(logDir, logFiles[0].name), 'utf8');
      }
    }

    res.json({
      runId: latestRunId,
      summary,
      logs: latestLog
    });
  } catch (err) {
    console.error(`Failed to get latest run data: ${err.message}`);
    res.status(500).json({ error: 'Failed to get latest run data' });
  }
});

// ── Check environment API keys configuration ──────────────────────────────
app.get('/api/config', (_req, res) => {
  res.json({
    gemini:     !!process.env.GEMINI_API_KEY,
    openrouter: !!process.env.OPENROUTER_API_KEY,
    grok:       !!(process.env.GROK_API_KEY || process.env.XAI_API_KEY),
  });
});

// ── Global error handler ──────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(`Unhandled server error: ${err.stack || err.message}`);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Start server ──────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🚀  Agent UI → http://localhost:${PORT}\n`);
  });
}

module.exports = app;
