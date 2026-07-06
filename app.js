(function () {
  // ── Config ──────────────────────────────────────────────────────────────────
  // Point this at your deployed backend. In local dev: http://localhost:3001
  const API          = 'http://localhost:3001';
  const CHUNK_SIZE   = 128 * 1024 * 1024; // 128 MB TUS chunks
  const RESUME_KEY   = 'vimeo_resume_uploads_v1';

  function formatBytes(b) {
    if (b < 1048576)    return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }

  // ── Resumable-upload state (localStorage) ────────────────────────────────────
  // We persist enough to RESUME an interrupted TUS upload. The file itself cannot
  // be stored (browsers don't allow it), so the user must re-select the same file;
  // we verify by name + size before continuing so we never send mismatched bytes.
  function fileKey(name, size) { return name + ':' + size; }

  function loadResumables() {
    try { return JSON.parse(localStorage.getItem(RESUME_KEY)) || {}; } catch (e) { return {}; }
  }
  function writeResumables(all) {
    try { localStorage.setItem(RESUME_KEY, JSON.stringify(all)); } catch (e) {}
  }
  function saveResumable(entry)               { const all = loadResumables(); all[entry.key] = entry; writeResumables(all); }
  function updateResumableProgress(key, bytes){ const all = loadResumables(); if (all[key]) { all[key].bytesUploaded = bytes; writeResumables(all); } }
  function clearResumable(key)                { const all = loadResumables(); delete all[key]; writeResumables(all); }

  // Ask Vimeo for the authoritative byte offset of an in-progress TUS upload.
  // Throws if the upload link is gone/expired (Vimeo keeps them only briefly).
  async function tusOffset(uploadUrl) {
    const res = await fetch(uploadUrl, { method: 'HEAD', headers: { 'Tus-Resumable': '1.0.0' } });
    if (!res.ok) throw new Error('stale-upload-link');
    return parseInt(res.headers.get('Upload-Offset') || '0', 10);
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let S = {
    file: null, name: '', notifyEmail: '', agreed: false,
    phase: 'idle', // idle | creating | uploading | adding | notifying | done | error
    progress: 0, uploaded: 0,
    videoId: null, uploadUrl: null, error: null, resumeError: null
  };

  function canSubmit() {
    return S.file && S.name.trim().length >= 2 && S.agreed;
  }

  // ── API calls ──────────────────────────────────────────────────────────────
  async function apiPost(path, body) {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
    return data;
  }

  async function tusUpload(file, uploadUrl, onProgress, startOffset = 0) {
    let offset = startOffset;
    while (offset < file.size) {
      const chunk = file.slice(offset, offset + CHUNK_SIZE);
      const res = await fetch(uploadUrl, {
        method: 'PATCH',
        headers: {
          'Tus-Resumable':  '1.0.0',
          'Upload-Offset':  String(offset),
          'Content-Type':   'application/offset+octet-stream',
          'Content-Length': String(chunk.size)
        },
        body: chunk
      });
      if (!res.ok) throw new Error(`Upload chunk failed at byte ${offset}: ${res.status}`);
      offset = parseInt(res.headers.get('Upload-Offset') || '0', 10);
      onProgress(offset, file.size);
    }
  }

  // ── Upload flow ────────────────────────────────────────────────────────────
  async function startUpload() {
    S.phase = 'creating'; S.error = null;
    render();

    // If this exact file already has an in-progress upload (e.g. a retry after an
    // error, or a duplicate click), resume it instead of creating a second video.
    const existing = loadResumables()[fileKey(S.file.name, S.file.size)];
    if (existing) { await runUpload(existing, S.file); return; }

    try {
      // Create the video on Vimeo (via backend — token stays server-side)
      const init = await apiPost('/api/init-upload', {
        fileName:     S.file.name,
        fileSize:     S.file.size,
        uploaderName: S.name
      });
      const entry = {
        key:              fileKey(S.file.name, S.file.size),
        videoId:          init.videoId,
        uploadUrl:        init.uploadUrl,
        fileName:         S.file.name,
        fileSize:         S.file.size,
        fileLastModified: S.file.lastModified,
        uploaderName:     S.name,
        notifyEmail:      S.notifyEmail,
        bytesUploaded:    0,
        createdAt:        Date.now()
      };
      saveResumable(entry); // persisted BEFORE bytes move, so an interruption is resumable
      await runUpload(entry, S.file);
    } catch (e) {
      S.phase = 'error'; S.error = e.message;
      render();
    }
  }

  // Resume (or start) the byte transfer for a saved entry, then finish the flow.
  // The entry is LEFT in localStorage on interruption (so it can be resumed) and
  // cleared only on success or when Vimeo confirms the upload link is dead.
  async function runUpload(entry, file) {
    S.videoId = entry.videoId; S.uploadUrl = entry.uploadUrl;
    S.name = entry.uploaderName; S.notifyEmail = entry.notifyEmail || ''; S.file = file;

    try {
      // Authoritative offset from Vimeo — 0 for a fresh upload, and it validates the link.
      let startOffset;
      try {
        startOffset = await tusOffset(entry.uploadUrl);
      } catch (e) {
        clearResumable(entry.key);
        throw new Error('This upload link has expired — please start the upload again.');
      }

      S.phase = 'uploading';
      S.uploaded = startOffset;
      S.progress = Math.round((startOffset / file.size) * 100);
      render();

      await tusUpload(file, entry.uploadUrl, (uploaded, total) => {
        S.uploaded = uploaded;
        S.progress = Math.round((uploaded / total) * 100);
        updateResumableProgress(entry.key, uploaded);
        const fill = document.getElementById('prog-fill');
        const pct  = document.getElementById('prog-pct');
        const det  = document.getElementById('prog-detail');
        if (fill) fill.style.width = S.progress + '%';
        if (pct)  pct.textContent  = S.progress + '%';
        if (det)  det.textContent  = `${formatBytes(uploaded)} of ${formatBytes(total)}`;
      }, startOffset);

      // The video was placed in the folder at creation (folder_uri), so no move step.
      if ((entry.notifyEmail || '').trim()) {
        S.phase = 'notifying';
        render();
        await apiPost('/api/notify', {
          uploaderName: entry.uploaderName,
          fileName:     entry.fileName,
          fileSize:     entry.fileSize,
          videoId:      entry.videoId,
          notifyEmail:  entry.notifyEmail.trim()
        });
      }

      clearResumable(entry.key); // success — no longer resumable
      S.phase = 'done';
      render();

    } catch (e) {
      // Entry is intentionally kept (unless cleared above) so the user can resume.
      S.phase = 'error'; S.error = e.message;
      render();
    }
  }

  // Called when the user re-selects a file to resume a saved upload.
  function resumeWithFile(entry, file) {
    if (file.name !== entry.fileName || file.size !== entry.fileSize) {
      S.resumeError = `That file doesn’t match the unfinished upload. Expected “${entry.fileName}” (${formatBytes(entry.fileSize)}).`;
      render();
      return;
    }
    S.resumeError = null;
    runUpload(entry, file);
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function render() {
    const body = document.getElementById('portal-body');
    if      (S.phase === 'done')                           renderSuccess(body);
    else if (S.phase === 'uploading')                      renderUploading(body);
    else if (['creating','notifying'].includes(S.phase)) renderWorking(body);
    else                                                   renderForm(body);
  }

  function renderForm(body) {
    const resumables = Object.values(loadResumables());
    const resumeHTML = resumables.map((e, i) => {
      const pct = Math.round((e.bytesUploaded / e.fileSize) * 100) || 0;
      return `
        <div class="resume-card">
          <i class="ti ti-refresh"></i>
          <div class="resume-info">
            <div class="resume-title">${e.fileName}</div>
            <div class="resume-sub">Unfinished upload — ${pct}% done. Re-select this file to resume.</div>
          </div>
          <div class="resume-actions">
            <label class="resume-btn primary">Resume<input type="file" accept="video/*" data-resume-index="${i}" /></label>
            <button class="resume-btn ghost" data-discard-index="${i}">Discard</button>
          </div>
        </div>`;
    }).join('') + (S.resumeError ? `<p class="resume-err"><i class="ti ti-alert-circle" style="vertical-align:-2px;margin-right:4px"></i>${S.resumeError}</p>` : '');

    body.innerHTML = `
      ${resumeHTML}
      <p class="section-label">Secure video submission</p>
      <h1 class="section-title">Upload your video</h1>

      <div class="config-panel">
        <div class="config-header"><i class="ti ti-shield-check" style="font-size:12px;vertical-align:-1px;margin-right:5px"></i>Portal configuration</div>
        <div class="config-row"><span class="config-key">Destination folder</span><span class="config-val"><i class="ti ti-folder" style="font-size:13px;vertical-align:-1px;margin-right:4px"></i>Videos uploaded by others</span></div>
        <div class="config-row"><span class="config-key">Access</span><span class="config-val"><i class="ti ti-upload" style="font-size:13px;vertical-align:-1px;margin-right:4px"></i>Upload only</span></div>
        <div class="config-row"><span class="config-key">Video privacy</span><span class="config-val"><i class="ti ti-lock" style="font-size:13px;vertical-align:-1px;margin-right:4px"></i>Private (team only)</span></div>
      </div>

      <div class="field">
        <label for="uploader-name">Your name <span style="color:#17D5FF">*</span></label>
        <input type="text" id="uploader-name" placeholder="e.g. Alex Johnson" value="${S.name}" maxlength="80" autocomplete="name" />
      </div>

      <div class="field">
        <label for="notify-email">
          <i class="ti ti-bell" style="font-size:13px;vertical-align:-1px;margin-right:4px"></i>
          Notify email address
          <span style="color:rgba(250,252,253,0.35);font-weight:400;margin-left:4px;">(optional — who should be notified on upload?)</span>
        </label>
        <input type="email" id="notify-email" placeholder="e.g. videoteam@yourorg.com" value="${S.notifyEmail}" maxlength="200" autocomplete="email" />
      </div>

      ${S.file ? `
        <div class="file-queued">
          <i class="ti ti-video file-icon"></i>
          <div class="file-info">
            <div class="file-name">${S.file.name}</div>
            <div class="file-size">${formatBytes(S.file.size)}</div>
          </div>
          <i class="ti ti-x file-remove" id="remove-file" title="Remove" aria-label="Remove file"></i>
        </div>
      ` : `
        <div class="drop-zone" id="drop-zone">
          <input type="file" accept="video/*" id="file-input" aria-label="Choose video file" />
          <div class="drop-icon"><i class="ti ti-cloud-upload"></i></div>
          <p class="drop-primary">Drop your video here</p>
          <p class="drop-sub">or <span>browse files</span> — MP4, MOV, AVI, MKV and more</p>
        </div>
      `}

      <div class="tc-box">
        <div class="tc-scroll">
          <strong style="color:rgba(250,252,253,0.6);font-weight:500;">Terms &amp; Conditions</strong><br><br>
          By uploading content to this portal you confirm that: (1) you are authorised to share this material with the video team; (2) the content does not include personally identifiable information beyond what is required for this submission; (3) the file will be stored securely on Vimeo's infrastructure and accessible only to designated team members; (4) you accept that uploaded content may be processed, edited, or published in line with your organisation's video production guidelines; (5) you will not upload material that infringes copyright, contains confidential client data without consent, or violates applicable law. Uploads are logged with your name, timestamp, and file name for audit purposes.
        </div>
        <label class="tc-agree">
          <input type="checkbox" id="tc-check" ${S.agreed ? 'checked' : ''} />
          <span class="tc-agree-text">I have read and agree to the terms above</span>
        </label>
      </div>

      ${S.phase === 'error' ? `<p class="error-msg"><i class="ti ti-alert-circle" style="vertical-align:-2px;margin-right:5px"></i>${S.error}</p>` : ''}

      <div class="form-note">
        <div><i class="ti ti-refresh"></i>If your upload is interrupted, reopen this page and re-select the same file to resume it.</div>
        <div><i class="ti ti-mail"></i>Any notification email is sent only once the video has finished processing on Vimeo.</div>
      </div>

      <button class="upload-btn" id="upload-btn" ${canSubmit() ? '' : 'disabled'}>
        <i class="ti ti-upload" style="font-size:15px;vertical-align:-2px;margin-right:7px"></i>Upload to Vimeo
      </button>
      <p class="notice">Files are sent directly to Vimeo over TLS. No data passes through third-party servers.</p>
    `;

    // Resume banners: re-select the matching file to continue, or discard.
    resumables.forEach(function (entry, i) {
      const inp = body.querySelector('input[data-resume-index="' + i + '"]');
      if (inp) inp.addEventListener('change', function (e) {
        if (e.target.files[0]) resumeWithFile(entry, e.target.files[0]);
      });
      const del = body.querySelector('button[data-discard-index="' + i + '"]');
      if (del) del.addEventListener('click', function () { clearResumable(entry.key); S.resumeError = null; render(); });
    });

    document.getElementById('uploader-name').addEventListener('input', function (e) {
      S.name = e.target.value;
      document.getElementById('upload-btn').disabled = !canSubmit();
    });

    document.getElementById('notify-email').addEventListener('input', function (e) {
      S.notifyEmail = e.target.value;
    });

    const tc = document.getElementById('tc-check');
    if (tc) tc.addEventListener('change', function (e) {
      S.agreed = e.target.checked;
      document.getElementById('upload-btn').disabled = !canSubmit();
    });

    const dz = document.getElementById('drop-zone');
    const fi = document.getElementById('file-input');
    if (dz && fi) {
      dz.addEventListener('dragover',  function (e) { e.preventDefault(); dz.classList.add('drag-over'); });
      dz.addEventListener('dragleave', function ()  { dz.classList.remove('drag-over'); });
      dz.addEventListener('drop', function (e) {
        e.preventDefault(); dz.classList.remove('drag-over');
        const f = e.dataTransfer.files[0];
        if (f && f.type.startsWith('video/')) { S.file = f; render(); }
      });
      fi.addEventListener('change', function (e) {
        if (e.target.files[0]) { S.file = e.target.files[0]; render(); }
      });
    }

    const rm = document.getElementById('remove-file');
    if (rm) rm.addEventListener('click', function () { S.file = null; render(); });

    document.getElementById('upload-btn').addEventListener('click', function () {
      if (canSubmit()) startUpload();
    });
  }

  const PHASE_LABELS = {
    creating:  { label: 'Preparing upload', sub: 'Creating video record on Vimeo…' },
    notifying: { label: 'Scheduling notification', sub: 'Email will be sent once the video is ready…' }
  };

  function renderWorking(body) {
    const { label, sub } = PHASE_LABELS[S.phase] || {};
    body.innerHTML = `
      <p class="section-label">${label}</p>
      <h2 class="section-title" style="font-size:16px;">${sub}</h2>
      <div class="uploading-file">
        <div class="upload-spinner"></div>
        <div class="file-info">
          <div class="file-name">${S.file.name}</div>
          <div class="file-size">${formatBytes(S.file.size)}</div>
        </div>
      </div>
    `;
  }

  function renderUploading(body) {
    body.innerHTML = `
      <p class="section-label">Uploading</p>
      <h2 class="section-title" style="font-size:16px;">Sending to Vimeo…</h2>
      <div class="uploading-file">
        <div class="upload-spinner"></div>
        <div class="file-info">
          <div class="file-name">${S.file.name}</div>
          <div class="file-size">${formatBytes(S.file.size)}</div>
        </div>
      </div>
      <div class="progress-wrap">
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" id="prog-fill" style="width:${S.progress}%"></div>
        </div>
        <div class="progress-labels">
          <span>Progress</span>
          <span id="prog-pct">${S.progress}%</span>
        </div>
        <p class="progress-detail" id="prog-detail">${formatBytes(S.uploaded)} of ${formatBytes(S.file.size)}</p>
      </div>
      <p class="notice">Do not close this tab while uploading.</p>
    `;
  }

  function renderSuccess(body) {
    const vimeoUrl = `https://vimeo.com/${S.videoId}`;
    body.innerHTML = `
      <div class="success-state">
        <div class="success-icon"><i class="ti ti-check"></i></div>
        <p class="success-title">Upload complete</p>
        <p class="success-sub">
          <strong style="color:#FAFCFD;font-weight:500;">${S.file.name}</strong> has been delivered<br>
          to <em style="color:#17D5FF;">Videos uploaded by others</em>.<br>
          <span style="opacity:0.6;">Submitted by ${S.name}.</span>
          ${S.notifyEmail ? `<br><span style="opacity:0.5;font-size:12px;"><i class="ti ti-mail" style="vertical-align:-1px;margin-right:3px"></i>${S.notifyEmail} will be emailed once the video finishes processing</span>` : ''}
        </p>
        <a class="vimeo-link" href="${vimeoUrl}" target="_blank" rel="noopener">
          <i class="ti ti-external-link" style="font-size:14px"></i>View on Vimeo
        </a><br>
        <button class="upload-another" id="upload-another">Upload another video</button>
      </div>
    `;
    document.getElementById('upload-another').addEventListener('click', function () {
      S = { file: null, name: S.name, notifyEmail: S.notifyEmail, agreed: false, phase: 'idle', progress: 0, uploaded: 0, videoId: null, uploadUrl: null, error: null, resumeError: null };
      render();
    });
  }

  render();
})();
