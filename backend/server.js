import fs from "fs";
import path from "path";
import express from "express";
import multer from "multer";
import sqlite3 from "sqlite3";
import { createClient } from "@deepgram/sdk";
import fetch from "node-fetch";
import crypto from "crypto";
import { fileURLToPath } from "url";
import * as chrono from "chrono-node";
import nodemailer from "nodemailer";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

/* =======================
   ENV VALIDATION
======================= */
const REQUIRED_ENV_VARS = [
  "DEEPGRAM_API_KEY",
  "OPENAI_API_KEY",
  "EMAIL_SMTP_HOST",
  "EMAIL_SMTP_PORT",
  "EMAIL_SMTP_USER",
  "EMAIL_SMTP_PASS"
];
for (const key of REQUIRED_ENV_VARS) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

/* =======================
   CONSTANTS & PATHS
======================= */
const PORT = process.env.PORT || 8080;
const DATA_DIR = path.join(__dirname, "data");
const RECORDINGS_DIR = path.join(DATA_DIR, "recordings");
const TRANSCRIPTS_DIR = path.join(DATA_DIR, "transcripts");
const SUMMARIES_DIR = path.join(DATA_DIR, "summaries");
const DB_PATH = path.join(DATA_DIR, "bmad.sqlite");
const EMAIL_FROM = process.env.EMAIL_FROM || "vermas21209@gmail.com";
const DEFAULT_NOTIFICATION_RECIPIENT = process.env.DEFAULT_NOTIFICATION_RECIPIENT || EMAIL_FROM;
const ASSIGNEE_EMAILS = (process.env.ASSIGNEE_EMAILS || "")
  .split(",")
  .map((pair) => pair.trim())
  .filter(Boolean)
  .reduce((map, pair) => {
    const [name, email] = pair.split(":").map((chunk) => chunk.trim());
    if (name && email) map[name.toLowerCase()] = email;
    return map;
  }, {});

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_SMTP_HOST,
  port: Number(process.env.EMAIL_SMTP_PORT),
  secure: process.env.EMAIL_SMTP_SECURE === "true",
  auth: {
    user: process.env.EMAIL_SMTP_USER,
    pass: process.env.EMAIL_SMTP_PASS
  }
});

fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
fs.mkdirSync(SUMMARIES_DIR, { recursive: true });

