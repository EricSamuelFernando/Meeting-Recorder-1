const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { OpenAI } = require('openai');
const upload = multer({ dest: 'uploads/' });
const { initializeDatabase, getDb } = require('./backend/database');
const taskRoutes = require('./backend/tasks');
const { generateTaskContinuity } = require('./backend/taskContinuity');

const app = express();
app.use(cors());
app.use(express.json());
const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const defaultTaskDescription = (title) => {
    if (!title) return 'Discussed topics relevant to the meeting.';
    return `${title} was discussed and captured for follow-up.`;
};

function ensureTaskDescriptions(tasks = []) {
    tasks.forEach(task => {
        if (!task.description || !task.description.trim()) {
            task.description = defaultTaskDescription(task.title);
        }

        if (Array.isArray(task.subtasks)) {
            task.subtasks.forEach(subtask => {
                if (!subtask.description || !subtask.description.trim()) {
                    subtask.description = defaultTaskDescription(subtask.title);
                }
            });
        }
    });
}

function formatInsights(rawInsights = []) {
    return rawInsights.map((insight, index) => ({
        label: insight.label || 'Insight',
        content: `${index + 1}. ${((insight.content || '').toString()).replace(/^\d+\.\s*/, '').trim() || 'No detail provided.'}`
    }));
}

function normalizeStructuredSummary(structuredSummary = {}, fallbackSummary = '', isContinuation = false) {
    const normalized = { ...structuredSummary };
    const primaryText = fallbackSummary || '';
    normalized.mainTask = normalized.mainTask || primaryText.split('\n')[0] || 'Meeting recap';
    normalized.subtasks = Array.isArray(normalized.subtasks) ? normalized.subtasks : [];
    normalized.actionItemsByAssignee = normalized.actionItemsByAssignee || {};

    Object.entries(normalized.actionItemsByAssignee).forEach(([assignee, items]) => {
        normalized.actionItemsByAssignee[assignee] = Array.isArray(items) ? items : [items];
    });

    if (!isContinuation) {
        delete normalized.continuation;
    } else if (normalized.continuation && typeof normalized.continuation === 'object') {
        normalized.continuation.completed = Array.isArray(normalized.continuation.completed) ? normalized.continuation.completed : [];
        normalized.continuation.next_steps = Array.isArray(normalized.continuation.next_steps) ? normalized.continuation.next_steps : [];
        normalized.continuation.blockers = Array.isArray(normalized.continuation.blockers) ? normalized.continuation.blockers : [];
        normalized.continuation.help_needed = Array.isArray(normalized.continuation.help_needed) ? normalized.continuation.help_needed : [];
    }

    return normalized;
}

function buildActionItemsPayload(actionItemsByAssignee = {}) {
    return Object.entries(actionItemsByAssignee).map(([assignee, items]) => {
        const taskList = (Array.isArray(items) ? items : [items])
            .filter(Boolean)
            .map((item, idx) => `${idx + 1}. ${item}`);
        return {
            assignee,
            tasks: taskList
        };
    });
}

function parseOwnerFromDescription(description = '') {
    const match = description.match(/Owner:\s*([^,]+)/i);
    return match ? match[1].trim() : null;
}

