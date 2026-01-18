 const BOTTOM_BANNER_ID = 'bmad-recorder-bottom-banner';
const BOTTOM_STATUS_SPAN = 'bmad-recorder-bottom-status';
const BOTTOM_TIMER_SPAN = 'bmad-recorder-bottom-timer';
const INSTRUCTION_TEXT = 'Press Alt+Shift+R or click extension icon to start recording';
const PERMISSION_MESSAGE = 'Please allow microphone access to record.';
const UNMUTE_MESSAGE = 'Unmute your microphone to start recording';
const BACKEND_BASE_URL = 'http://localhost:8080';
let isRecording = false;
let startTime = null;
let timerInterval = null;
let pausedSeconds = 0;
let toastTimeout = null;
let bottomBanner = null;
let bottomStatusEl = null;
let bottomTimerEl = null;
let bottomStopButton = null;
let micMonitorInterval = null;
let micWasMuted = false;
let meetingEndNotified = false;
let meetingWasActive = false;
let stopRequested = false;
let permissionWarningShown = false;
let unmuteWarningShown = false;
let sessionCard = null;
let sessionCardStylesInjected = false;
let sessionCardTimeout = null;
let currentParentSessionId = null; // Stores the ID if user says "Yes" to continuation
const LAST_MEETING_META_KEY = 'bmad-last-meeting-meta';
let shouldPromptForMeetingNameAfterStop = false;
let preRecordingContinuationPromptShownForSession = false;
let preRecordingContinuationModalElement = null;
let preRecordingContinuationConfirmed = false;
let currentMeetingNameCandidate = null;
let lastMeetingMeta = null; // Cached metadata from the last named meeting

function ensureBottomBanner() {
  if (bottomBanner) return;
  bottomBanner = document.createElement('div');
  bottomBanner.id = BOTTOM_BANNER_ID;
  bottomBanner.style.position = 'fixed';
  bottomBanner.style.bottom = '80px';
  bottomBanner.style.left = '18px';
  bottomBanner.style.transform = 'translateX(0)';
  bottomBanner.style.zIndex = '10000';
  bottomBanner.style.background = '#111';
  bottomBanner.style.color = '#fff';
  bottomBanner.style.padding = '10px 18px';
  bottomBanner.style.borderRadius = '999px';
  bottomBanner.style.fontFamily = 'system-ui, sans-serif';
  bottomBanner.style.fontSize = '13px';
  bottomBanner.style.display = 'flex';
  bottomBanner.style.alignItems = 'center';
  bottomBanner.style.gap = '8px';
  bottomBanner.style.boxShadow = '0 10px 24px rgba(0, 0, 0, 0.35)';

  bottomStatusEl = document.createElement('span');
  bottomStatusEl.id = BOTTOM_STATUS_SPAN;

  bottomTimerEl = document.createElement('span');
  bottomTimerEl.id = BOTTOM_TIMER_SPAN;
  bottomTimerEl.style.fontWeight = '600';

  bottomStopButton = document.createElement('button');
  bottomStopButton.id = 'bmad-recorder-stop-btn';
  bottomStopButton.textContent = 'Stop';
  bottomStopButton.style.cursor = 'pointer';
  bottomStopButton.style.background = '#ef4444';
  bottomStopButton.style.color = '#fff';
  bottomStopButton.style.border = 'none';
  bottomStopButton.style.borderRadius = '999px';
  bottomStopButton.style.padding = '6px 12px';
  bottomStopButton.style.fontSize = '12px';
  bottomStopButton.style.fontWeight = '600';
  bottomStopButton.style.display = 'none';
  bottomStopButton.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.25)';
  bottomStopButton.addEventListener('click', () => {
    if (!isRecording) return;
    requestStopRecording('user', null, currentParentSessionId);
  });

  bottomBanner.appendChild(bottomStatusEl);
  bottomBanner.appendChild(bottomTimerEl);
  bottomBanner.appendChild(bottomStopButton);
  document.body.appendChild(bottomBanner);
}

function setBottomMessage(status, timer = '') {
  ensureBottomBanner();
  bottomStatusEl.textContent = status;
  bottomTimerEl.textContent = timer;
}

function showStopButton() {
  if (!bottomStopButton) return;
  bottomStopButton.style.display = 'inline-flex';
}

function hideStopButton() {
  if (!bottomStopButton) return;
  bottomStopButton.style.display = 'none';
  bottomStopButton.disabled = false;
}