/* =======================
   DATABASE
======================= */
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS meeting_sessions (
      session_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      transcript TEXT,
      summary TEXT,
      numeric_session_id INTEGER,
      meeting_name TEXT,
      parent_session_id TEXT
    )
  `);

  const ensureMeetingSessionColumns = () => {
    db.all("PRAGMA table_info(meeting_sessions)", (err, columns) => {
      if (err) {
        console.error("Failed to inspect meeting_sessions schema:", err);
        return;
      }
      const existing = new Set(columns.map((col) => col.name));
      const required = [
        { name: "numeric_session_id", spec: "INTEGER" },
        { name: "meeting_name", spec: "TEXT" },
        { name: "parent_session_id", spec: "TEXT" }
      ];

      required.forEach((column) => {
        if (!existing.has(column.name)) {
          console.log(`Adding ${column.name} column to meeting_sessions table...`);
          db.run(
            `ALTER TABLE meeting_sessions ADD COLUMN ${column.name} ${column.spec}`,
            (alterErr) => {
              if (alterErr) {
                console.error(`Failed to add ${column.name} column:`, alterErr);
              } else {
                console.log(`Successfully added ${column.name} column`);
              }
            }
          );
        }
      });
    });
  };

  ensureMeetingSessionColumns();

  db.run(`
    CREATE TABLE IF NOT EXISTS meeting_insights (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      label TEXT NOT NULL CHECK (label IN ('Decision', 'Action Item', 'Important')),
      content TEXT NOT NULL,
      timestamp TEXT,
      FOREIGN KEY (session_id) REFERENCES meeting_sessions(session_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS meeting_participants (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT,
      FOREIGN KEY (session_id) REFERENCES meeting_sessions(session_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS meeting_speaker_map (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      speaker_label TEXT NOT NULL,
      participant_name TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES meeting_sessions(session_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS meeting_action_items (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      assignee TEXT NOT NULL,
      email TEXT,
      task_description TEXT NOT NULL,
      due_phrase TEXT,
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES meeting_sessions(session_id)
    )
  `);

  // Migration: Add email column to meeting_participants if it doesn't exist
  db.all("PRAGMA table_info(meeting_participants)", (err, columns) => {
    if (err) {
      console.error("Failed to check meeting_participants schema:", err);
      return;
    }
    const hasEmailColumn = columns.some(col => col.name === 'email');
    if (!hasEmailColumn) {
      console.log("Adding email column to meeting_participants table...");
      db.run("ALTER TABLE meeting_participants ADD COLUMN email TEXT", (alterErr) => {
        if (alterErr) {
          console.error("Failed to add email column:", alterErr);
        } else {
          console.log("Successfully added email column to meeting_participants");
        }
      });
    } else {
      console.log("meeting_participants table already has email column");
    }
  });
});

/* =======================
   DB HELPERS
======================= */
const run = (dbHandle, sql, params = []) =>
  new Promise((resolve, reject) =>
    dbHandle.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    })
  );

const get = (dbHandle, sql, params = []) =>
  new Promise((resolve, reject) =>
    dbHandle.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    })
  );

const all = (dbHandle, sql, params = []) =>
  new Promise((resolve, reject) =>
    dbHandle.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    })
  );

/* =======================
   DEEPGRAM
======================= */
function buildTranscript(result) {
  const utterances = result?.results?.utterances || [];
  if (utterances.length > 0) {
    const lines = [];
    let lastSpeaker = null;
    let buffer = [];
    let bufferStart = null;

    const formatTimestamp = (seconds) => {
      const total = Math.max(0, Math.floor(seconds || 0));
      const mins = String(Math.floor(total / 60)).padStart(2, "0");
      const secs = String(total % 60).padStart(2, "0");
      return `${mins}:${secs}`;
    };

    for (const utterance of utterances) {
      const speaker = Number.isInteger(utterance.speaker)
        ? `Speaker ${utterance.speaker + 1}`
        : "Speaker 1";
      if (lastSpeaker !== speaker) {
        if (buffer.length > 0) {
          lines.push(`[${formatTimestamp(bufferStart)}] ${lastSpeaker}: ${buffer.join(" ")}`);
        }
        buffer = [];
        bufferStart = utterance.start;
        lastSpeaker = speaker;
      }
      buffer.push(utterance.transcript);
    }

    if (buffer.length > 0) {
      lines.push(`[${formatTimestamp(bufferStart)}] ${lastSpeaker}: ${buffer.join(" ")}`);
    }

    return lines.join("\n");
  }
  const fallback = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
  if (fallback) {
    return `Speaker 1: ${fallback}`;
  }
  return "";
}

async function transcribeWithDeepgram(audioBuffer) {
  const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

  const { result, error } = await deepgram.listen.prerecorded.transcribeFile(audioBuffer, {
    model: process.env.DEEPGRAM_MODEL || "nova-2",
    smart_format: true,
    punctuate: true,
    mimetype: "audio/webm",
    utterances: true,
    diarize: true
  });

  if (error) throw error;

  const transcript = buildTranscript(result);
  console.log("Deepgram transcript length:", transcript.length);
  return transcript;
}

/* =======================
   OPENAI SUMMARY
======================= */
async function summarizeTranscript(transcriptText, context = {}) {
  if (!transcriptText || transcriptText.trim().length === 0) {
    console.warn("Empty transcript; skipping summarization.");
    return { summary: "", tasks: [], insights: [] };
  }

  const {
    previousSummary,
    previousActionItems,
    previousTranscript,
    speakerMap,
    previousSpeakerMap,
    previousStructuredSummary
  } = context;

  const actionItemsText =
    previousActionItems?.length > 0
      ? previousActionItems
          .map((item) =>
            `- ${item.task_description || item.task || "Unknown task"}${
              item.assignee ? ` (Assignee: ${item.assignee})` : ""
            }${item.due_phrase ? `; due ${item.due_phrase}` : ""}${item.status ? `; status ${item.status}` : ""}`
          )
          .join("\n")
      : "";

  const trimmedPreviousTranscript = previousTranscript
    ? previousTranscript.length > 2000
      ? `${previousTranscript.slice(0, 2000)}...`
      : previousTranscript
    : "";

  const continuationContext = [];
  if (previousSummary) {
    continuationContext.push(`Previous meeting summary:\n${previousSummary}`);
  }
  if (actionItemsText) {
    continuationContext.push(`Previous action items:\n${actionItemsText}`);
  }
  if (trimmedPreviousTranscript) {
    continuationContext.push(`Previous meeting transcript excerpt:\n${trimmedPreviousTranscript}`);
  }

  const speakerLines = [];
  const formatMap = (map) =>
    Object.entries(map || {})
      .map(([label, name]) => `${label} = ${name}`)
      .join(", ");

  if (speakerMap && Object.keys(speakerMap).length > 0) {
    speakerLines.push(`Current speaker map: ${formatMap(speakerMap)}`);
  }

  if (previousSpeakerMap && Object.keys(previousSpeakerMap).length > 0) {
    speakerLines.push(`Previous speaker map: ${formatMap(previousSpeakerMap)}`);
  }

  if (speakerLines.length > 0) {
    continuationContext.push(speakerLines.join("\n"));
  }

  const contextPayload = continuationContext.length > 0 ? continuationContext.join("\n\n") : "";
  const continuationDirective = previousStructuredSummary || previousSummary
    ? "This is a follow-up meeting. Update progress, highlight changes since the prior session, and avoid repeating previously completed work."
    : "Summarize the meeting as a standalone session.";

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
        "You are a meeting assistant that outputs structured JSON. Only use the names supplied via the speaker map; do not invent other names. When no map is provided, call participants Speaker 1, Speaker 2, etc. Always respond with the exact schema described in the follow-up message and nothing extra."
      },
      {
        role: "user",
        content: `${continuationDirective}\n\n${contextPayload ? contextPayload + "\n\n" : ""}Current meeting transcript:\n${transcriptText}\n\nReturn JSON with this structure:\n{\n  "main_task": "Short summary of the primary topic",\n  "subtasks": [\"Sub-task description\", \"Sub-task description\"],\n  "action_items_by_assignee": {\n    \"Deepthi\": [\"Fix RentVsBuy UI layout issues\", \"Update pricing component responsiveness\"],\n    \"Rahul\": [\"Review API changes\"]\n  },\n  "continuation": {\n    "progress": \"Progress description\",\n    "completed": [\"Item done since last meeting\"],\n    "next_steps": [\"Next step 1\", \"Next step 2\"],\n    "time_elapsed_days": 3,\n    "estimated_remaining_days": 2,\n    "blockers": [\"Blocker text\"],\n    "help_needed": [\"Help text\"]\n  }\n}`
      }
    ]
  })
});

const payload = await response.json();
const content = payload?.choices?.[0]?.message?.content || "{}";
let parsed;
try {
  parsed = JSON.parse(content);
} catch (err) {
  console.error("Failed to parse summarization JSON:", err, content);
  parsed = {};
}

const mainTask = parsed?.main_task || parsed?.summary || "Meeting summary";
const subtasks = Array.isArray(parsed?.subtasks) ? parsed.subtasks : [];
const actionItemsByAssignee = parsed?.action_items_by_assignee || {};
const continuation = parsed?.continuation || null;

const summaryLines = [`Main Task: ${mainTask}`];
if (subtasks.length > 0) {
  summaryLines.push("Subtasks:");
  subtasks.forEach((subtask) => {
    summaryLines.push(`- ${subtask}`);
  });
}
if (continuation) {
  if (continuation.progress) {
    summaryLines.push(`Progress Update:\n- ${continuation.progress}`);
  }
  if (Array.isArray(continuation.completed) && continuation.completed.length > 0) {
    summaryLines.push("Completed Since Last Meeting:");
    continuation.completed.forEach((item) => summaryLines.push(`- ${item}`));
  }
  if (Array.isArray(continuation.next_steps) && continuation.next_steps.length > 0) {
    summaryLines.push("Next Steps:");
    continuation.next_steps.forEach((item) => summaryLines.push(`- ${item}`));
  }
  const timeline = [];
  if (typeof continuation.time_elapsed_days === "number") {
    timeline.push(`Time elapsed: ${continuation.time_elapsed_days} days`);
  }
  if (typeof continuation.estimated_remaining_days === "number") {
    timeline.push(`Estimated remaining: ${continuation.estimated_remaining_days} days`);
  }
  if (timeline.length > 0) {
    summaryLines.push(`Timeline:\n- ${timeline.join("\n- ")}`);
  }
  if (Array.isArray(continuation.blockers) && continuation.blockers.length > 0) {
    summaryLines.push("Blockers / Help Needed:");
    continuation.blockers.forEach((item) => summaryLines.push(`- ${item}`));
  }
  if (Array.isArray(continuation.help_needed) && continuation.help_needed.length > 0) {
    summaryLines.push("Help Needed:");
    continuation.help_needed.forEach((item) => summaryLines.push(`- ${item}`));
  }
}

const summaryText = summaryLines.join("\n");
const tasks = subtasks.map((task) => ({ title: task, description: "" }));
const insights = Object.entries(actionItemsByAssignee).flatMap(([assignee, list]) =>
  (Array.isArray(list) ? list : []).map((task) => ({
    label: "Action Item",
    content: `${task} (${assignee})`
  }))
);

return {
  summary: summaryText,
  tasks,
  insights,
  structuredSummary: {
    mainTask,
    subtasks,
    actionItemsByAssignee,
    continuation
  }
};
}

async function extractActionItems(transcriptText) {
  if (!transcriptText || transcriptText.trim().length === 0) {
    return [];
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You are a meeting assistant. Return a JSON array called action_items with objects containing assignee (name), task, and due_phrase." 
        },
        {
          role: "user",
          content: `Transcript:\n${transcriptText}`
        }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "actionItemsResponse",
          schema: {
            type: "object",
            properties: {
              action_items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    assignee: { type: "string" },
                    task: { type: "string" },
                    due_phrase: { type: "string" }
                  },
                  required: ["task"]
                }
              }
            },
            required: ["action_items"]
          }
        }
      }
    })
  });

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  
  if (!content) {
    console.log("[ACTION_ITEMS] No content in response, returning empty array");
    return [];
  }
  
  try {
    const parsed = JSON.parse(content);
    if (!parsed || !parsed.action_items || !Array.isArray(parsed.action_items)) {
      console.log("[ACTION_ITEMS] Invalid structure in parsed content:", parsed);
      return [];
    }
    
    const items = parsed.action_items.map((item) => ({
      assignee: item.assignee || "TBD",
      task: item.task,
      due_phrase: item.due_phrase || null
    }));
    
    console.log(`[ACTION_ITEMS] Successfully extracted ${items.length} action items`);
    return items;
  } catch (parseErr) {
    console.error("[ACTION_ITEMS] Failed to parse action items JSON:", parseErr.message);
    console.error("[ACTION_ITEMS] Raw content:", content);
    return [];
  }
}

