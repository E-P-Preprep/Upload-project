/**
 * Vimeo Secure Upload — Backend Server
 * Node.js / Express
 *
 * Routes:
 *   POST /api/init-upload   — creates Vimeo video (in the configured folder), returns upload_url + video_id
 *   POST /api/notify        — sends upload notification email via Microsoft Graph
 *   GET  /api/health        — liveness check
 */

import 'dotenv/config'; // MUST be first — loads .env before any module reads process.env

import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';
import express      from 'express';
import cors         from 'cors';
import helmet       from 'helmet';
import rateLimit    from 'express-rate-limit';
import { initUpload, waitUntilPlayable } from './vimeo.js';
import { sendNotification } from './mailer.js';
import { validateInitBody, validateNotifyBody } from './validate.js';

const app  = express();
const PORT = process.env.PORT || 3001;
const __dirname = dirname(fileURLToPath(import.meta.url));

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
 * POST /api/notify
 * Body: { uploaderName, fileName, fileSize, videoId, notifyEmail }
 *
 * The email is held until the video is playable (transcoding at least partially
 * complete). We accept the request immediately (202) and then poll Vimeo in the
 * background, sending the email once `is_playable` is true.
 */
app.post('/api/notify', notifyLimiter, async (req, res) => {
  const err = validateNotifyBody(req.body);
  if (err) return res.status(400).json({ error: err });

  const { videoId } = req.body;

  // Accept now — the email goes out later, once the video can be played.
  res.status(202).json({ ok: true, pending: true });

  // Background: poll for playability, then notify. Errors are logged, not surfaced.
  (async () => {
    try {
      const playable = await waitUntilPlayable(videoId);
      if (!playable) {
        console.warn(`[notify] video ${videoId} not playable within timeout — email skipped`);
        return;
      }
      await sendNotification(req.body);
      console.log(`[notify] video ${videoId} playable — notification email sent`);
    } catch (e) {
      console.error('[notify]', e.message);
    }
  })();
});

/**
 * GET /api/health
 */
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});


// ── Frontend ──────────────────────────────────────────────────────────────────

app.use(express.static(__dirname));
app.get('/', (_req, res) => res.sendFile(join(__dirname, 'index.html')));

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Vimeo upload backend listening on port ${PORT}`);
});