function showInstruction() {
  hideStopButton();
  setBottomMessage(INSTRUCTION_TEXT, '');
}

function showPermissionWarning() {
  if (permissionWarningShown) return;
  permissionWarningShown = true;
  unmuteWarningShown = false;
  hideStopButton();
  setBottomMessage(PERMISSION_MESSAGE, '');
}

function showUnmuteWarning(timer = '') {
  if (unmuteWarningShown) return;
  unmuteWarningShown = true;
  hideStopButton();
  setBottomMessage(UNMUTE_MESSAGE, timer);
}

function resetTimerDisplay() {
  if (bottomTimerEl) bottomTimerEl.textContent = '00:00';
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  startTime = null;
  pausedSeconds = 0;
}

function formatElapsed(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const mins = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const secs = String(totalSeconds % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}

function currentElapsedSeconds() {
  const running = startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;
  return pausedSeconds + running;
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  meetingEndNotified = false;
  pausedSeconds = 0;
  startTime = Date.now();
  permissionWarningShown = false;
  unmuteWarningShown = false;
  currentParentSessionId = null; // Reset for new recording
  shouldPromptForMeetingNameAfterStop = true;
  preRecordingContinuationPromptShownForSession = false;
  preRecordingContinuationConfirmed = false;
  currentMeetingNameCandidate = null;
  closePreRecordingContinuationModal();
  hideSessionCard();
  setBottomMessage('Recording', '00:00');
  timerInterval = setInterval(() => {
    if (!isRecording) return;
    const timerText = formatElapsed(currentElapsedSeconds() * 1000);
    setBottomMessage('Recording', timerText);
  }, 1000);
  startMicMonitor();
  showStopButton();
  const prePromptShown = maybeShowPreRecordingContinuationPrompt();
  if (!prePromptShown) {
    checkContinuation(); // Ask user if this is a continuation
  }
}

function pauseTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  pausedSeconds = currentElapsedSeconds();
  startTime = null;
}

function resumeTimer() {
  if (timerInterval) return;
  startTime = Date.now();
  timerInterval = setInterval(() => {
    if (!isRecording) return;
    const timerText = formatElapsed(currentElapsedSeconds() * 1000);
    setBottomMessage('Recording', timerText);
  }, 1000);
}

function stopTimer(message = 'Upload complete') {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  stopMicMonitor();
  setBottomMessage(message, '');
  hideStopButton();
  startTime = null;
  pausedSeconds = 0;
  micWasMuted = false;
}

function resetStopGuard() {
  stopRequested = false;
  if (bottomStopButton) {
    bottomStopButton.disabled = false;
  }
}

function requestStopRecording(reason, meetingName = null, parentSessionId = null) {
  if (stopRequested) return;
  stopRequested = true;
  if (bottomStopButton) bottomStopButton.disabled = true;
  chrome.runtime.sendMessage({ type: 'STOP_RECORDING', reason: reason || 'auto', parentSessionId: parentSessionId || currentParentSessionId, meetingName });
}

function showToast(text) {
  let toast = document.getElementById('bmad-recorder-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'bmad-recorder-toast';
    toast.style.position = 'fixed';
    toast.style.left = '12px';
    toast.style.bottom = '12px';
    toast.style.background = '#111';
    toast.style.color = '#fff';
    toast.style.padding = '8px 12px';
    toast.style.borderRadius = '8px';
    toast.style.fontFamily = 'system-ui, sans-serif';
    toast.style.zIndex = '10000';
    toast.style.boxShadow = '0 6px 16px rgba(0, 0, 0, 0.35)';
    document.body.appendChild(toast);
  }

  toast.textContent = text;
  toast.style.display = 'block';
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.style.display = 'none';
  }, 4000);
}

