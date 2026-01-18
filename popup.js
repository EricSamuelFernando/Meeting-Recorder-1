const statusEl = document.getElementById('status');
const timerEl = document.getElementById('timer');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
let statusInterval = null;

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function setTimer(seconds) {
  if (!timerEl) return;
  const mins = String(Math.floor(seconds / 60)).padStart(2, '0');
  const secs = String(seconds % 60).padStart(2, '0');
  timerEl.textContent = `${mins}:${secs}`;
}

function refreshStatus() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError) {
      console.error('Status query failed:', chrome.runtime.lastError.message);
      return;
    }

    const tabId = tabs?.[0]?.id;
    if (!tabId) {
      setStatus('No active tab');
      return;
    }

    chrome.runtime.sendMessage({ action: 'GET_RECORDING_STATUS', tabId }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('Status fetch failed:', chrome.runtime.lastError.message);
        return;
      }
      const isRecording = Boolean(response?.isRecording);
      setStatus(isRecording ? 'Recording' : 'Idle');
      setTimer(isRecording ? response?.elapsedSeconds || 0 : 0);
    });
  });
}

startBtn?.addEventListener('click', () => {
  console.log('Start clicked');
  setStatus('Starting...');
  chrome.runtime.sendMessage({ action: 'START_RECORDING' }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Start send failed:', chrome.runtime.lastError.message);
      setStatus('Error');
      return;
    }
    if (response?.status === 'error') {
      setStatus('Error');
      return;
    }
    setStatus('Requested');
    refreshStatus();
  });
});

stopBtn?.addEventListener('click', () => {
  console.log('Stop clicked');
  setStatus('Stopping...');
  chrome.runtime.sendMessage({ action: 'STOP_RECORDING' }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Stop send failed:', chrome.runtime.lastError.message);
      setStatus('Error');
      return;
    }
    if (response?.status === 'error') {
      setStatus('Error');
      return;
    }
    setStatus('Requested');
    refreshStatus();
  });
});

refreshStatus();
if (!statusInterval) {
  statusInterval = setInterval(refreshStatus, 1000);
}
