/**
 * Vimeo Secure Upload — Backend Server
 * Node.js / Express
 *
 * Routes:
 *   POST /api/init-upload   — creates Vimeo video, returns upload_url + video_id
 *   PUT  /api/add-to-folder — moves video into configured Vimeo folder
 *   POST /api/notify        — sends upload notification email via Microsoft Graph
 *   GET  /api/health        — liveness check
 */

import 'dotenv/config'; // MUST be first — loads .env before any module reads process.env

import express      from 'express';
import cors         from 'cors';
import helmet       from 'helmet';
import rateLimit    from 'express-rate-limit';
import { initUpload }   from './vimeo.js';
import { addToFolder }  from './vimeo.js';
import { sendNotification } from './mailer.js';
import { validateInitBody, validateNotifyBody } from './validate.js';

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Security middleware ───────────────────────────────────────────────────────

app.use(helmet());

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || 'http://localhost:3000',
  methods: ['GET', 'POST', 'PUT'],
}));

app.use(express.json({ limit: '32kb' })); // body-only, not video data

// Rate limiting — generous for uploads, tighter for notify
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50,
  message: { error: 'Too many upload requests. Please try again later.' }
});

const notifyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  message: { error: 'Too many notification requests.' }
});

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/init-upload
 * Body: { fileName, fileSize, uploaderName }
 * Returns: { uploadUrl, videoId, videoUri }
 *
 * The client then PATCHes the uploadUrl directly (TUS) — video bytes
 * never touch this server.
 */
app.post('/api/init-upload', uploadLimiter, async (req, res) => {
  const err = validateInitBody(req.body);
  if (err) return res.status(400).json({ error: err });

  try {
    const result = await initUpload(req.body);
    res.json(result);
  } catch (e) {
    console.error('[init-upload]', e.message);
    res.status(502).json({ error: 'Could not create video on Vimeo.', detail: e.message });
  }
});

/**
 * PUT /api/add-to-folder
 * Body: { videoId }
 * Moves the video into the configured Vimeo folder.
 */
app.put('/api/add-to-folder', uploadLimiter, async (req, res) => {
  const { videoId } = req.body || {};
  if (!videoId || typeof videoId !== 'string') {
    return res.status(400).json({ error: 'videoId is required.' });
  }

  try {
    await addToFolder(videoId);
    res.json({ ok: true });
  } catch (e) {
    console.error('[add-to-folder]', e.message);
    res.status(502).json({ error: 'Could not add video to folder.', detail: e.message });
  }
});

/**
 * POST /api/notify
 * Body: { uploaderName, fileName, fileSize, videoId, notifyEmail }
 * Sends a confirmation email to the video team (notifyEmail).
 */
app.post('/api/notify', notifyLimiter, async (req, res) => {
  const err = validateNotifyBody(req.body);
  if (err) return res.status(400).json({ error: err });

  try {
    await sendNotification(req.body);
    res.json({ ok: true });
  } catch (e) {
    console.error('[notify]', e.message);
    res.status(502).json({ error: 'Could not send notification email.', detail: e.message });
  }
});

/**
 * GET /api/health
 */
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Vimeo upload backend listening on port ${PORT}`);
});