function isMeetMicMuted() {
  const micButton = document.querySelector('button[aria-label*="microphone" i], [data-tooltip*="microphone" i]');
  if (!micButton) return { muted: false, found: false };
  const label = [
    micButton.getAttribute('aria-label'),
    micButton.getAttribute('data-tooltip'),
    micButton.textContent
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (label.includes('turn on microphone')) return { muted: true, found: true };
  if (label.includes('turn off microphone')) return { muted: false, found: true };
  return { muted: false, found: false };
}

function startMicMonitor() {
  if (micMonitorInterval) return;
  micMonitorInterval = setInterval(() => {
    if (!isRecording) return;
    const { muted, found } = isMeetMicMuted();
    if (found && muted) {
      micWasMuted = true;
      pauseTimer();
      showUnmuteWarning(formatElapsed(currentElapsedSeconds() * 1000));
    } else if (found && !muted && micWasMuted) {
      micWasMuted = false;
      resumeTimer();
      }
  }, 1500);
}

function stopMicMonitor() {
  if (micMonitorInterval) {
    clearInterval(micMonitorInterval);
    micMonitorInterval = null;
  }
}

async function getMicPermissionState() {
  if (!navigator.permissions || typeof navigator.permissions.query !== 'function') return 'prompt';
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    return status.state || 'prompt';
  } catch (error) {
    console.error('Permission query failed:', error);
    return 'prompt';
  }
}

async function getMicStatus() {
  const permission = await getMicPermissionState();
  const { muted, found } = isMeetMicMuted();
  return { permission, muted, found };
}

const MEETING_PATH_REGEX = /^\/[^?\/]+-[^?\/]+-[^?\/]+/i;

function isMeetingPath() {
  const path = window.location.pathname.split('?')[0];
  return MEETING_PATH_REGEX.test(path);
}

function checkMeetingEnd() {
  // Only stop recording when user explicitly leaves the meeting page or closes tab
  // Don't trigger on DOM changes (too unreliable)
  // Switching tabs or sharing screen does NOT count as leaving (URL stays meet.google.com)
  
  const urlActive = /meet\.google\.com/.test(window.location.href);
  const leftMeetingScreen = /you'?ve left the meeting|return to home screen/i.test(document.body.innerText);
  const meetingPathActive = isMeetingPath();

  if (meetingPathActive && urlActive) {
    meetingWasActive = true;
  }

  // Only consider meeting "left" if:
  // 1. We were in a meeting AND
  // 2. (URL changed away from meet.google.com OR "left the meeting" message appears)
  // Note: Tab switching or screen sharing don't change the URL, so recording continues
  const hasLeft = meetingWasActive && (!urlActive || leftMeetingScreen);

  if (isRecording && hasLeft && !meetingEndNotified) {
    meetingEndNotified = true;
    requestStopRecording('meeting_ended');
  }

  if (!hasLeft) {
    meetingEndNotified = false;
    if (!urlActive) {
      meetingWasActive = false;
    }
  }
}

const leaveObserver = new MutationObserver(() => {
  checkMeetingEnd();
});

function initMeetingWatcher() {
  leaveObserver.observe(document.body, { childList: true, subtree: true });
  setInterval(checkMeetingEnd, 2000);
}

async function promptForMeetingName() {
  injectSessionCardStyles();
  const modal = document.createElement('div');
  modal.id = 'bmad-name-modal';
  modal.style.cssText = `
    position: fixed; bottom: 140px; left: 18px; width: 300px;
    background: #0f172a; color: #fff; padding: 16px; border-radius: 12px;
    box-shadow: 0 10px 25px rgba(0,0,0,0.5); z-index: 10002; font-family: system-ui;
    border: 1px solid rgba(255,255,255,0.1); display: flex; flex-direction: column; gap: 10px;
  `;
  
  modal.innerHTML = `
    <div style="font-weight:600; font-size:14px;">Name this meeting</div>
    <input type="text" id="bmad-meeting-name" placeholder="e.g. Snaphomz" style="
      background: #1e293b; border: 1px solid #334155; color: white; 
      padding: 8px; border-radius: 6px; outline: none;
    " />
    <div style="display:flex; gap:8px; justify-content: flex-end;">
      <button id="bmad-name-save" style="background:#22c55e; color:#0f172a; border:none; padding:6px 12px; border-radius:6px; cursor:pointer; font-weight:600;">Save & Stop</button>
    </div>
  `;
  
  document.body.appendChild(modal);
  const input = document.getElementById('bmad-meeting-name');
  input.focus();

  document.getElementById('bmad-name-save').onclick = async () => {
    const name = input.value.trim();
    currentMeetingNameCandidate = name || null;
    if (!name) {
      modal.remove();
      requestStopRecording('user'); // No name provided
      return;
    }

    modal.remove();

    const storedMeta = loadLastMeetingMeta();
    lastMeetingMeta = storedMeta;

    if (preRecordingContinuationConfirmed && storedMeta?.sessionId) {
      preRecordingContinuationConfirmed = false;
      requestStopRecording('user', name, storedMeta.sessionId);
      return;
    }

    // Check if name exists
    try {
      const res = await fetch(`${BACKEND_BASE_URL}/api/meetings/check-name?name=${encodeURIComponent(name)}`);
      const data = await res.json();
      
      if (data.exists) {
        promptContinuation(name, data.lastSessionId);
      } else {
        requestStopRecording('user', name, null);
      }
    } catch (e) {
      console.error("Name check failed", e);
      requestStopRecording('user', name, null);
    }
  };
  
  // Allow Enter key to submit
  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') document.getElementById('bmad-name-save').click();
  });
}