function resolveDueDate(phrase, reference = new Date()) {
  if (!phrase) return null;
  const parsed = chrono.parseDate(phrase, reference);
  return parsed ? parsed.toISOString() : null;
}

async function saveActionItems(sessionId, items) {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    "INSERT INTO meeting_action_items (id, session_id, assignee, email, task_description, due_phrase, due_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  for (const item of items) {
    const assigneeKey = (item.assignee || "TBD").toLowerCase();
    const email = ASSIGNEE_EMAILS[assigneeKey] || DEFAULT_NOTIFICATION_RECIPIENT;
    const dueDate = resolveDueDate(item.due_phrase, new Date());
    stmt.run(
      crypto.randomUUID(),
      sessionId,
      item.assignee,
      email,
      item.task,
      item.due_phrase,
      dueDate,
      "open",
      now
    );
  }
  stmt.finalize();
}

async function notifyActionItems(sessionId, items) {
  console.log(`[EMAIL] notifyActionItems called for session ${sessionId} with ${items.length} items`);
  
  if (!transporter || items.length === 0) {
    console.log(`[EMAIL] Skipping - transporter exists: ${!!transporter}, items count: ${items.length}`);
    return;
  }
  
  // Get all participants for this session
  const participants = await all(
    db,
    "SELECT name, email FROM meeting_participants WHERE session_id=?",
    [sessionId]
  );
  
  console.log(`[EMAIL] Found ${participants.length} participants:`, participants);
  
  // For single participant meetings, send all action items to that participant
  // For multi-participant meetings, match assignee names with participants
  let singleParticipantEmail = null;
  if (participants.length === 1 && participants[0].email) {
    singleParticipantEmail = participants[0].email;
    console.log(`[EMAIL] Single participant detected, all action items will go to: ${singleParticipantEmail}`);
  }
  
  // Build a map of participant names to emails (for multi-participant meetings)
  const participantMap = {};
  for (const p of participants) {
    participantMap[p.name.toLowerCase()] = p.email;
  }

  console.log(`[EMAIL] Participant map:`, participantMap);
  console.log(`[EMAIL] Default recipient:`, DEFAULT_NOTIFICATION_RECIPIENT);

  for (const item of items) {
    // For single participant, send to that participant; otherwise match assignee
    let recipient;
    if (singleParticipantEmail) {
      recipient = singleParticipantEmail;
      console.log(`[EMAIL] Single participant mode: using participant email`);
    } else {
      const assigneeKey = (item.assignee || "").toLowerCase();
      recipient = participantMap[assigneeKey] || DEFAULT_NOTIFICATION_RECIPIENT;
      console.log(`[EMAIL] Multi-participant mode: assignee="${item.assignee}", key="${assigneeKey}", recipient="${recipient}"`);
    }
    
    // Skip sending if no valid email found and no default recipient
    if (!recipient) {
      console.warn(`[EMAIL] No email found for assignee: ${item.assignee}`);
      continue;
    }
    
    const dueDate = resolveDueDate(item.due_phrase, new Date());
    const dueLabel = dueDate
      ? `Due date: ${new Date(dueDate).toLocaleDateString()}`
      : item.due_phrase || "No explicit due date";

    const subject = `Action item from session ${sessionId}`;
    const body = `
The following action item was extracted from your meeting:

Task: ${item.task}
Assignee: ${item.assignee}
${dueLabel}

View the session: http://localhost:8080/api/sessions/${sessionId}
`;

    try {
      console.log(`[EMAIL] Sending email to ${recipient} for task: "${item.task}"`);
      await transporter.sendMail({
        from: EMAIL_FROM,
        to: recipient,
        subject,
        text: body
      });
      console.log(`[EMAIL] Successfully sent email to ${recipient}`);
    } catch (emailError) {
      console.error(`[EMAIL] Failed to send email to ${recipient}:`, emailError.message);
    }
  }
}

