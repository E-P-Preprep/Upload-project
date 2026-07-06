/**
 * vimeo.js — Vimeo API helpers
 *
 * Uses the TUS "approach" for uploads: we create the video object here
 * and return the upload_link to the client. The client sends video bytes
 * directly to Vimeo — this server never touches the binary data.
 */

const VIMEO_API   = 'https://api.vimeo.com';
const VIMEO_TOKEN = process.env.VIMEO_TOKEN;
const FOLDER_ID   = process.env.VIMEO_FOLDER_ID;

// The folder (Vimeo "project") URI passed to the create-video call so the video
// lands in the folder at creation. Accepts either a bare folder ID or a full URI.
const FOLDER_URI = FOLDER_ID
  ? (FOLDER_ID.includes('/') ? FOLDER_ID : `/me/projects/${FOLDER_ID}`)
  : null;

function vimeoHeaders() {
  return {
    'Authorization': `bearer ${VIMEO_TOKEN}`,
    'Content-Type':  'application/json',
    'Accept':        'application/vnd.vimeo.*+json;version=3.4',
  };
}

/**
 * Create a video object on Vimeo and get back a TUS upload URL.
 *
 * @param {{ fileName: string, fileSize: number, uploaderName: string }} params
 * @returns {{ uploadUrl: string, videoId: string, videoUri: string }}
 */
export async function initUpload({ fileName, fileSize, uploaderName }) {
  const title = fileName.replace(/\.[^.]+$/, '');
  const description = [
    `Uploaded by: ${uploaderName}`,
    `Original filename: ${fileName}`,
    `Uploaded on: ${new Date().toISOString()}`,
  ].join('\n');

  const payload = {
    name:        title,
    description,
    upload: {
      approach: 'tus',
      size:     fileSize,
    },
    privacy: { view: 'nobody' }, // private — team access only
  };

  // Place the video directly in the configured folder at creation time.
  if (FOLDER_URI) payload.folder_uri = FOLDER_URI;
  else console.warn('[vimeo] VIMEO_FOLDER_ID not set — video will not be placed in a folder');

  const res = await fetch(`${VIMEO_API}/me/videos`, {
    method:  'POST',
    headers: vimeoHeaders(),
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Vimeo API ${res.status}`);
  }

  const data = await res.json();
  const videoId = data.uri.replace('/videos/', '');

  return {
    uploadUrl: data.upload.upload_link,
    videoId,
    videoUri: data.uri,
  };
}

/**
 * Poll a video until it is playable — i.e. transcoding is at least partially
 * complete and Vimeo reports `is_playable: true` (equivalently play.status
 * "playable"). Used to hold the notification email until the video can be watched.
 *
 * @param {string} videoId
 * @param {{ intervalMs?: number, maxMs?: number }} [opts]
 * @returns {Promise<boolean>} true once playable; false on transcode error or timeout
 */
export async function waitUntilPlayable(videoId, { intervalMs = 10000, maxMs = 30 * 60 * 1000 } = {}) {
  const deadline = Date.now() + maxMs;

  while (Date.now() < deadline) {
    const res = await fetch(
      `${VIMEO_API}/videos/${videoId}?fields=is_playable,play.status,transcode.status`,
      { headers: vimeoHeaders() }
    );

    if (res.ok) {
      const v = await res.json();
      if (v.is_playable === true || v.play?.status === 'playable') return true;
      if (v.transcode?.status === 'error') return false; // transcoding failed — stop waiting
    }
    // Non-OK responses are treated as transient; keep polling until the deadline.

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return false; // never became playable within maxMs
}