function promptContinuation(name, lastSessionId) {
  const modal = document.createElement('div');
  modal.id = 'bmad-continuation-confirm';
  modal.style.cssText = `
    position: fixed; bottom: 140px; left: 18px; width: 300px;
    background: #0f172a; color: #fff; padding: 16px; border-radius: 12px;
    box-shadow: 0 10px 25px rgba(0,0,0,0.5); z-index: 10002; font-family: system-ui;
    border: 1px solid rgba(255,255,255,0.1);
  `;
  
  modal.innerHTML = `
    <div style="font-weight:600; margin-bottom:8px; font-size:14px;">Meeting exists: "${name}"</div>
    <div style="font-size:12px; color:#94a3b8; margin-bottom:12px;">
      Is this a continuation of the previous session?
    </div>
    <div style="display:flex; gap:8px;">
      <button id="btn-cont-yes-final" style="flex:1; background:#22c55e; border:none; padding:6px; border-radius:6px; cursor:pointer; font-weight:600;">Yes</button>
      <button id="btn-cont-no-final" style="flex:1; background:#334155; color:#fff; border:none; padding:6px; border-radius:6px; cursor:pointer;">No</button>
    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById('btn-cont-yes-final').onclick = () => {
    modal.remove();
    requestStopRecording('user', name, lastSessionId);
  };
  
  document.getElementById('btn-cont-no-final').onclick = () => {
    modal.remove();
    requestStopRecording('user', name, null); // Same name, but new thread (no parent)
  };
}

function injectSessionCardStyles() {
  if (sessionCardStylesInjected) return;
  sessionCardStylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    #bmad-recorder-share-card {
      position: fixed;
      bottom: 120px;
      left: 16px;
      width: 260px;
      background: #0f172a;
      color: #f8fafc;
      border-radius: 14px;
      padding: 14px;
      box-shadow: 0 20px 30px rgba(15, 23, 42, 0.65);
      font-family: system-ui, sans-serif;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    #bmad-recorder-share-card header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-weight: 600;
    }
    #bmad-recorder-share-card header button {
      background: transparent;
      border: none;
      color: #94a3b8;
      font-size: 16px;
      cursor: pointer;
    }
    #bmad-recorder-share-card .bmad-card-link {
      background: #0c111e;
      border-radius: 8px;
      padding: 10px;
      font-size: 12px;
      word-break: break-word;
      user-select: all;
    }
    #bmad-recorder-share-card .bmad-card-actions {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    #bmad-recorder-share-card button.bmad-link-btn {
      border: none;
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s ease;
    }
    #bmad-recorder-share-card button[data-variant="primary"] {
      background: #22d3ee;
      color: #0f172a;
    }
    #bmad-recorder-share-card button[data-variant="secondary"] {
      background: #1d4ed8;
      color: #fff;
    }
    #bmad-recorder-share-card .bmad-card-caption {
      font-size: 11px;
      color: #94a3b8;
    }
    /* Continuation Modal Styles */
    #bmad-continuation-modal {
      position: fixed; bottom: 140px; left: 18px; width: 300px;
      background: #0f172a; color: #fff; padding: 16px; border-radius: 12px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.5); z-index: 10001; font-family: system-ui;
      border: 1px solid rgba(255,255,255,0.1);
    }
  `;
  document.head.appendChild(style);
}

function hideSessionCard() {
  if (sessionCard) {
    sessionCard.remove();
    sessionCard = null;
  }
  if (sessionCardTimeout) {
    clearTimeout(sessionCardTimeout);
    sessionCardTimeout = null;
  }
}