/* =======================
   EXPRESS APP
======================= */
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

async function allocateNextNumericSessionId() {
  const row = await get(db, "SELECT MAX(numeric_session_id) as maxId FROM meeting_sessions");
  return (row?.maxId || 0) + 1;
}

async function loadPreviousMeetingContext(parentSessionId) {
  if (!parentSessionId) return null;
  try {
    const session = await get(
      db,
      "SELECT summary FROM meeting_sessions WHERE session_id=?",
      [parentSessionId]
    );
    if (!session) return null;

    let previousSummary = "";
    let previousStructuredSummary = null;
    if (session.summary) {
      try {
        const parsed = JSON.parse(session.summary);
        if (parsed && typeof parsed === "object") {
          previousSummary = parsed?.summary || session.summary;
          previousStructuredSummary = parsed?.structuredSummary || null;
        } else {
          previousSummary = session.summary;
        }
      } catch {
        previousSummary = session.summary;
      }
    }

    const previousActionItems = await all(
      db,
      "SELECT assignee, task_description, due_phrase, status FROM meeting_action_items WHERE session_id=?",
      [parentSessionId]
    );

    let previousTranscript = "";
    try {
      previousTranscript = await fs.promises.readFile(
        path.join(TRANSCRIPTS_DIR, `${parentSessionId}.txt`),
        "utf8"
      );
    } catch (err) {
      console.warn(`Unable to load transcript for ${parentSessionId}:`, err?.message || err);
    }

    return {
      previousSummary,
      previousStructuredSummary,
      previousActionItems,
      previousTranscript
    };
  } catch (err) {
    console.error("Failed to load previous meeting context:", err);
    return null;
  }
}