function cleanTaskDescription(description = '') {
    return description
        .replace(/Owner:[^,|\\.]+[\\.,]?/i, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildProgressUpdateBullets(continuation = {}) {
    const bullets = [];

    if (continuation.progress) {
        bullets.push(`Progress: ${continuation.progress}`);
    }
    if (continuation.completed && continuation.completed.length) {
        bullets.push(`Completed: ${continuation.completed.join(', ')}`);
    }
    if (continuation.next_steps && continuation.next_steps.length) {
        bullets.push(`Next steps: ${continuation.next_steps.join(', ')}`);
    }
    if (continuation.estimated_remaining_days && continuation.estimated_remaining_days !== 'N/A') {
        bullets.push(`Estimated remaining time: ${continuation.estimated_remaining_days} days`);
    }
    if (continuation.blockers && continuation.blockers.length) {
        bullets.push(`Blockers: ${continuation.blockers.join(', ')}`);
    }
    if (continuation.help_needed && continuation.help_needed.length) {
        bullets.push(`Help needed: ${continuation.help_needed.join(', ')}`);
    }

    return bullets;
}

function buildTopicsPayload(tasks = [], structuredSummary, progressUpdateBullets = []) {
    const topicSources = tasks.length
        ? tasks
        : structuredSummary.subtasks.map(title => ({ title, description: 'Topic discussed.', subtasks: [] }));

    return topicSources.map((task, index) => {
        const topicTitle = task.title || `Topic ${index + 1}`;
        const owner = parseOwnerFromDescription(task.description);
        const bullets = [];
        const cleanedDescription = cleanTaskDescription(task.description || '');
        if (cleanedDescription) {
            bullets.push(cleanedDescription);
        }
        if (Array.isArray(task.subtasks)) {
            task.subtasks.forEach(subtask => {
                const line = subtask.title
                    ? `${subtask.title}: ${subtask.description || 'Details pending.'}`
                    : subtask.description || 'Subtask noted.';
                bullets.push(line);
            });
        }
        if (!bullets.length) {
            bullets.push('No further details were captured.');
        }

        const topic = {
            title: topicTitle,
            owner,
            bullets
        };

        if (progressUpdateBullets.length) {
            topic.progress_update = progressUpdateBullets;
        }

        return topic;
    });
}

function buildFathomSummaryObject({ structuredSummary, summaryText, sessionMeta, tasks = [], isContinuation }) {
    const meetingTitle = sessionMeta.meetingName || structuredSummary.mainTask || `Session ${sessionMeta.sessionId}`;
    const dateText = sessionMeta.meetingDate
        ? new Date(sessionMeta.meetingDate).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
        : new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
    const durationText = sessionMeta.duration || 'Duration not specified';
    const keyTakeaways = structuredSummary.subtasks.length
        ? structuredSummary.subtasks.slice(0, 4)
        : ['No key takeaways were captured.'];
    const actionItems = buildActionItemsPayload(structuredSummary.actionItemsByAssignee);
    const meetingPurpose = sessionMeta.meetingPurpose || structuredSummary.mainTask;
    const progressBullets = isContinuation ? buildProgressUpdateBullets(structuredSummary.continuation || {}) : [];
    const topics = buildTopicsPayload(tasks, structuredSummary, progressBullets);
    const continuationSummary = isContinuation && structuredSummary.continuation ? {
        progress: structuredSummary.continuation.progress || null,
        completed: structuredSummary.continuation.completed,
        next_steps: structuredSummary.continuation.next_steps,
        time_elapsed_days: structuredSummary.continuation.time_elapsed_days,
        estimated_remaining_days: structuredSummary.continuation.estimated_remaining_days,
        blockers: structuredSummary.continuation.blockers,
        help_needed: structuredSummary.continuation.help_needed
    } : null;

    return {
        title: meetingTitle,
        date: dateText,
        duration: durationText,
        view_recording: sessionMeta.viewRecordingUrl || null,
        action_items: actionItems,
        meeting_summary: {
            meeting_purpose: meetingPurpose,
            key_takeaways: keyTakeaways
        },
        topics,
        continuation_summary: continuationSummary
    };
}

async function aiSummarize(transcript, options = {}) {
    const {
        previousSummaryText = null,
        previousActionItems = [],
        isContinuation = false
    } = options;

    console.log('Summarizing transcript with OpenAI...');

    const previousSummarySection = previousSummaryText
        ? `Previous Summary:\n${previousSummaryText}`
        : 'Previous Summary: None';

    const previousActionSection = previousActionItems.length
        ? `Previous Action Items:\n${previousActionItems.map((item, index) => `${index + 1}. ${item}`).join('\n')}`
        : 'Previous Action Items: None';

    const continuationInstruction = isContinuation
        ? "This meeting is a continuation. Highlight progress, what was completed, any pivots, and how today's discussion links to the previous action items."
        : 'This is a first encounter. Focus on the main task, discussed topics, and actionable takeaways. Do not include continuation details.';

    const prompt = `
You are a structured meeting intelligence assistant. Do not invent participant names that are missing from the transcript or previous summary.

${previousSummarySection}
${previousActionSection}

${continuationInstruction}

Current Transcript:
${transcript}

### OUTPUT FORMAT
Return JSON with the following structure:
{
  "summary": "A detailed paragraph explaining what the meeting was about in human terms.",
  "structuredSummary": {
    "mainTask": "Clear description of the overarching task or topic",
    "subtasks": ["List", "of", "subtasks"],
    "actionItemsByAssignee": {
      "Person": [
        "Numbered action item 1",
        "Numbered action item 2"
      ]
    },
    "continuation": {
      "progress": "What progress was made relative to the prior meeting",
      "completed": ["Completed item"],
      "next_steps": ["Next steps"],
      "time_elapsed_days": 0,
      "estimated_remaining_days": 0,
      "blockers": ["List blockers"],
      "help_needed": ["List help needed"]
    }
  },
  "tasks": [
    {
      "title": "Task title",
      "description": "At least one line describing what's expected.",
      "subtasks": [
        {
          "title": "Subtask title",
          "description": "Sentence about the subtask"
        }
      ]
    }
  ],
  "insights": [
    {
      "label": "Action Item",
      "content": "1. Description of the action item"
    }
  ]
}

Only include the continuation object when this is a continuation meeting; omit it entirely otherwise. Always number subtasks and insight entries, and keep descriptions expressive. Maintain a professional, executive tone.
`;

    try {
        const completion = await openaiClient.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'You are a helpful assistant that outputs JSON.' },
                { role: 'user', content: prompt }
            ],
            response_format: { type: 'json_object' }
        });

        const responseContent = completion.choices[0].message.content;
        const response = JSON.parse(responseContent);

        const tasks = Array.isArray(response.tasks) ? response.tasks : [];
        ensureTaskDescriptions(tasks);

        const insights = formatInsights(Array.isArray(response.insights) ? response.insights : []);
        const structuredSummary = normalizeStructuredSummary(response.structuredSummary, response.summary, isContinuation);
        const summaryText = response.summary || structuredSummary.mainTask;

        return {
            summary: summaryText,
            tasks,
            insights,
            structuredSummary
        };
    } catch (error) {
        console.error('OpenAI Summarization Error:', error);
        return {
            summary: 'Failed to generate summary via AI.',
            tasks: [],
            insights: [],
            structuredSummary: {}
        };
    }
}

