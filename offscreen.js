let mediaRecorder = null;
let recordedChunks = [];
let tabStream = null;
let micStream = null;
let audioCtx = null;
let currentTabId = null;
let rmsSamples = [];
let rmsIntervalId = null;
let uploadMetadata = {}; // Store metadata like parentSessionId

async function uploadRecording(blob) {
  const formData = new FormData();
  formData.append('audio', blob, 'recording.webm');
  if (uploadMetadata.parentSessionId) {
    formData.append('parentSessionId', uploadMetadata.parentSessionId);
  }
  if (uploadMetadata.meetingName) {
    formData.append('meetingName', uploadMetadata.meetingName);
  }

  const response = await fetch('http://localhost:8080/upload', {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upload failed: ${response.status} ${text}`);
  }

  const payload = await response.json();
  const sessionId = payload.sessionId || payload.session_id;
  console.log('Upload complete, session:', sessionId);
  return sessionId;
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

function computeRms(samples) {
  if (!samples.length) return 0;
  let sumSquares = 0;
  for (const value of samples) {
    sumSquares += value * value;
  }
  return Math.sqrt(sumSquares / samples.length);
}

function logTrackState(label, tracks) {
  const info = tracks.map((track) => ({
    kind: track.kind,
    muted: track.muted,
    enabled: track.enabled,
    readyState: track.readyState,
    settings: track.getSettings?.()
  }));
  console.log(`${label} track state:`, info);
}

function pickPreferredMicDevice(devices) {
  const audioInputs = devices.filter((device) => device.kind === 'audioinput');
  const bluetooth = audioInputs.find((device) => /bluetooth|headset|earbuds/i.test(device.label));
  return bluetooth?.deviceId || audioInputs[0]?.deviceId || null;
}

async function getMicStream() {
  const initialStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  const devices = await navigator.mediaDevices.enumerateDevices();
  const preferredId = pickPreferredMicDevice(devices);
  const currentTrack = initialStream.getAudioTracks()[0];
  const currentId = currentTrack?.getSettings?.().deviceId || null;

  if (preferredId && preferredId !== currentId) {
    initialStream.getTracks().forEach((track) => track.stop());
    return navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: preferredId } },
      video: false
    });
  }

  return initialStream;
}

function sendOffscreenError(message) {
  console.error('Offscreen failed:', message);
  if (currentTabId) {
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_ERROR',
      tabId: currentTabId,
      message: message
    });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  if (message.type === 'OFFSCREEN_PING') {
    sendResponse({ status: 'ready' });
    return false;
  }

  if (message.type === 'START_RECORDING') {
    (async () => {
      try {
        currentTabId = message.tabId || null;

        tabStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: 'tab',
              chromeMediaSourceId: message.streamId
            }
          },
          video: false
        });

        micStream = await getMicStream();

        const tabTracks = tabStream.getAudioTracks();
        const micTracks = micStream ? micStream.getAudioTracks() : [];
        console.log('Audio tracks detected:', tabTracks.length + micTracks.length);
        logTrackState('Tab', tabTracks);
        logTrackState('Mic', micTracks);

        if (tabTracks.length === 0) {
          throw new Error('Missing tab audio track.');
        }
        if (micTracks.length === 0) {
          console.warn('No microphone track available; continuing with tab audio only.');
          if (micStream) {
            micStream.getTracks().forEach((track) => track.stop());
          }
          micStream = null;
        }

        audioCtx = new AudioContext();
        console.log('AudioContext state before resume:', audioCtx.state);
        if (audioCtx.state === 'suspended') await audioCtx.resume();
        console.log('AudioContext state after resume:', audioCtx.state);

        const destination = audioCtx.createMediaStreamDestination();
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;

        const tabSource = audioCtx.createMediaStreamSource(tabStream);
        const micSource = micStream ? audioCtx.createMediaStreamSource(micStream) : null;
        const mix = audioCtx.createGain();

        tabSource.connect(mix);
        if (micSource) {
          micSource.connect(mix);
        }
        mix.connect(destination);
        mix.connect(analyser);

        const destinationTracks = destination.stream.getAudioTracks();
        console.log('Destination audio tracks:', destinationTracks.length);
        if (destinationTracks.length === 0) {
          throw new Error('Audio mix produced no destination track.');
        }

        rmsSamples = [];
        rmsIntervalId = setInterval(() => {
          const buffer = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(buffer);
          let sumSquares = 0;
          for (let i = 0; i < buffer.length; i += 1) {
            sumSquares += buffer[i] * buffer[i];
          }
          rmsSamples.push(Math.sqrt(sumSquares / buffer.length));
        }, 500);

        mediaRecorder = new MediaRecorder(destination.stream, {
          mimeType: 'audio/webm;codecs=opus',
          audioBitsPerSecond: 128000
        });
        recordedChunks = [];

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            recordedChunks.push(event.data);
          }
          console.log('Chunk size:', event.data.size);
        };

        mediaRecorder.onstop = async () => {
          try {
            if (rmsIntervalId) clearInterval(rmsIntervalId);
            const blob = new Blob(recordedChunks, { type: 'audio/webm' });
            console.log('Recording stopped, size:', blob.size);

            const avgRms = computeRms(rmsSamples);
            console.log('Average RMS level:', avgRms);

            if (blob.size < 50 * 1024) {
              const message = 'Recording too small; skipping upload.';
              console.error(message);
              sendOffscreenError(message);
              return;
            }

            if (avgRms < 0.002) {
              const message = 'Recording appears silent (low RMS); skipping upload.';
              console.error(message);
              sendOffscreenError(message);
              return;
            }

            const sessionId = await uploadRecording(blob);
            if (currentTabId) {
              chrome.runtime.sendMessage({
                type: 'UPLOAD_COMPLETE',
                tabId: currentTabId,
                sessionId: sessionId
              });
            }
          } catch (err) {
            console.error('Failed to upload recording:', err);
          } finally {
            recordedChunks = [];
            if (tabStream) tabStream.getTracks().forEach((track) => track.stop());
            if (micStream) micStream.getTracks().forEach((track) => track.stop());
            tabStream = null;
            micStream = null;
            if (audioCtx) await audioCtx.close();
            audioCtx = null;
            mediaRecorder = null;
            rmsSamples = [];
            rmsIntervalId = null;
          }
        };

        mediaRecorder.start(1000);
        console.log('Recording started with audio');
        if (currentTabId) {
          chrome.runtime.sendMessage({
            type: 'OFFSCREEN_RECORDING_STARTED',
            tabId: currentTabId
          });
        }
      } catch (err) {
        sendOffscreenError(err?.message || String(err));
      }
    })();
  }

  if (message.type === 'STOP_RECORDING') {
    uploadMetadata = { parentSessionId: message.parentSessionId, meetingName: message.meetingName };
    stopRecording();
  }
});