function showSessionCard(sessionId) {
  console.log('showSessionCard triggered for', sessionId);
  injectSessionCardStyles();
  hideSessionCard();
  const shareUrl = `${BACKEND_BASE_URL}/api/sessions/${sessionId}`;
  const sharePage = `http://localhost:3000/session/${sessionId}`;
  const recordingUrl = `${BACKEND_BASE_URL}/recordings/${sessionId}`;
  const summaryUrl = `${BACKEND_BASE_URL}/summaries/${sessionId}`;
  sessionCard = document.createElement('div');
  sessionCard.id = 'bmad-recorder-share-card';
  sessionCard.innerHTML = `
    <header>
      <span>Meeting ended</span>
      <button aria-label="Close share card">&times;</button>
    </header>
    <div class="bmad-card-caption">Anyone with the link can view</div>
    <div class="bmad-card-link" data-role="share-link">${shareUrl}</div>
    <div class="bmad-card-actions">
      <button class="bmad-link-btn" data-variant="primary" data-action="copy-share">Copy share link</button>
      <button class="bmad-link-btn" data-variant="secondary" data-action="view-session">View recording & summary</button>
      <button class="bmad-link-btn" data-variant="secondary" data-action="open-recording">Download recording</button>
      <button class="bmad-link-btn" data-variant="secondary" data-action="open-summary">View summary</button>
    </div>
  `;
  document.body.appendChild(sessionCard);
  sessionCard.querySelector('button[aria-label]').addEventListener('click', hideSessionCard);
  sessionCard.querySelector('[data-action="copy-share"]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      showToast('Share link copied.');
    } catch (err) {
      console.error('Clipboard copy failed:', err);
      showToast('Copy failed. Please copy manually.');
    }
  });
  sessionCard.querySelector('[data-action="view-session"]').addEventListener('click', () => {
    window.open(sharePage, '_blank');
  });
  sessionCard.querySelector('[data-action="open-recording"]').addEventListener('click', () => {
    window.open(recordingUrl, '_blank');
  });
  sessionCard.querySelector('[data-action="open-summary"]').addEventListener('click', () => {
    window.open(summaryUrl, '_blank');
  });
  sessionCardTimeout = setTimeout(() => {
    hideSessionCard();
  }, 120000);
}

async function checkContinuation() {
  try {
    const res = await fetch(`${BACKEND_BASE_URL}/api/sessions/latest`);
    if (!res.ok) return;
    const session = await res.json();
    if (session && session.session_id) {
      showContinuationModal(session);
    }
  } catch (e) {
    console.error("Failed to check continuation:", e);
  }
}

