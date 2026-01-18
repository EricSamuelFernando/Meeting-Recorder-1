# Recorder (Fathom-style MVP)

Chrome extension + Node.js backend that records Google Meet audio, uploads it, transcribes with Deepgram, summarizes with OpenAI, and stores results locally. The backend now produces Fathom-style summaries, links continuation meetings, and keeps sequential session IDs (001, 002, …) so the UX feels like a structured meeting assistant.

## Features

- Chrome MV3 extension with offscreen recording
- Captures Meet tab audio + microphone and mixes to a single WebM
- Session-based processing: audio -> transcript -> summary -> insights
- Local persistence with SQLite (source of truth)
- Optional speaker name assignment after upload
- Sequential session IDs (`001`, `002`, etc.) ensure meetings are tracked chronologically for the continuation workflow

## Project Structure

- `manifest.json`, `background.js`, `content-script.js`, `offscreen.html`, `offscreen.js`, `popup.html`, `popup.js`
- `backend/` Node.js API + SQLite database

## Requirements

- Chrome (Manifest v3 compatible)
- Node.js v20+
- Deepgram API key
- OpenAI API key

## Setup

1) Install backend dependencies:

```
cd backend
npm install
```

2) Create `backend/.env` (copy from `backend/.env.example` if present) and set:

```
DEEPGRAM_API_KEY=your_key_here
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-4o-mini
DEEPGRAM_MODEL=nova-2
```

3) Start backend:

```
cd backend
node server.js
```

Backend runs on `http://localhost:8080`.

## Load the Chrome Extension

1) Open `chrome://extensions`.
2) Enable Developer Mode.
3) Click "Load unpacked" and select the project root (`meetingrec`).
4) Pin the extension for easy access.

## How It Works (Flow)

1) Click Start in the Meet overlay panel.
2) Click the extension icon once (required user gesture for tab capture).
3) Offscreen document records audio and uploads on stop.
4) Backend transcribes with Deepgram.
5) Backend summarizes with OpenAI and stores both the structured summary object (title/date/duration/action items/topics/continuation) and the raw summary text.
6) First meetings generate the Fathom-style summary plus meeting metadata; continuation meetings reuse the previous summary/action-item context so progress updates are surfaced.
7) Results saved locally and available by session ID (now padded) via SQLite and JSON files.

## Local Storage

All files are written under `backend/data/`:

- `backend/data/recordings/{sessionId}.webm`
- `backend/data/transcripts/{sessionId}.txt`
- `backend/data/summaries/{sessionId}.json`
- Each summary JSON now includes `{ summary: { title, date, action_items, meeting_summary, topics, continuation_summary }, summary_text, structuredSummary, taskContinuity }`
- `backend/data/bmad.sqlite`

## API Endpoints (Backend)

- `POST /upload` (multipart/form-data, field: `audio`; optional fields: `parentSessionId`, `meetingName`, `meetingDate`, `duration`, `viewRecordingUrl`, `meetingPurpose`)
- `GET /api/sessions` (list sessions)
- `GET /api/sessions/:id` (session detail)
- `POST /api/sessions/:id/participants` (save roster)
- `POST /api/sessions/:id/speaker-map` (apply speaker name mapping)
- `POST /api/sessions/:id/summarize` (rerun summarization with a provided transcript and optional metadata)

## Notes / Troubleshooting

- `Cannot GET /` at `localhost:8080` is expected (no root route).
- If upload fails, confirm the backend is running.
- If audio is silent, ensure mic permission is allowed and the Meet tab is active.
- The speaker-name popup appears only if the transcript contains speaker labels.

## Security

- API keys are read from environment variables only.
- Do not commit `.env` to source control.

## License

MVP prototype for local use.