async function summarizeTranscriptAndTrackProgress(transcript, sessionId, options = {}) {
    const {
        parentSessionId = null,
        meetingName = null,
        meetingDate = null,
        duration = null,
        viewRecordingUrl = null,
        meetingPurpose = null
    } = options;

    const db = getDb();
    const isContinuation = Boolean(parentSessionId);
    let previousSummaryText = null;
    let previousActionItems = [];

    if (isContinuation) {
        const parentSession = await db.get('SELECT summary FROM meeting_sessions WHERE session_id = ?', [parentSessionId]);
        if (parentSession && parentSession.summary) {
            try {
                const parsed = JSON.parse(parentSession.summary);
                if (parsed.summary_text) {
                    previousSummaryText = parsed.summary_text;
                } else if (parsed.summary && typeof parsed.summary === 'string') {
                    previousSummaryText = parsed.summary;
                } else if (parsed.summary && parsed.summary.meeting_summary && parsed.summary.meeting_summary.meeting_purpose) {
                    previousSummaryText = parsed.summary.meeting_summary.meeting_purpose;
                }
                const actionItemsSet = new Set();

                if (parsed.structuredSummary && parsed.structuredSummary.actionItemsByAssignee) {
                    Object.entries(parsed.structuredSummary.actionItemsByAssignee).forEach(([assignee, items]) => {
                        if (Array.isArray(items)) {
                            items.forEach(item => {
                                if (item) actionItemsSet.add(`${assignee}: ${item}`);
                            });
                        }
                    });
                }

                if (Array.isArray(parsed.tasks)) {
                    parsed.tasks.forEach(task => {
                        if (task && task.title) actionItemsSet.add(task.title);
                    });
                }

                previousActionItems = Array.from(actionItemsSet).slice(0, 25);
                if (previousActionItems.length > 0) {
                    console.log('Recalling previous action items for context:', previousActionItems);
                }
            } catch (error) {
                console.log('Could not parse parent summary', error);
            }
        }
    }

    const { summary, tasks, insights, structuredSummary } = await aiSummarize(transcript, {
        previousSummaryText,
        previousActionItems,
        isContinuation
    });

    const taskContinuity = await generateTaskContinuity(sessionId, tasks);

    const sessionMeta = {
        sessionId,
        meetingName,
        meetingDate,
        duration,
        viewRecordingUrl,
        meetingPurpose
    };

    const summaryObject = buildFathomSummaryObject({
        structuredSummary,
        summaryText: summary,
        sessionMeta,
        tasks,
        isContinuation
    });

    const enhancedSummary = {
        summary: summaryObject,
        summary_text: summary,
        tasks,
        insights,
        structuredSummary,
        taskContinuity
    };

    await db.run(
        'UPDATE meeting_sessions SET summary = ? WHERE session_id = ?',
        [JSON.stringify(enhancedSummary), sessionId]
    );

    return enhancedSummary;
}

