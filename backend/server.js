import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import express from "express";
import multer from "multer";
import sqlite3 from "sqlite3";
import { createClient } from "@deepgram/sdk";
import fetch from "node-fetch";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =======================
   ENV VALIDATION
======================= */
const REQUIRED_ENV_VARS = ["DEEPGRAM_API_KEY", "OPENAI_API_KEY"];
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
      summary TEXT
    )
  `);

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
async function summarizeTranscript(transcriptText) {
  if (!transcriptText || transcriptText.trim().length === 0) {
    console.warn("Empty transcript; skipping summarization.");
    return { summary: "", insights: [] };
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
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a meeting assistant. Summarize multi-speaker meetings without missing explicit points. " +
            "Return JSON with summary and insights. If no decisions or action items are stated, return empty lists."
        },
        {
          role: "user",
          content: `Transcript:\n${transcriptText}`
        }
      ]
    })
  });

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content || "{}";
  return JSON.parse(content);
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

async function processRecording(sessionId, audioBuffer) {
  await run(
    db,
    "INSERT OR IGNORE INTO meeting_sessions (session_id, created_at) VALUES (?, ?)",
    [sessionId, new Date().toISOString()]
  );

  const filePath = path.join(RECORDINGS_DIR, `${sessionId}.webm`);
  await fs.promises.writeFile(filePath, audioBuffer);

  const transcript = await transcribeWithDeepgram(audioBuffer);
  await run(db, "UPDATE meeting_sessions SET transcript=? WHERE session_id=?", [
    transcript,
    sessionId
  ]);
  await fs.promises.writeFile(
    path.join(TRANSCRIPTS_DIR, `${sessionId}.txt`),
    transcript,
    "utf8"
  );

  const { summary, insights } = await summarizeTranscript(transcript);
  await run(db, "UPDATE meeting_sessions SET summary=? WHERE session_id=?", [
    summary,
    sessionId
  ]);
  await fs.promises.writeFile(
    path.join(SUMMARIES_DIR, `${sessionId}.json`),
    JSON.stringify({ summary, insights }, null, 2),
    "utf8"
  );

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

  const sessionId = crypto.randomUUID();

  try {
    const { transcript, insights } = await processRecording(sessionId, req.file.buffer);
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
      const { transcript, insights } = await processRecording(sessionId, req.body);
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
  const participants = Array.isArray(req.body?.participants) ? req.body.participants : [];
  const cleaned = participants
    .map((name) => (typeof name === "string" ? name.trim() : ""))
    .filter(Boolean);

  try {
    await run(db, "DELETE FROM meeting_participants WHERE session_id=?", [sessionId]);
    for (const name of cleaned) {
      await run(
        db,
        "INSERT INTO meeting_participants (id, session_id, name) VALUES (?, ?, ?)",
        [crypto.randomUUID(), sessionId, name]
      );
    }
    res.json({ status: "ok", count: cleaned.length });
  } catch (err) {
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
    await fs.promises.writeFile(
      path.join(SUMMARIES_DIR, `${sessionId}.json`),
      JSON.stringify({ summary: mappedSummary }, null, 2),
      "utf8"
    );

    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ error: "Failed to apply speaker map", detail: err.message });
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

/* =======================
   START SERVER
======================= */
app.listen(PORT, () =>
  console.log(`BMAD backend listening on http://localhost:${PORT}`)
);
