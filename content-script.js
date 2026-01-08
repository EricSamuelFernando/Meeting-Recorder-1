const panelId = 'bmad-recorder-panel';
let isRecording = false;
let timerInterval = null;
let startTime = null;
let toggleButton = null;
let participantsInterval = null;
let toastTimeout = null;
let lastRoster = [];

function resetTimerDisplay() {
  const timerEl = document.getElementById('bmad-recorder-timer');
  if (timerEl) timerEl.textContent = '00:00';
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  startTime = null;
}

function formatElapsed(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const mins = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const secs = String(totalSeconds % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}

function updateTimer() {
  const timerEl = document.getElementById('bmad-recorder-timer');
  if (!timerEl || !startTime || !isRecording) {
    if (timerEl) timerEl.textContent = '00:00';
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
    startTime = null;
    return;
  }
  timerEl.textContent = formatElapsed(Date.now() - startTime);
}

function updateParticipants() {
  const participantsEl = document.getElementById('bmad-recorder-participants');
  if (!participantsEl) return;

  const count = getParticipantCount();
  participantsEl.textContent = count ? `Participants: ${count}` : 'Participants: -';
  collectParticipantsFromDom();
}

function setStatus(text) {
  const statusEl = document.getElementById('bmad-recorder-status');
  if (statusEl) statusEl.textContent = text;
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
    toast.style.zIndex = '9999';
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

function updateToggleLabel() {
  if (toggleButton) toggleButton.textContent = isRecording ? 'Stop' : 'Start';
}

function startRecording() {
  if (isRecording) return;
  setStatus('Click extension icon to start');
  chrome.runtime.sendMessage({ type: 'REQUEST_START' }, () => {
    if (chrome.runtime.lastError) {
      console.error('Start request error:', chrome.runtime.lastError.message);
    }
  });
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  setStatus('Uploading...');
  updateToggleLabel();
  resetTimerDisplay();
  if (participantsInterval) clearInterval(participantsInterval);
  participantsInterval = null;

  chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Error:', chrome.runtime.lastError.message);
      setStatus('Error');
    } else if (response?.status !== 'success') {
      setStatus('Error');
    }
  });
}

function ensurePanel() {
  const existingPanel = document.getElementById(panelId);
  if (existingPanel) {
    if (!isRecording) {
      resetTimerDisplay();
      setStatus('Start Recorder');
      updateToggleLabel();
    }
    return;
  }
  const panel = document.createElement('div');
  panel.id = panelId;
  panel.style.position = 'fixed';
  panel.style.top = '12px';
  panel.style.left = '12px';
  panel.style.zIndex = '9999';
  panel.style.background = '#111';
  panel.style.color = '#fff';
  panel.style.padding = '10px 12px';
  panel.style.borderRadius = '8px';
  panel.style.fontFamily = 'system-ui, sans-serif';
  panel.style.display = 'flex';
  panel.style.gap = '8px';
  panel.style.alignItems = 'center';

  const status = document.createElement('span');
  status.id = 'bmad-recorder-status';
  status.textContent = 'Start Recorder';

  const timer = document.createElement('span');
  timer.id = 'bmad-recorder-timer';
  timer.textContent = '00:00';

  const participants = document.createElement('span');
  participants.id = 'bmad-recorder-participants';
  participants.textContent = 'Participants: —';

  toggleButton = document.createElement('button');
  toggleButton.textContent = 'Start';
  toggleButton.style.background = '#e11d48';
  toggleButton.style.color = '#fff';
  toggleButton.style.border = 'none';
  toggleButton.style.padding = '6px 10px';
  toggleButton.style.borderRadius = '6px';
  toggleButton.style.cursor = 'pointer';
  toggleButton.onclick = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  panel.appendChild(status);
  panel.appendChild(timer);
  panel.appendChild(participants);
  panel.appendChild(toggleButton);
  document.body.appendChild(panel);
}

function getParticipantCount() {
  const candidateSelectors = [
    '[aria-label*="participant" i]',
    '[aria-label*="participants" i]',
    '[aria-label*="people" i]',
    '[data-tooltip*="people" i]',
    '[data-tooltip*="participants" i]',
    '[data-tooltip*="Show everyone" i]'
  ];

  for (const selector of candidateSelectors) {
    const nodes = Array.from(document.querySelectorAll(selector));
    for (const node of nodes) {
      const text = [
        node.getAttribute('aria-label'),
        node.getAttribute('data-tooltip'),
        node.textContent
      ]
        .filter(Boolean)
        .join(' ');

      const match = text.match(/(\d{1,3})/);
      if (match) return match[1];
    }
  }

  return '';
}

function collectParticipantsFromDom() {
  const candidates = new Set();
  const nodes = document.querySelectorAll('[role="listitem"], [data-participant-id], [data-self-name]');
  nodes.forEach((node) => {
    const text = node.textContent || '';
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (cleaned.length > 0 && cleaned.length < 80) {
      candidates.add(cleaned);
    }
  });

  const list = Array.from(candidates).filter((name) => /[a-z]/i.test(name));
  lastRoster = list;
  return list;
}