async function loadSpeakerMap(sessionId) {
  if (!sessionId) return {};
  const entries = await all(
    db,
    "SELECT speaker_label, participant_name FROM meeting_speaker_map WHERE session_id=?",
    [sessionId]
  );
  return entries.reduce((map, row) => {
    if (row?.speaker_label && row?.participant_name) {
      map[row.speaker_label] = row.participant_name;
    }
    return map;
  }, {});
}

function formatSessionId(numericId) {
  return String(numericId).padStart(3, "0");
}

async function processRecording(audioBuffer, parentSessionId = null, meetingName = null, sessionId = null, numericSessionId = null) {
  const resolvedNumericId = numericSessionId || (await allocateNextNumericSessionId());
  const resolvedSessionId = sessionId || formatSessionId(resolvedNumericId);

  await run(
    db,
    "INSERT OR IGNORE INTO meeting_sessions (session_id, created_at, numeric_session_id, meeting_name, parent_session_id) VALUES (?, ?, ?, ?, ?)",
    [resolvedSessionId, new Date().toISOString(), resolvedNumericId, meetingName, parentSessionId]
  );

  const filePath = path.join(RECORDINGS_DIR, `${resolvedSessionId}.webm`);
  await fs.promises.writeFile(filePath, audioBuffer);

  const transcript = await transcribeWithDeepgram(audioBuffer);
  await run(db, "UPDATE meeting_sessions SET transcript=? WHERE session_id=?", [
    transcript,
    resolvedSessionId
  ]);
  await fs.promises.writeFile(
    path.join(TRANSCRIPTS_DIR, `${resolvedSessionId}.txt`),
    transcript,
    "utf8"
  );

  const previousContext = parentSessionId
    ? (await loadPreviousMeetingContext(parentSessionId)) || {}
    : {};
  const currentSpeakerMap = await loadSpeakerMap(resolvedSessionId);
  const previousSpeakerMap = parentSessionId ? await loadSpeakerMap(parentSessionId) : {};
  const context = {
    ...previousContext,
    speakerMap: currentSpeakerMap,
    previousSpeakerMap
  };
  const { summary: summaryText, tasks, insights, structuredSummary } = await summarizeTranscript(
    transcript,
    context
  );
  const summaryRecord = JSON.stringify({
    summary: summaryText,
    structuredSummary
  });
  await run(db, "UPDATE meeting_sessions SET summary=? WHERE session_id=?", [
    summaryRecord,
    resolvedSessionId
  ]);
  await fs.promises.writeFile(
    path.join(SUMMARIES_DIR, `${resolvedSessionId}.json`),
    JSON.stringify({ summary: summaryText, tasks, insights, structuredSummary }, null, 2),
    "utf8"
  );

  const actionItems = await extractActionItems(transcript);
  if (actionItems.length > 0) {
    await saveActionItems(resolvedSessionId, actionItems);
    await notifyActionItems(resolvedSessionId, actionItems);
  }

  return { transcript, insights };
}

