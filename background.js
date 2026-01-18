const recordingTabs = new Set();
const badgeFlashers = new Map();
const recordingStartTimes = new Map();

function getMicStatus(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'CHECK_MIC_STATUS' }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, permission: 'prompt', muted: false, found: false });
        return;
      }
      resolve({
        ok: true,
        permission: response?.permission || 'prompt',
        muted: Boolean(response?.muted),
        found: Boolean(response?.found)
      });
    });
  });
}

async function ensureMicReady(tabId) {
  const status = await getMicStatus(tabId);
  if (!status.ok) return false;
  if (status.permission !== 'granted') {
    chrome.tabs.sendMessage(tabId, { type: 'MIC_PERMISSION_REQUIRED' });
    await clearBadge(tabId);
    return false;
  }
  if (status.found && status.muted) {
    chrome.tabs.sendMessage(tabId, { type: 'MIC_MUTED' });
    await clearBadge(tabId);
    return false;
  }
  return true;
}

async function beginRecording(tabId) {
  stopBadgeFlash(tabId);
  await setBadge(tabId, 'REC', '#dc2626');
  const ready = await ensureMicReady(tabId);
  if (!ready) {
    return false;
  }

  try {
    await handleStartRecording(tabId);
    recordingTabs.add(tabId);
    recordingStartTimes.set(tabId, Date.now());
    await setBadge(tabId, 'ON', '#16a34a');
    chrome.tabs.sendMessage(tabId, { type: 'RECORDING_STARTED' });
    return true;
  } catch (error) {
    console.error('Failed to start recording:', error);
    await clearBadge(tabId);
    chrome.tabs.sendMessage(tabId, { type: 'RECORDING_ERROR', message: error.message });
    return false;
  }
}

async function startRecordingForTab(tabId, sendResponse) {
  try {
    if (!tabId) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tab?.id;
    }
    if (!tabId) {
      sendResponse?.({ status: 'error', message: 'No active tab.' });
      return;
    }

    const alreadyCaptured = await isTabCaptured(tabId);
    if (recordingTabs.has(tabId) || alreadyCaptured) {
      recordingTabs.add(tabId);
      sendResponse?.({ status: 'accepted' });
      return;
    }

    const started = await beginRecording(tabId);
    sendResponse?.({
      status: started ? 'accepted' : 'error',
      message: started ? undefined : 'Recording blocked.'
    });
  } catch (error) {
    console.error('Start failed:', error);
    sendResponse?.({ status: 'error', message: error?.message || 'Start failed.' });
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;

  const alreadyCaptured = await isTabCaptured(tab.id);
  if (recordingTabs.has(tab.id) || alreadyCaptured) {
    stopRecording(tab.id);
    return;
  }

  await beginRecording(tab.id);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'START_RECORDING') {
    startRecordingForTab(sender?.tab?.id, sendResponse);
    return true;
  }

  if (message.action === 'STOP_RECORDING') {
    sendResponse({ status: 'accepted' });
    stopRecording(sender?.tab?.id);
    return false;
  }

  if (message.type === 'CTA_START') {
    const tabId = sender?.tab?.id;
    if (!tabId) {
      sendResponse({ status: 'error', message: 'No active tab to open popup.' });
      return false;
    }

    (async () => {
      try {
        const alreadyCaptured = await isTabCaptured(tabId);
        if (recordingTabs.has(tabId) || alreadyCaptured) {
          recordingTabs.add(tabId);
          if (!recordingStartTimes.has(tabId)) recordingStartTimes.set(tabId, Date.now());
          sendResponse({ status: 'started' });
          return;
        }
        if (!chrome.action?.openPopup) {
          sendResponse({ status: 'error', message: 'Popup not available.' });
          return;
        }
        await chrome.action.openPopup();
        sendResponse({ status: 'popup_opened' });
      } catch (error) {
        console.error('CTA start failed:', error);
        sendResponse({
          status: 'error',
          message: error?.message || 'Failed to open popup.'
        });
      }
    })();
    return true;
  }

  if (message.type === 'GET_RECORDING_STATUS') {
    const tabId = message.tabId || sender?.tab?.id;
    if (!tabId) {
      sendResponse({ status: 'error', message: 'No active tab.' });
      return false;
    }

    (async () => {
      const alreadyCaptured = await isTabCaptured(tabId);
      const isRecording = recordingTabs.has(tabId) || alreadyCaptured;
      const startedAt = recordingStartTimes.get(tabId) || null;
      const elapsedSeconds = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
      sendResponse({ status: 'ok', isRecording, elapsedSeconds });
    })();
    return true;
  }

  if (message.type === 'REQUEST_START') {
    if (sender?.tab?.id) {
      startBadgeFlash(sender.tab.id);
    }
    sendResponse({ status: 'needs_user_gesture' });
    return false;
  }

  if (message.type === 'AUTO_START') {
    startRecordingForTab(sender?.tab?.id, sendResponse);
    return true;
  }

  if (message.type === 'STOP_RECORDING') {
    if (sender?.tab?.id) {
      recordingTabs.delete(sender.tab.id);
      recordingStartTimes.delete(sender.tab.id);
    }
    stopRecording(sender?.tab?.id, message.parentSessionId, message.meetingName);
    sendResponse({ status: 'success' });
    return false;
  }

  if (message.type === 'MEETING_ENDED' && sender?.tab?.id) {
    stopRecording(sender.tab.id);
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

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-recording') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  const alreadyCaptured = await isTabCaptured(tab.id);
  if (recordingTabs.has(tab.id) || alreadyCaptured) {
    stopRecording(tab.id);
    return;
  }

  await beginRecording(tab.id);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (recordingTabs.has(tabId)) {
    stopRecording(tabId);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!recordingTabs.has(tabId)) return;
  
  // Only stop if URL actually changed (changeInfo.url exists) AND it's away from meet.google.com
  // This prevents false stops when switching tabs but staying on the same URL
  if (changeInfo.url && !/meet\.google\.com/.test(changeInfo.url)) {
    console.log(`Stopping recording: tab navigated away from Google Meet to ${changeInfo.url}`);
    stopRecording(tabId);
  }
});

async function handleStartRecording(tabId) {
  try {
    const alreadyCaptured = await isTabCaptured(tabId);
    if (recordingTabs.has(tabId) || alreadyCaptured) {
      throw new Error('Recording already active for this tab.');
    }

    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

    await ensureOffscreenDocument();
    await ensureOffscreenReady();

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

    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Recording Meet audio'
    });

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
      stopRecording(tabId);
    });
  } catch (error) {
    console.error('Popup stop failed:', error);
  }
}

function stopRecording(tabId, parentSessionId = null, meetingName = null) {
  if (!tabId) return;
  const wasRecorded = recordingTabs.delete(tabId);
  recordingStartTimes.delete(tabId);

  chrome.runtime.sendMessage({
    type: 'STOP_RECORDING',
    target: 'offscreen',
    parentSessionId: parentSessionId, // Forward the ID from content script
    meetingName: meetingName
  });

  stopBadgeFlash(tabId);
  clearBadge(tabId);
  chrome.tabs.sendMessage(tabId, { type: 'RECORDING_STOPPED' });

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