async function sendRoster(sessionId) {
  if (!sessionId || lastRoster.length === 0) return;
  try {
    await fetch(`http://localhost:8080/api/sessions/${sessionId}/participants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participants: lastRoster })
    });
  } catch (err) {
    console.error('Failed to send roster:', err);
  }
}

function extractSpeakers(transcriptText) {
  const matches = transcriptText.match(/Speaker\s+\d+/g) || [];
  return Array.from(new Set(matches));
}

function renderMappingModal(sessionId, transcriptText) {
  const speakers = extractSpeakers(transcriptText);
  if (speakers.length === 0 || lastRoster.length === 0) return;

  const existing = document.getElementById('bmad-speaker-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'bmad-speaker-modal';
  modal.style.position = 'fixed';
  modal.style.top = '20%';
  modal.style.left = '50%';
  modal.style.transform = 'translateX(-50%)';
  modal.style.background = '#0f172a';
  modal.style.color = '#fff';
  modal.style.padding = '16px';
  modal.style.borderRadius = '12px';
  modal.style.zIndex = '10000';
  modal.style.minWidth = '320px';
  modal.style.boxShadow = '0 10px 28px rgba(0, 0, 0, 0.45)';

  const title = document.createElement('div');
  title.textContent = 'Assign speaker names (optional)';
  title.style.fontWeight = '600';
  title.style.marginBottom = '12px';
  modal.appendChild(title);

  const selects = new Map();
  speakers.forEach((speaker) => {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.justifyContent = 'space-between';
    row.style.alignItems = 'center';
    row.style.marginBottom = '8px';

    const label = document.createElement('span');
    label.textContent = speaker;

    const select = document.createElement('select');
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = 'Unassigned';
    select.appendChild(empty);
    lastRoster.forEach((name) => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    });

    selects.set(speaker, select);
    row.appendChild(label);
    row.appendChild(select);
    modal.appendChild(row);
  });

  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.justifyContent = 'flex-end';
  actions.style.gap = '8px';
  actions.style.marginTop = '12px';

  const skipBtn = document.createElement('button');
  skipBtn.textContent = 'Skip';
  skipBtn.onclick = () => modal.remove();

  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Apply names';
  saveBtn.style.background = '#22c55e';
  saveBtn.style.color = '#0f172a';
  saveBtn.style.border = 'none';
  saveBtn.style.padding = '6px 10px';
  saveBtn.style.borderRadius = '6px';
  saveBtn.style.cursor = 'pointer';
  saveBtn.onclick = async () => {
    const map = {};
    for (const [speaker, select] of selects.entries()) {
      const value = select.value;
      if (value) map[speaker] = value;
    }
    if (Object.keys(map).length === 0) {
      modal.remove();
      return;
    }

    try {
      await fetch(`http://localhost:8080/api/sessions/${sessionId}/speaker-map`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ map })
      });
      showToast('Speaker names applied');
    } catch (err) {
      console.error('Failed to apply speaker map:', err);
    } finally {
      modal.remove();
    }
  };

  actions.appendChild(skipBtn);
  actions.appendChild(saveBtn);
  modal.appendChild(actions);
  document.body.appendChild(modal);
}

function hookJoinButton() {
  const buttons = Array.from(document.querySelectorAll('button'));
  const joinButton = buttons.find((btn) =>
    /join now|ask to join/i.test(btn.textContent || '')
  );

  if (joinButton && !joinButton.dataset.bmadHooked) {
    joinButton.dataset.bmadHooked = 'true';
    joinButton.addEventListener('click', () => {
      ensurePanel();
      setStatus('Start Recorder');
    });
  }
}

ensurePanel();
setStatus('Start Recorder');
updateParticipants();

const observer = new MutationObserver(() => hookJoinButton());
observer.observe(document.body, { childList: true, subtree: true });

window.addEventListener('beforeunload', () => {
  if (isRecording) stopRecording();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'RECORDING_STARTED') {
    isRecording = true;
    startTime = Date.now();
    setStatus('Recording');
    updateToggleLabel();
    updateTimer();
    updateParticipants();
    if (participantsInterval) clearInterval(participantsInterval);
    participantsInterval = setInterval(updateParticipants, 2000);
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(updateTimer, 1000);
  }

  if (message.type === 'RECORDING_STOPPED') {
    isRecording = false;
    setStatus('Uploading...');
    updateToggleLabel();
    resetTimerDisplay();
    if (participantsInterval) clearInterval(participantsInterval);
    participantsInterval = null;
  }

  if (message.type === 'RECORDING_ERROR') {
    setStatus('Error');
    console.error('Recording error:', message.message);
    showToast(`Recording error: ${message.message}`);
  }

  if (message.type === 'UPLOAD_COMPLETE') {
    isRecording = false;
    setStatus('Upload complete');
    resetTimerDisplay();
    const sessionText = message.sessionId ? `Session ${message.sessionId}` : 'Upload complete';
    showToast(`Recording finished. ${sessionText}`);

    const roster = collectParticipantsFromDom();
    sendRoster(message.sessionId);

    if (message.sessionId) {
      const attemptFetch = (attempt) => {
        fetch(`http://localhost:8080/api/sessions/${message.sessionId}`)
          .then((response) => response.json())
          .then((session) => {
            if (session?.transcript) {
              if (lastRoster.length === 0) {
                showToast('No participant roster detected yet.');
              }
              renderMappingModal(message.sessionId, session.transcript);
            } else if (attempt < 2) {
              setTimeout(() => attemptFetch(attempt + 1), 1000);
            } else {
              showToast('No speaker labels detected yet.');
            }
          })
          .catch((err) => console.error('Failed to load transcript:', err));
      };
      attemptFetch(0);
    }
  }
});