function loadLastMeetingMeta() {
  try {
    const stored = localStorage.getItem(LAST_MEETING_META_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    if (!parsed?.name || !parsed?.sessionId) return null;
    return parsed;
  } catch (error) {
    console.error("Failed to load last meeting metadata:", error);
    localStorage.removeItem(LAST_MEETING_META_KEY);
    return null;
  }
}

function saveLastMeetingMeta(name, sessionId) {
  if (!name || !sessionId) return;
  const payload = { name, sessionId };
  try {
    localStorage.setItem(LAST_MEETING_META_KEY, JSON.stringify(payload));
    lastMeetingMeta = payload;
  } catch (error) {
    console.error("Unable to persist last meeting metadata:", error);
  }
}

function closePreRecordingContinuationModal() {
  if (preRecordingContinuationModalElement) {
    preRecordingContinuationModalElement.remove();
    preRecordingContinuationModalElement = null;
  }
}

function showPreRecordingContinuationModal(meta) {
  if (!meta) return;
  injectSessionCardStyles();
  closePreRecordingContinuationModal();
  const modal = document.createElement('div');
  preRecordingContinuationModalElement = modal;
  modal.id = 'bmad-pre-continuation-modal';
  modal.style.cssText = `
    position: fixed; bottom: 140px; left: 18px; width: 320px;
    background: #0f172a; color: #fff; padding: 16px; border-radius: 12px;
    box-shadow: 0 10px 25px rgba(0,0,0,0.5); z-index: 10002; font-family: system-ui;
    border: 1px solid rgba(255,255,255,0.1); display:flex; flex-direction:column; gap:10px;
  `;
  modal.innerHTML = `
    <div style="font-weight:600; font-size:14px;">Continue "${meta.name}"?</div>
    <div style="font-size:12px; color:#94a3b8; margin-bottom:12px;">
      Link this recording to the previous session so the summary merges past tasks with today's updates.
    </div>
    <div style="display:flex; gap:8px;">
      <button id="btn-pre-cont-yes" style="flex:1; background:#22c55e; border:none; padding:6px; border-radius:6px; cursor:pointer; font-weight:600;">Yes, continue</button>
      <button id="btn-pre-cont-no" style="flex:1; background:#334155; color:#fff; border:none; padding:6px; border-radius:6px; cursor:pointer;">No, start new</button>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector('#btn-pre-cont-yes').onclick = () => {
    currentParentSessionId = meta.sessionId;
    preRecordingContinuationConfirmed = true;
    showToast(`Linking "${meta.name}" so the next summary includes previous tasks.`);
    closePreRecordingContinuationModal();
  };

  modal.querySelector('#btn-pre-cont-no').onclick = () => {
    currentParentSessionId = null;
    preRecordingContinuationConfirmed = false;
    closePreRecordingContinuationModal();
  };
}

function maybeShowPreRecordingContinuationPrompt() {
  const meta = loadLastMeetingMeta();
  if (!meta?.name || !meta?.sessionId) return false;
  lastMeetingMeta = meta;
  if (preRecordingContinuationPromptShownForSession) return false;
  preRecordingContinuationPromptShownForSession = true;
  showPreRecordingContinuationModal(meta);
  return true;
}

function showContinuationModal(session) {
  injectSessionCardStyles();
  const existing = document.getElementById('bmad-continuation-modal');
  if (existing) existing.remove();

  let summaryText = "Previous meeting";
  try {
    const parsed = JSON.parse(session.summary);
    summaryText = parsed.summary || "Previous meeting";
    if (summaryText.length > 60) summaryText = summaryText.substring(0, 60) + "...";
  } catch(e) {}

  const continuationPrompt = session?.meeting_name
    ? `Is this the "${session.meeting_name}" meeting?`
    : "Is this a continuation?";

  const modal = document.createElement('div');
  modal.id = 'bmad-continuation-modal';
  modal.innerHTML = `
    <div style="font-weight:600; margin-bottom:8px; font-size:14px;">${continuationPrompt}</div>
    <div style="font-size:12px; color:#94a3b8; margin-bottom:12px;">
      Last session: "${summaryText}"
    </div>
    <div style="display:flex; gap:8px;">
      <button id="btn-cont-yes" style="flex:1; background:#22c55e; border:none; padding:6px; border-radius:6px; cursor:pointer; font-weight:600;">Yes</button>
      <button id="btn-cont-no" style="flex:1; background:#334155; color:#fff; border:none; padding:6px; border-radius:6px; cursor:pointer;">No</button>
    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById('btn-cont-yes').onclick = () => {
    currentParentSessionId = session.session_id;
    showToast("Linked to previous meeting.");
    modal.remove();
  };
  
  document.getElementById('btn-cont-no').onclick = () => {
    currentParentSessionId = null;
    modal.remove();
  };
}

async function showParticipantEmailModal(sessionId) {
  // Get participant names and extract emails from DOM
  const participantNames = collectParticipantNames();
  const extractedEmails = extractParticipantEmails();
  
  if (participantNames.length === 0) {
    showToast('No participants detected for email collection.');
    if (sessionId) showSessionCard(sessionId);
    return;
  }

  const existing = document.getElementById('bmad-participant-email-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'bmad-participant-email-modal';
  modal.style.position = 'fixed';
  modal.style.top = '50%';
  modal.style.left = '50%';
  modal.style.transform = 'translate(-50%, -50%)';
  modal.style.background = '#0f172a';
  modal.style.color = '#fff';
  modal.style.padding = '20px';
  modal.style.borderRadius = '12px';
  modal.style.zIndex = '10001';
  modal.style.minWidth = '400px';
  modal.style.maxHeight = '70vh';
  modal.style.overflowY = 'auto';
  modal.style.boxShadow = '0 10px 40px rgba(0, 0, 0, 0.5)';

  const title = document.createElement('div');
  title.textContent = 'Confirm participant emails';
  title.style.fontWeight = '700';
  title.style.fontSize = '16px';
  title.style.marginBottom = '16px';
  modal.appendChild(title);

  const subtitle = document.createElement('div');
  subtitle.textContent = 'Review and update emails to ensure action items are sent to the right people';
  subtitle.style.fontSize = '13px';
  subtitle.style.color = '#cbd5e1';
  subtitle.style.marginBottom = '12px';
  modal.appendChild(subtitle);

  const emailInputs = new Map();
  participantNames.forEach((name) => {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '8px';
    row.style.marginBottom = '8px';
    row.style.alignItems = 'center';

    const label = document.createElement('span');
    label.textContent = name;
    label.style.minWidth = '100px';
    label.style.fontSize = '13px';

    const input = document.createElement('input');
    input.type = 'email';
    // Pre-populate with extracted email or placeholder
    input.value = extractedEmails.get(name) || '';
    input.placeholder = 'email@example.com';
    input.style.flex = '1';
    input.style.padding = '6px 8px';
    input.style.borderRadius = '6px';
    input.style.border = '1px solid #475569';
    input.style.background = '#1e293b';
    input.style.color = '#fff';
    input.style.fontSize = '13px';

    emailInputs.set(name, input);
    row.appendChild(label);
    row.appendChild(input);
    modal.appendChild(row);
  });

  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.justifyContent = 'flex-end';
  actions.style.gap = '8px';
  actions.style.marginTop = '16px';

  // Function to send emails to backend
  const sendEmails = async (useExtracted = false) => {
    const participants = [];
    for (const [name, input] of emailInputs.entries()) {
      let email = input.value.trim();
      
      // If skipping, use extracted email if available
      if (useExtracted && !email) {
        email = extractedEmails.get(name) || null;
      }
      
      participants.push({ name, email: email || null });
    }

    try {
      const response = await fetch(`${BACKEND_BASE_URL}/api/sessions/${sessionId}/participants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ participants })
      });

      if (!response.ok) {
        throw new Error(`Failed to save participants: ${response.status}`);
      }

      showToast('Participant emails saved');
      modal.remove();
      showSessionCard(sessionId);
    } catch (err) {
      console.error('Failed to save participant emails:', err);
      showToast(`Error: ${err.message}`);
    }
  };

  const skipBtn = document.createElement('button');
  skipBtn.textContent = 'Skip (use extracted)';
  skipBtn.style.background = '#475569';
  skipBtn.style.color = '#fff';
  skipBtn.style.border = 'none';
  skipBtn.style.padding = '8px 16px';
  skipBtn.style.borderRadius = '6px';
  skipBtn.style.cursor = 'pointer';
  skipBtn.style.fontSize = '13px';
  skipBtn.onclick = () => {
    // Send emails with extracted values
    sendEmails(true);
  };

  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save emails';
  saveBtn.style.background = '#22c55e';
  saveBtn.style.color = '#0f172a';
  saveBtn.style.border = 'none';
  saveBtn.style.padding = '8px 16px';
  saveBtn.style.borderRadius = '6px';
  saveBtn.style.cursor = 'pointer';
  saveBtn.style.fontWeight = '600';
  saveBtn.style.fontSize = '13px';
  saveBtn.onclick = () => {
    // Send emails with user-entered values
    sendEmails(false);
  };

  actions.appendChild(skipBtn);
  actions.appendChild(saveBtn);
  modal.appendChild(actions);
  document.body.appendChild(modal);
}

function collectParticipantNames() {
  const candidates = new Set();
  
  // Get participant list items from Google Meet
  const participantListItems = document.querySelectorAll('div[data-participant-id], li[role="listitem"]');
  
  participantListItems.forEach((node) => {
    // Get the direct text content (participant name)
    // Avoid getting nested text like buttons, timestamps, etc.
    let name = '';
    
    // Try to extract just the name part (usually first text node or span)
    const nameSpan = node.querySelector('span[aria-label*="name" i], span:not([class*="button"]):not([class*="icon"])');
    if (nameSpan) {
      name = nameSpan.textContent.trim();
    } else {
      // Fallback: get direct text content but limit it
      const texts = Array.from(node.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent.trim())
        .filter(t => t.length > 0 && t.length < 50);
      name = texts[0] || '';
    }
    
    // If still empty, try aria-label
    if (!name) {
      const ariaLabel = node.getAttribute('aria-label') || '';
      name = ariaLabel.replace(/\s*\(.*?\)\s*/g, '').trim(); // Remove email/status in parentheses
    }
    
    // Validate name
    if (name && name.length > 0 && name.length < 50 && /[a-z]/i.test(name)) {
      // Avoid duplicate names that are too similar
      const isDuplicate = Array.from(candidates).some(existing => 
        existing.toLowerCase() === name.toLowerCase() || 
        existing.toLowerCase().includes(name.toLowerCase())
      );
      if (!isDuplicate) {
        candidates.add(name);
      }
    }
  });

  return Array.from(candidates);
}

function extractParticipantEmails() {
  // Try to extract emails from Google Meet participant list
  const emailMap = new Map(); // name -> email
  
  // Method 1: Look for email in participant hover tooltips or data attributes
  const participantElements = document.querySelectorAll('[role="listitem"], [data-participant-id]');
  
  participantElements.forEach((el) => {
    // Extract name
    const nameText = el.textContent.trim();
    if (!nameText || nameText.length > 80) return;
    
    // Try to find email in aria-label, data attributes, or title
    const ariaLabel = el.getAttribute('aria-label') || '';
    const dataEmail = el.getAttribute('data-email') || '';
    const titleAttr = el.getAttribute('title') || '';
    
    // Look for email pattern (basic)
    const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi;
    const ariaMatch = ariaLabel.match(emailRegex);
    const dataMatch = dataEmail.match(emailRegex);
    const titleMatch = titleAttr.match(emailRegex);
    
    const foundEmail = (ariaMatch || dataMatch || titleMatch)?.[0];
    
    if (foundEmail) {
      emailMap.set(nameText, foundEmail);
    }
  });
  
  // Method 2: Extract from Google Account info (if visible)
  // Google Meet sometimes shows user's email in profile or header
  const headerElements = document.querySelectorAll('[data-email], [data-user-email], [aria-label*="email" i]');
  headerElements.forEach((el) => {
    const email = el.getAttribute('data-email') || el.getAttribute('data-user-email') || '';
    if (email && email.includes('@')) {
      const nameText = el.textContent.trim();
      if (nameText && nameText.length < 80 && /[a-z]/i.test(nameText)) {
        emailMap.set(nameText, email);
      }
    }
  });
  
  // Method 3: Try to extract from visible text patterns
  // Sometimes participant info shows "Name (email)" format
  const allText = document.body.innerText;
  const emailPattern = /([A-Za-z\s]+)\s*\(([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)\)/g;
  let match;
  while ((match = emailPattern.exec(allText)) !== null) {
    const name = match[1].trim();
    const email = match[2];
    if (name.length < 80 && /[a-z]/i.test(name)) {
      emailMap.set(name, email);
    }
  }
  
  return emailMap;
}

showInstruction();
initMeetingWatcher();
window.addEventListener('beforeunload', () => {
  if (isRecording && !stopRequested) {
    meetingEndNotified = true;
    requestStopRecording('unload');
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'CHECK_MIC_STATUS') {
    getMicStatus().then((status) => sendResponse(status));
    return true;
  }

  if (message.type === 'RECORDING_STARTED') {
    isRecording = true;
    resetStopGuard();
    meetingWasActive = true;
    startTimer();
    return;
  }

  if (message.type === 'RECORDING_STOPPED') {
    isRecording = false;
    stopTimer('Uploading...');
    resetStopGuard();
    if (shouldPromptForMeetingNameAfterStop) {
      shouldPromptForMeetingNameAfterStop = false;
      promptForMeetingName();
    }
    return;
  }

  if (message.type === 'RECORDING_ERROR') {
    const errorText = message.message || 'Recording failed.';
    setBottomMessage('Error', '');
    showToast(`Recording error: ${errorText}`);
    console.error('Recording error:', errorText);
    shouldPromptForMeetingNameAfterStop = false;
    preRecordingContinuationConfirmed = false;
    currentMeetingNameCandidate = null;
    return;
  }

  if (message.type === 'MIC_PERMISSION_REQUIRED') {
    showPermissionWarning();
    return;
  }

  if (message.type === 'MIC_MUTED') {
    showUnmuteWarning(bottomTimerEl?.textContent || '');
    return;
  }

  if (message.type === 'UPLOAD_COMPLETE') {
    isRecording = false;
    stopTimer('Upload complete');
    const sessionId = message.sessionId || message.session_id;
    if (sessionId && currentMeetingNameCandidate) {
      saveLastMeetingMeta(currentMeetingNameCandidate, sessionId);
      currentMeetingNameCandidate = null;
    }
    const sessionText = sessionId ? `Session ${sessionId}` : 'Upload complete';
    showToast(`Recording finished. ${sessionText}`);
    if (sessionId) {
      showParticipantEmailModal(sessionId);
    }
    return;
  }

  if (message.type === 'MEETING_ENDED') {
    if (isRecording) {
      isRecording = false;
      stopTimer('Meeting ended');
      resetStopGuard();
    }
    return;
  }
});
