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

  const res = await fetch(`${VIMEO_API}/me/videos`, {
    method:  'POST',
    headers: vimeoHeaders(),
    body: JSON.stringify({
      name:        title,
      description,
      upload: {
        approach: 'tus',
        size:     fileSize,
      },
      privacy: { view: 'nobody' }, // private — team access only
    }),
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
 * Move a video into the configured Vimeo folder.
 *
 * @param {string} videoId
 */
export async function addToFolder(videoId) {
  if (!FOLDER_ID) {
    console.warn('[vimeo] VIMEO_FOLDER_ID not set — skipping folder assignment');
    return;
  }

  const res = await fetch(
    `${VIMEO_API}/me/projects/${FOLDER_ID}/videos/${videoId}`,
    {
      method:  'PUT',
      headers: vimeoHeaders(),
    }
  );

  // 204 No Content = success; anything else is an error
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Vimeo folder API ${res.status}`);
  }
}
