const BACKEND_BASE_URL = 'http://localhost:8080';

function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function setText(el, text, fallback) {
  if (!el) return;
  if (text && text.trim().length > 0) {
    el.textContent = text;
    el.classList.remove('loading');
    el.classList.remove('empty');
    return;
  }
  el.textContent = fallback;
  el.classList.add('empty');
  el.classList.remove('loading');
}

async function fetchSession(sessionId) {
  const resp = await fetch(`${BACKEND_BASE_URL}/api/sessions/${sessionId}`);
  if (!resp.ok) throw new Error('Session not found');
  return resp.json();
}

function buildActionItemsHtml(items = []) {
  if (!items.length) return '<p class="empty">No action items yet.</p>';
  return items.map(item => `
    <div class="assignee-block">
      <strong>${item.assignee}</strong>
      <ol>
        ${item.tasks.map(task => `<li>${task}</li>`).join('')}
      </ol>
    </div>
  `).join('');
}

function buildTopicsHtml(topics = []) {
  if (!topics.length) return '<p class="empty">No topics recorded.</p>';
  return topics.map(topic => `
    <div class="topic-block">
      <h4>${topic.title}${topic.owner ? ` (${topic.owner})` : ''}</h4>
      <ul>
        ${topic.bullets.map(b => `<li>${b}</li>`).join('')}
      </ul>
      ${topic.progress_update ? `<div class="progress-update"><strong>Progress Update:</strong><ul>${topic.progress_update.map(item => `<li>${item}</li>`).join('')}</ul></div>` : ''}
    </div>
  `).join('');
}

async function init() {
  const sessionId = getQueryParam('session');
  if (!sessionId) {
    document.getElementById('recap-card').insertAdjacentHTML(
      'beforeend',
      '<p class="empty">Missing session id.</p>'
    );
    return;
  }

  const player = document.getElementById('recording-player');
  const summaryBlock = document.getElementById('summary-block');
  const transcriptBlock = document.getElementById('transcript-block');
  const recordingLoading = document.getElementById('recording-loading');

  player.src = `${BACKEND_BASE_URL}/recordings/${sessionId}`;
  recordingLoading.textContent = 'Recording ready';
  try {
    const data = await fetchSession(sessionId);
    let summaryText = data?.summary;
    let parsedSummary = null;

    try {
      parsedSummary = JSON.parse(summaryText);
    } catch (e) {
      parsedSummary = null;
    }

    if (parsedSummary && typeof parsedSummary.summary === 'object' && parsedSummary.summary !== null) {
      const summaryObj = parsedSummary.summary;
      const header = summaryObj.title ? `
        <div class="summary-header">
          <h2>${summaryObj.title}</h2>
          <p>${summaryObj.date} • ${summaryObj.duration}</p>
          ${summaryObj.view_recording ? `<a href="${summaryObj.view_recording}" target="_blank">View Recording</a>` : ''}
        </div>
      ` : '';

      const actionItems = buildActionItemsHtml(summaryObj.action_items);
      const meetingPurpose = summaryObj.meeting_summary?.meeting_purpose
        ? `<p>${summaryObj.meeting_summary.meeting_purpose}</p>`
        : '<p class="empty">Meeting purpose not available.</p>';
      const keyTakeaways = (summaryObj.meeting_summary?.key_takeaways || []).map(k => `<li>${k}</li>`).join('');
      const topics = buildTopicsHtml(summaryObj.topics);
      const continuationSection = summaryObj.continuation_summary
        ? `
          <div class="continuation-block">
            <h3>Continuation</h3>
            <ul>
              ${summaryObj.continuation_summary.progress ? `<li>Progress: ${summaryObj.continuation_summary.progress}</li>` : ''}
              ${summaryObj.continuation_summary.completed?.length ? `<li>Completed: ${summaryObj.continuation_summary.completed.join(', ')}</li>` : ''}
              ${summaryObj.continuation_summary.next_steps?.length ? `<li>Next steps: ${summaryObj.continuation_summary.next_steps.join(', ')}</li>` : ''}
              ${summaryObj.continuation_summary.estimated_remaining_days ? `<li>Estimated remaining time: ${summaryObj.continuation_summary.estimated_remaining_days} days</li>` : ''}
              ${summaryObj.continuation_summary.blockers?.length ? `<li>Blockers: ${summaryObj.continuation_summary.blockers.join(', ')}</li>` : ''}
            </ul>
          </div>
        ` : '';

      summaryBlock.innerHTML = `
        ${header}
        <section class="section">
          <h3>Action Items ✨</h3>
          ${actionItems}
        </section>
        <section class="section">
          <h3>Meeting Summary ✨</h3>
          <div class="summary-purpose">
            <strong>Meeting Purpose</strong>
            ${meetingPurpose}
          </div>
          <div class="summary-takeaways">
            <strong>Key Takeaways</strong>
            <ul>${keyTakeaways || '<li>No takeaways captured.</li>'}</ul>
          </div>
        </section>
        <section class="section">
          <h3>Topics</h3>
          ${topics}
        </section>
        ${continuationSection}
      `;
    } else {
      setText(summaryBlock, summaryText, 'Summary will appear once processing is complete.');
    }
    setText(transcriptBlock, data?.transcript, 'Transcript is still processing.');
  } catch (err) {
    setText(summaryBlock, '', 'Summary will appear once processing is complete.');
    setText(transcriptBlock, '', 'Transcript is still processing.');
    recordingLoading.textContent = 'Failed to load session metadata.';
    console.error('Failed to fetch summary/transcript:', err);
  }
}

document.getElementById('close-view').addEventListener('click', () => window.close());

init();
