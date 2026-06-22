/**
 * validate.js — lightweight request body validation
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME = 120;
const MAX_FILE = 120;
const MAX_SIZE = 50 * 1024 * 1024 * 1024; // 50 GB upper guard

/**
 * Validate POST /api/init-upload body.
 * Returns an error string or null if valid.
 */
export function validateInitBody({ fileName, fileSize, uploaderName } = {}) {
  if (!uploaderName || typeof uploaderName !== 'string' || uploaderName.trim().length < 2) {
    return 'uploaderName must be at least 2 characters.';
  }
  if (uploaderName.length > MAX_NAME) {
    return `uploaderName must be under ${MAX_NAME} characters.`;
  }
  if (!fileName || typeof fileName !== 'string' || fileName.trim().length === 0) {
    return 'fileName is required.';
  }
  if (fileName.length > MAX_FILE) {
    return `fileName must be under ${MAX_FILE} characters.`;
  }
  if (typeof fileSize !== 'number' || fileSize <= 0 || fileSize > MAX_SIZE) {
    return `fileSize must be a positive number up to 50 GB.`;
  }
  return null;
}

/**
 * Validate POST /api/notify body.
 * Returns an error string or null if valid.
 */
export function validateNotifyBody({ uploaderName, fileName, fileSize, videoId, notifyEmail } = {}) {
  const initErr = validateInitBody({ fileName, fileSize, uploaderName });
  if (initErr) return initErr;

  if (!videoId || typeof videoId !== 'string' || !/^\d+$/.test(videoId)) {
    return 'videoId must be a numeric string.';
  }
  if (!notifyEmail || !EMAIL_RE.test(notifyEmail)) {
    return 'notifyEmail must be a valid email address.';
  }
  return null;
}
