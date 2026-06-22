/**
 * mailer.js — Send email via Microsoft Graph API
 *
 * Uses the OAuth 2.0 client credentials flow (app-only auth).
 * No user sign-in required — the app sends on behalf of a shared mailbox.
 *
 * Required env vars:
 *   MS_TENANT_ID       — Azure AD tenant ID
 *   MS_CLIENT_ID       — App registration client ID
 *   MS_CLIENT_SECRET   — App registration client secret
 *   MS_SENDER_ADDRESS  — The mailbox to send from (e.g. videoteam@yourorg.com)
 *                        This mailbox must have "Mail.Send" permission granted.
 */

const GRAPH_API = 'https://graph.microsoft.com/v1.0';

let _tokenCache = null;

/**
 * Get (or refresh) an app-only access token from Azure AD.
 */
async function getAccessToken() {
  const now = Date.now();

  if (_tokenCache && _tokenCache.expiresAt > now + 60_000) {
    return _tokenCache.token;
  }

  const { MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET } = process.env;

  const res = await fetch(
    `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     MS_CLIENT_ID,
        client_secret: MS_CLIENT_SECRET,
        scope:         'https://graph.microsoft.com/.default',
      }),
    }
  );

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Azure token error: ${body.error_description || res.status}`);
  }

  const data = await res.json();
  _tokenCache = {
    token:     data.access_token,
    expiresAt: now + data.expires_in * 1000,
  };

  return _tokenCache.token;
}

/**
 * Format file size for the email body.
 */
function formatBytes(bytes) {
  if (bytes < 1024 * 1024)       return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3)         return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Send an upload notification email.
 *
 * @param {{
 *   uploaderName: string,
 *   fileName:     string,
 *   fileSize:     number,
 *   videoId:      string,
 *   notifyEmail:  string
 * }} params
 */
export async function sendNotification({ uploaderName, fileName, fileSize, videoId, notifyEmail }) {
  const token      = await getAccessToken();
  const sender     = process.env.MS_SENDER_ADDRESS;
  const vimeoUrl   = `https://vimeo.com/${videoId}`;
  const uploadedAt = new Date().toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' });

  const htmlBody = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; background: #f5f5f5; margin: 0; padding: 32px 16px; }
    .card { background: #ffffff; border-radius: 8px; max-width: 520px; margin: 0 auto; overflow: hidden; }
    .header { background: #141A20; padding: 24px 28px; }
    .header-title { color: #17D5FF; font-size: 13px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; margin: 0 0 4px; }
    .header-sub { color: rgba(250,252,253,0.5); font-size: 13px; margin: 0; }
    .body { padding: 24px 28px; }
    .row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #f0f0f0; font-size: 14px; }
    .row:last-child { border-bottom: none; }
    .label { color: #888; }
    .value { color: #111; font-weight: 500; text-align: right; max-width: 60%; word-break: break-word; }
    .cta { display: block; margin: 20px 0 0; background: #17D5FF; color: #141A20; text-decoration: none; font-weight: 600; font-size: 14px; text-align: center; padding: 12px 20px; border-radius: 6px; }
    .footer { padding: 16px 28px; background: #fafafa; border-top: 1px solid #f0f0f0; font-size: 12px; color: #aaa; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <p class="header-title">New video upload</p>
      <p class="header-sub">Someone submitted a video via the secure upload portal.</p>
    </div>
    <div class="body">
      <div class="row"><span class="label">Uploaded by</span><span class="value">${uploaderName}</span></div>
      <div class="row"><span class="label">File name</span><span class="value">${fileName}</span></div>
      <div class="row"><span class="label">File size</span><span class="value">${formatBytes(fileSize)}</span></div>
      <div class="row"><span class="label">Uploaded at</span><span class="value">${uploadedAt}</span></div>
      <div class="row"><span class="label">Vimeo folder</span><span class="value">Videos uploaded by others</span></div>
      <a class="cta" href="${vimeoUrl}">View on Vimeo →</a>
    </div>
    <div class="footer">This notification was sent automatically by the Vimeo secure upload portal.</div>
  </div>
</body>
</html>`;

  const message = {
    subject: `New upload: ${fileName} — from ${uploaderName}`,
    body: { contentType: 'HTML', content: htmlBody },
    toRecipients: [{ emailAddress: { address: notifyEmail } }],
  };

  const res = await fetch(`${GRAPH_API}/users/${sender}/sendMail`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ message, saveToSentItems: true }),
  });

  if (!res.ok && res.status !== 202) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error?.message || `Graph sendMail ${res.status}`);
  }
}
