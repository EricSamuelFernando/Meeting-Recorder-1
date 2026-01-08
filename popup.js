const statusEl = document.getElementById('status');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

startBtn?.addEventListener('click', () => {
  console.log('Start clicked');
  setStatus('Starting...');
  chrome.runtime.sendMessage({ action: 'START_RECORDING' }, () => {
    if (chrome.runtime.lastError) {
      console.error('Start send failed:', chrome.runtime.lastError.message);
      setStatus('Error');
      return;
    }
    setStatus('Requested');
  });
});

stopBtn?.addEventListener('click', () => {
  console.log('Stop clicked');
  setStatus('Stopping...');
  chrome.runtime.sendMessage({ action: 'STOP_RECORDING' }, () => {
    if (chrome.runtime.lastError) {
      console.error('Stop send failed:', chrome.runtime.lastError.message);
      setStatus('Error');
      return;
    }
    setStatus('Requested');
  });
});
