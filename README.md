# Vimeo Secure Upload — Backend

A lightweight Express server that keeps your Vimeo token and M365 credentials
server-side. The frontend never sees either. Video bytes still go directly from
the browser to Vimeo via TUS — this server handles only metadata and notifications.

---

## Architecture

```
Browser (upload portal)
  │
  ├─ POST /api/init-upload   → server creates Vimeo video, returns upload_url
  │
  ├─ PATCH <upload_url>      → browser sends bytes DIRECTLY to Vimeo (TUS)
  │                            (never touches this server)
  │
  ├─ PUT  /api/add-to-folder → server moves video into your Vimeo folder
  │
  └─ POST /api/notify        → server sends M365 email via Microsoft Graph
```

---

## 1. Install

```bash
npm install
```

---

## 2. Configure

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

### Vimeo
The token and folder ID are pre-filled. If you rotate the token, update `VIMEO_TOKEN`.

### Microsoft 365 — App Registration (one-time setup)

You need to register an app in Azure AD that can send email on behalf of a mailbox.

1. Go to **Azure Portal → Azure Active Directory → App registrations → New registration**
2. Name it something like `Vimeo Upload Notifier`, choose "Single tenant", click Register
3. Note the **Application (client) ID** → paste into `MS_CLIENT_ID`
4. Note the **Directory (tenant) ID** → paste into `MS_TENANT_ID`
5. Go to **Certificates & secrets → New client secret** → copy the value → paste into `MS_CLIENT_SECRET`
6. Go to **API permissions → Add a permission → Microsoft Graph → Application permissions**
   - Add `Mail.Send`
   - Click **Grant admin consent** (requires Global Admin or Privileged Role Admin)
7. Set `MS_SENDER_ADDRESS` to the M365 mailbox you want to send from
   (e.g. `videoteam@yourorg.com`). The mailbox must exist and the app must have
   `Mail.Send` granted — it does not need to be signed in.

---

## 3. Run

```bash
# Development (auto-restarts on file changes, Node 18+)
npm run dev

# Production
npm start
```

---

## 4. Update the frontend

In your upload portal HTML/JS, replace the direct Vimeo API calls with calls to
this backend:

```js
const API = 'https://your-backend-url.com'; // or http://localhost:3001 locally

// Step 1 — init
const { uploadUrl, videoId } = await fetch(`${API}/api/init-upload`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ fileName: file.name, fileSize: file.size, uploaderName: name })
}).then(r => r.json());

// Step 2 — TUS upload (direct to Vimeo, same as before)
await tusUpload(file, uploadUrl, onProgress);

// Step 3 — folder
await fetch(`${API}/api/add-to-folder`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ videoId })
});

// Step 4 — notify
await fetch(`${API}/api/notify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ uploaderName: name, fileName: file.name, fileSize: file.size, videoId, notifyEmail })
});
```

---

## 5. Deploy

Any Node 18+ host works. Recommended options:

| Platform | Notes |
|---|---|
| **Railway** | Connect GitHub repo, set env vars in dashboard, deploy |
| **Render** | Free tier available, set env vars in dashboard |
| **Azure App Service** | Keeps everything in Microsoft ecosystem |
| **AWS Lambda** | Swap `app.listen` for `serverless-http` wrapper |

Remember to set `ALLOWED_ORIGIN` to your frontend's URL in production.

---

## Security notes

- The Vimeo token is scoped to your account — consider creating a dedicated
  Vimeo user with upload-only permissions for production
- Rotate `MS_CLIENT_SECRET` every 12–24 months (set a calendar reminder)
- The `Mail.Send` Graph permission is broad — optionally restrict it to a
  specific mailbox using Exchange application access policies