async function createSequentialSessionId() {
    const db = getDb();
    const row = await db.get('SELECT MAX(numeric_session_id) as maxId FROM meeting_sessions');
    const maxId = row && row.maxId ? Number(row.maxId) : 0;
    const nextNumericId = Number.isFinite(maxId) ? maxId + 1 : 1;
    const sessionId = nextNumericId.toString().padStart(3, '0');
    return { sessionId, numericSessionId: nextNumericId };
}

// --- API Endpoints ---

app.use('/api/tasks', taskRoutes);

// GET /api/sessions/:id - Retrieve session details for the view
app.get('/api/sessions/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const db = getDb();
        const session = await db.get('SELECT * FROM meeting_sessions WHERE session_id = ?', [id]);
        if (!session) {
            return res.status(404).json({ message: 'Session not found' });
        }
        res.json(session);
    } catch (error) {
        console.error('Error fetching session:', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});

// GET /api/sessions/latest - Retrieve the most recent session for the "Continuation" prompt
app.get('/api/sessions/latest', async (req, res) => {
    try {
        const db = getDb();
        const session = await db.get('SELECT session_id, summary, created_at FROM meeting_sessions ORDER BY created_at DESC LIMIT 1');
        res.json(session || null);
    } catch (error) {
        console.error('Error fetching latest session:', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});

// NEW: Handle the extension's file upload
app.post('/upload', upload.single('audio'), async (req, res) => {
    try {
        console.log('Audio file received from extension.');

        const db = getDb();
        const { sessionId, numericSessionId } = await createSequentialSessionId();
        const parentSessionId = req.body.parentSessionId || null;

        const countResult = await db.get('SELECT count(*) as count FROM meeting_sessions');
        const isFirstMeeting = countResult.count === 0;

        console.log(isFirstMeeting ? 'Simulating Meeting 1 (Kickoff)' : 'Simulating Meeting 2 (Progress Update/Continuation)');
        console.log(`Assigned session ID ${sessionId} (numeric ${numericSessionId}).`);
        if (parentSessionId) console.log(`User linked to parent session: ${parentSessionId}`);

        const mockTranscript = (isFirstMeeting && !parentSessionId)
            ? 'We are starting the project. We need to build a meeting recorder and set up the database.'
            : 'The recorder is built. Now we need to add multi-participant support and complete the task extraction feature.';

        await db.run(
            'INSERT INTO meeting_sessions (session_id, numeric_session_id, created_at, transcript, summary, parent_session_id) VALUES (?, ?, ?, ?, ?, ?)',
            [sessionId, numericSessionId, new Date().toISOString(), mockTranscript, '{}', parentSessionId]
        );

        const result = await summarizeTranscriptAndTrackProgress(mockTranscript, sessionId, {
            parentSessionId,
            meetingName: req.body.meetingName,
            meetingDate: req.body.meetingDate || new Date().toISOString(),
            duration: req.body.duration,
            viewRecordingUrl: req.body.viewRecordingUrl,
            meetingPurpose: req.body.meetingPurpose
        });

        res.json({ success: true, sessionId, ...result });
    } catch (error) {
        console.error('Upload processing error:', error);
        res.status(500).json({ error: 'Processing failed' });
    }
});

// This endpoint triggers the summary + continuity process.
app.post('/api/sessions/:id/summarize', async (req, res) => {
    try {
        const { id: sessionId } = req.params;
        const { transcript } = req.body;
        if (!transcript) {
            return res.status(400).json({ message: 'Transcript is required.' });
        }
        const enhancedSummary = await summarizeTranscriptAndTrackProgress(transcript, sessionId, {});
        res.json(enhancedSummary);
    } catch (error) {
        console.error('Error in summarization process:', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});

const PORT = 8080;
async function startServer() {
    await initializeDatabase();
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}

startServer();