function applySpeakerMap(text, map) {
  if (!text) return text;
  let updated = text;
  for (const [speaker, name] of Object.entries(map)) {
    if (!speaker || !name) continue;
    const safeSpeaker = speaker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${safeSpeaker}\\b`, "g");
    updated = updated.replace(regex, name);
  }
  return updated;
}

/* =======================
   RECORDING ENDPOINTS
======================= */
app.post("/upload", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "Missing audio file." });
    return;
  }

  const meetingName = req.body?.meetingName ? String(req.body.meetingName).trim() : null;
  const parentSessionId = req.body?.parentSessionId ? String(req.body.parentSessionId).trim() : null;

  try {
    const numericSessionId = await allocateNextNumericSessionId();
    const sessionId = formatSessionId(numericSessionId);
    const { transcript, insights } = await processRecording(
      req.file.buffer,
      parentSessionId,
      meetingName,
      sessionId,
      numericSessionId
    );
    res.json({
      status: "completed",
      session_id: sessionId,
      sessionId: sessionId,
      transcript_length: transcript.length,
      insights_count: insights?.length || 0
    });
  } catch (err) {
    console.error("Processing failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post(
  "/api/sessions/:sessionId/recording",
  express.raw({ type: "*/*", limit: "200mb" }),
  async (req, res) => {
    const sessionId = req.params.sessionId;

    try {
      const numericSessionId = /^\d+$/.test(sessionId) ? Number(sessionId) : null;
      const { transcript, insights } = await processRecording(
        req.body,
        null,
        null,
        sessionId,
        numericSessionId
      );
      res.json({
        status: "completed",
        session_id: sessionId,
        transcript_length: transcript.length,
        insights_count: insights?.length || 0
      });
    } catch (err) {
      console.error("Processing failed:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

app.post("/api/sessions/:id/participants", express.json(), async (req, res) => {
  const sessionId = req.params.id;
  
  // Validate session exists
  const session = await get(db, "SELECT session_id FROM meeting_sessions WHERE session_id=?", [sessionId]);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  const participants = req.body?.participants || [];
  
  if (!Array.isArray(participants) || participants.length === 0) {
    return res.status(400).json({ error: "Participants must be a non-empty array" });
  }
  
  // participants can be: ["Alice", "Bob"] or [{name: "Alice", email: "alice@example.com"}, ...]
  const cleaned = participants
    .map((p) => {
      if (typeof p === "string") {
        const name = p.trim();
        if (!name || name.length < 1 || name.length > 100) return null;
        return { name, email: null };
      }
      if (typeof p === "object" && p && p.name) {
        const name = String(p.name).trim();
        const email = p.email ? String(p.email).trim() : null;
        
        // Validate name
        if (!name || name.length < 1 || name.length > 100) return null;
        
        // Validate email if provided
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          console.warn(`Invalid email format: ${email}, skipping email for ${name}`);
          return { name, email: null };
        }
        
        return { name, email };
      }
      return null;
    })
    .filter(Boolean);

  if (cleaned.length === 0) {
    return res.status(400).json({ error: "No valid participants to save" });
  }

  try {
    await run(db, "DELETE FROM meeting_participants WHERE session_id=?", [sessionId]);
    
    for (const participant of cleaned) {
      await run(
        db,
        "INSERT INTO meeting_participants (id, session_id, name, email) VALUES (?, ?, ?, ?)",
        [crypto.randomUUID(), sessionId, participant.name, participant.email || null]
      );
    }
    
    console.log(`Saved ${cleaned.length} participants for session ${sessionId}`);
    
    // Re-send action item emails now that participants are saved
    console.log(`Re-sending action item emails for session ${sessionId}...`);
    try {
      const actionItems = await all(
        db,
        "SELECT id, assignee, task_description as task, due_phrase FROM meeting_action_items WHERE session_id=?",
        [sessionId]
      );
      if (actionItems.length > 0) {
        await notifyActionItems(sessionId, actionItems);
        console.log(`Sent emails for ${actionItems.length} action items`);
      } else {
        console.log(`No action items found for session ${sessionId}`);
      }
    } catch (emailErr) {
      console.warn(`Failed to re-send emails after saving participants:`, emailErr);
      // Don't fail the request if email sending fails
    }
    
    res.json({ status: "ok", count: cleaned.length });
  } catch (err) {
    console.error("Failed to save participants:", err);
    console.error("Session ID:", sessionId);
    console.error("Cleaned participants:", cleaned);
    console.error("Error stack:", err.stack);
    res.status(500).json({ error: "Failed to save participants", detail: err.message });
  }
});

app.post("/api/sessions/:id/speaker-map", express.json(), async (req, res) => {
  const sessionId = req.params.id;
  const map = req.body?.map && typeof req.body.map === "object" ? req.body.map : {};

  try {
    await run(db, "DELETE FROM meeting_speaker_map WHERE session_id=?", [sessionId]);
    for (const [speakerLabel, participantName] of Object.entries(map)) {
      if (!speakerLabel || !participantName) continue;
      await run(
        db,
        "INSERT INTO meeting_speaker_map (id, session_id, speaker_label, participant_name) VALUES (?, ?, ?, ?)",
        [crypto.randomUUID(), sessionId, speakerLabel, participantName]
      );
    }

    const session = await get(
      db,
      "SELECT transcript, summary FROM meeting_sessions WHERE session_id=?",
      [sessionId]
    );

    const mappedTranscript = applySpeakerMap(session?.transcript || "", map);
    const mappedSummary = applySpeakerMap(session?.summary || "", map);

    await run(db, "UPDATE meeting_sessions SET transcript=?, summary=? WHERE session_id=?", [
      mappedTranscript,
      mappedSummary,
      sessionId
    ]);

    const insights = await all(
      db,
      "SELECT id, content FROM meeting_insights WHERE session_id=?",
      [sessionId]
    );
    for (const insight of insights) {
      const updatedContent = applySpeakerMap(insight.content, map);
      await run(db, "UPDATE meeting_insights SET content=? WHERE id=?", [
        updatedContent,
        insight.id
      ]);
    }

    await fs.promises.writeFile(
      path.join(TRANSCRIPTS_DIR, `${sessionId}.txt`),
      mappedTranscript,
      "utf8"
    );
    
    // Read existing summary file to preserve tasks and insights, update summary text
    let summaryData = { summary: mappedSummary, tasks: [], insights: {} };
    try {
      const existingSummary = await fs.promises.readFile(
        path.join(SUMMARIES_DIR, `${sessionId}.json`),
        "utf8"
      );
      const existing = JSON.parse(existingSummary);
      summaryData.tasks = existing.tasks || [];
      summaryData.insights = existing.insights || {};
    } catch (err) {
      console.warn("Could not read existing summary file:", err.message);
    }
    
    await fs.promises.writeFile(
      path.join(SUMMARIES_DIR, `${sessionId}.json`),
      JSON.stringify(summaryData, null, 2),
      "utf8"
    );

    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ error: "Failed to apply speaker map", detail: err.message });
  }
});

app.get("/api/meetings/check-name", async (req, res) => {
  const rawName = req.query?.name ? String(req.query.name).trim() : "";
  if (!rawName) {
    return res.status(400).json({ error: "Meeting name is required" });
  }

  try {
    const session = await get(
      db,
      "SELECT session_id FROM meeting_sessions WHERE LOWER(meeting_name) = ? ORDER BY created_at DESC LIMIT 1",
      [rawName.toLowerCase()]
    );
    res.json({
      exists: Boolean(session),
      lastSessionId: session?.session_id || null
    });
  } catch (err) {
    console.error("Failed to check meeting name:", err);
    res.status(500).json({ error: "Failed to check meeting name" });
  }
});

app.get("/api/sessions/latest", async (_, res) => {
  try {
    const session = await get(
      db,
      "SELECT session_id, summary, created_at, meeting_name FROM meeting_sessions ORDER BY created_at DESC LIMIT 1"
    );
    res.json(session || null);
  } catch (err) {
    console.error("Failed to fetch latest session:", err);
    res.status(500).json({ error: "Failed to fetch latest session" });
  }
});

/* =======================
   READ APIS
======================= */
app.get("/api/sessions", async (_, res) => {
  const sessions = await all(
    db,
    "SELECT session_id, created_at, summary FROM meeting_sessions ORDER BY created_at DESC"
  );
  res.json({ sessions });
});

app.get("/api/sessions/:id", async (req, res) => {
  const session = await get(
    db,
    "SELECT * FROM meeting_sessions WHERE session_id=?",
    [req.params.id]
  );
  res.json(session);
});

app.get("/recordings/:sessionId", async (req, res) => {
  const filePath = path.join(RECORDINGS_DIR, `${req.params.sessionId}.webm`);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Recording not found." });
    return;
  }
  res.setHeader("Content-Type", "audio/webm");
  res.sendFile(filePath);
});

app.get("/summaries/:sessionId", async (req, res) => {
  const filePath = path.join(SUMMARIES_DIR, `${req.params.sessionId}.json`);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Summary not found." });
    return;
  }
  res.setHeader("Content-Type", "application/json");
  res.sendFile(filePath);
});

/* =======================
   START SERVER
======================= */
app.listen(PORT, () =>
  console.log(`BMAD backend listening on http://localhost:${PORT}`)
);
