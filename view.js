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
    let summaryPayload = null;

    if (typeof summaryText === 'object' && summaryText !== null) {
      summaryPayload = summaryText.summary || summaryText;
    } else if (typeof summaryText === 'string') {
      try {
        const parsedSummary = JSON.parse(summaryText);
        if (parsedSummary && typeof parsedSummary.summary === 'object' && parsedSummary.summary !== null) {
          summaryPayload = parsedSummary.summary;
        }
      } catch (e) {
        summaryPayload = null;
      }
    }

    if (summaryPayload && typeof summaryPayload === 'object') {
      const header = summaryPayload.title ? `
        <div class="summary-header">
          <h2>${summaryPayload.title}</h2>
          <p>${summaryPayload.date} • ${summaryPayload.duration}</p>
          ${summaryPayload.view_recording ? `<a href="${summaryPayload.view_recording}" target="_blank">View Recording</a>` : ''}
        </div>
      ` : '';

      const actionItems = buildActionItemsHtml(summaryPayload.action_items);
      const meetingPurpose = summaryPayload.meeting_summary?.meeting_purpose
        ? `<p>${summaryPayload.meeting_summary.meeting_purpose}</p>`
        : '<p class="empty">Meeting purpose not available.</p>';
      const keyTakeaways = (summaryPayload.meeting_summary?.key_takeaways || []).map(k => `<li>${k}</li>`).join('');
      const topics = buildTopicsHtml(summaryPayload.topics);
      const continuationSection = summaryPayload.continuation_summary
        ? `
          <div class="continuation-block">
            <h3>Continuation</h3>
            <ul>
              ${summaryPayload.continuation_summary.progress ? `<li>Progress: ${summaryPayload.continuation_summary.progress}</li>` : ''}
              ${summaryPayload.continuation_summary.completed?.length ? `<li>Completed: ${summaryPayload.continuation_summary.completed.join(', ')}</li>` : ''}
              ${summaryPayload.continuation_summary.next_steps?.length ? `<li>Next steps: ${summaryPayload.continuation_summary.next_steps.join(', ')}</li>` : ''}
              ${summaryPayload.continuation_summary.estimated_remaining_days ? `<li>Estimated remaining time: ${summaryPayload.continuation_summary.estimated_remaining_days} days</li>` : ''}
              ${summaryPayload.continuation_summary.blockers?.length ? `<li>Blockers: ${summaryPayload.continuation_summary.blockers.join(', ')}</li>` : ''}
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
      const fallbackSummary = typeof summaryText === 'object' ? JSON.stringify(summaryText) : summaryText;
      setText(summaryBlock, fallbackSummary, 'Summary will appear once processing is complete.');
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
