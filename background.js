const recordingTabs = new Set();
const badgeFlashers = new Map();

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;

  const alreadyCaptured = await isTabCaptured(tab.id);
  if (recordingTabs.has(tab.id) || alreadyCaptured) {
    stopRecording(tab.id);
    return;
  }

  try {
    stopBadgeFlash(tab.id);
    await setBadge(tab.id, 'REC', '#dc2626');
    await handleStartRecording(tab.id);
    recordingTabs.add(tab.id);
    await setBadge(tab.id, 'ON', '#16a34a');
    chrome.tabs.sendMessage(tab.id, { type: 'RECORDING_STARTED' });
  } catch (error) {
    console.error('Failed to start recording:', error);
    await clearBadge(tab.id);
    chrome.tabs.sendMessage(tab.id, { type: 'RECORDING_ERROR', message: error.message });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'START_RECORDING') {
    console.log('START_RECORDING received');
    sendResponse({ status: 'accepted' });
    handlePopupStart();
    return false;
  }

  if (message.action === 'STOP_RECORDING') {
    console.log('STOP_RECORDING received');
    sendResponse({ status: 'accepted' });
    handlePopupStop();
    return false;
  }

  if (message.type === 'REQUEST_START') {
    if (sender?.tab?.id) {
      startBadgeFlash(sender.tab.id);
    }
    sendResponse({ status: 'needs_user_gesture' });
    return false;
  }

  if (message.type === 'STOP_RECORDING') {
    if (sender?.tab?.id) {
      recordingTabs.delete(sender.tab.id);
    }
    stopRecording(sender?.tab?.id);
    sendResponse({ status: 'success' });
    return false;
  }

  if (message.type === 'UPLOAD_COMPLETE' && message.tabId) {
    chrome.tabs.sendMessage(message.tabId, {
      type: 'UPLOAD_COMPLETE',
      sessionId: message.sessionId || null
    });
    return false;
  }

  if (message.type === 'OFFSCREEN_RECORDING_STARTED' && message.tabId) {
    chrome.tabs.sendMessage(message.tabId, { type: 'RECORDING_STARTED' });
    return false;
  }

  if (message.type === 'OFFSCREEN_ERROR' && message.tabId) {
    chrome.tabs.sendMessage(message.tabId, {
      type: 'RECORDING_ERROR',
      message: message.message || 'Recording failed.'
    });
    return false;
  }
});

async function handleStartRecording(tabId) {
  try {
    const alreadyCaptured = await isTabCaptured(tabId);
    if (recordingTabs.has(tabId) || alreadyCaptured) {
      throw new Error('Recording already active for this tab.');
    }

    // Get Stream ID immediately (preserves the user gesture).
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

    await ensureOffscreenDocument();
    await ensureOffscreenReady();

    // Send stream to offscreen for recording + processing.
    chrome.runtime.sendMessage({
      type: 'START_RECORDING',
      streamId: streamId,
      tabId: tabId,
      target: 'offscreen'
    });

    return true;
  } catch (error) {
    console.error('Failed to start recording:', error);
    throw error;
  }
}

async function ensureOffscreenReady() {
  const maxAttempts = 20;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await chrome.runtime.sendMessage({
        type: 'OFFSCREEN_PING',
        target: 'offscreen'
      });
      return;
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error('Offscreen document did not respond in time.');
}

async function ensureOffscreenDocument() {
  try {
    if (chrome.offscreen?.hasDocument) {
      const exists = await chrome.offscreen.hasDocument();
      if (exists) return;
    }

    console.log('Attempting to create offscreen document');
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'], // Required for getUserMedia
      justification: 'Recording Meet audio'
    });
    console.log('Offscreen document created');

    const maxChecks = 10;
    for (let i = 0; i < maxChecks; i += 1) {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (contexts.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error('Offscreen document was not created.');
  } catch (error) {
    console.error('Failed to create offscreen document:', error);
    throw error;
  }
}

async function handlePopupStart() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      console.error('Popup start failed: No active tab.');
      return;
    }

    const alreadyCaptured = await isTabCaptured(tab.id);
    if (recordingTabs.has(tab.id) || alreadyCaptured) {
      recordingTabs.add(tab.id);
      console.log('Popup start ignored: already recording.');
      return;
    }

    await handleStartRecording(tab.id);
    recordingTabs.add(tab.id);
    await setBadge(tab.id, 'ON', '#16a34a');
    chrome.tabs.sendMessage(tab.id, { type: 'RECORDING_STARTED' });
  } catch (error) {
    console.error('Popup start failed:', error);
  }
}

function handlePopupStop() {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        console.error('Popup stop failed:', chrome.runtime.lastError.message);
        return;
      }

      const tabId = tabs?.[0]?.id;
      if (!tabId) {
        console.error('Popup stop failed: No active tab.');
        return;
      }
      recordingTabs.delete(tabId);
      stopRecording(tabId);
    });
  } catch (error) {
    console.error('Popup stop failed:', error);
  }
}

function stopRecording(tabId) {
  chrome.runtime.sendMessage({
    type: 'STOP_RECORDING',
    target: 'offscreen'
  });

  if (tabId) {
    stopBadgeFlash(tabId);
    clearBadge(tabId);
    chrome.tabs.sendMessage(tabId, { type: 'RECORDING_STOPPED' });
  }
}

function isTabCaptured(tabId) {
  return new Promise((resolve) => {
    chrome.tabCapture.getCapturedTabs((tabs) => {
      const active = Array.isArray(tabs) && tabs.some((tab) => tab.tabId === tabId);
      resolve(active);
    });
  });
}

async function setBadge(tabId, text, color) {
  try {
    const exists = await tabExists(tabId);
    if (!exists) {
      stopBadgeFlash(tabId);
      return;
    }
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch (error) {
    console.error('Failed to set badge:', error);
  }
}

async function clearBadge(tabId) {
  try {
    const exists = await tabExists(tabId);
    if (!exists) {
      stopBadgeFlash(tabId);
      return;
    }
    await chrome.action.setBadgeText({ tabId, text: '' });
  } catch (error) {
    console.error('Failed to clear badge:', error);
  }
}

function startBadgeFlash(tabId) {
  if (badgeFlashers.has(tabId)) return;

  let show = false;
  const intervalId = setInterval(async () => {
    const exists = await tabExists(tabId);
    if (!exists) {
      stopBadgeFlash(tabId);
      return;
    }
    show = !show;
    if (show) {
      await setBadge(tabId, 'CLICK', '#2563eb');
    } else {
      await clearBadge(tabId);
    }
  }, 700);

  badgeFlashers.set(tabId, intervalId);
}

function stopBadgeFlash(tabId) {
  const intervalId = badgeFlashers.get(tabId);
  if (intervalId) {
    clearInterval(intervalId);
    badgeFlashers.delete(tabId);
  }
}

function tabExists(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, () => {
      resolve(!chrome.runtime.lastError);
    });
  });
}
