
## 🏗️ Architecture

### Infrastructure Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Local & Cloud Hybrid                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐         ┌──────────────┐                      │
│  │ Chrome Ext.  │ ────────│  Google Meet │                      │
│  │ (Recorder)   │         │  Tab Audio   │                      │
│  └──────┬───────┘         └──────────────┘                      │
│         │                                                       │
│    ┌────┴──────────────────────────┐                            │
│    │                               │                            │
│    ▼                               ▼                            │
│  ┌─────────────┐           ┌──────────────┐                     │
│  │ Offscreen   │           │   Node.js    │                     │
│  │ Document    │           │   Backend    │                     │
│  └─────────────┘           └──────┬───────┘                     │
│                                    │                            │
│                                    ▼                            │
│                            ┌──────────────┐                     │
│                            │   SQLite     │                     │
│                            │  Database    │                     │
│                            │ (bmad.sqlite)│                     │
│                            └──────┬───────┘                     │
│                                   │                             │
│                    ┌──────────────┼──────────────┐              │
│                    │              │              │              │
│                    ▼              ▼              ▼              │
│              ┌─────────┐    ┌─────────┐    ┌─────────┐          │
│              │Deepgram │    │ OpenAI  │    │ Local   │          │
│              │(Nova-2) │    │(GPT-4o) │    │ Files   │          │
│              └─────────┘    └─────────┘    └─────────┘          │
│                                                                 │
└──────────────────────────────────────────────────────────────────┘

```

### Tech Stack

**Frontend (Extension):**

* Chrome Manifest V3
* Offscreen API (Audio Capture)
* JavaScript (Background & Content Scripts)
* Custom Meet Overlay Panel

**Backend:**

* Node.js v20+
* Express.js (API Framework)
* SQLite3 (Local Persistence)
* Multer (Multipart Audio Uploads)

**AI & External Services:**

* **Deepgram Nova-2:** High-accuracy transcription with speaker diarization.
* **OpenAI GPT-4o-mini:** Structured summarization and task continuity analysis.

## 🚀 Features & Logic

### Core Functionalities

* **Dual-Stream Mixing:** Merges microphone and tab audio into a single WebM file.
* **Robust Mute Handling:** Continues recording tab audio even if the local microphone is muted.
* **Sequential IDs:** Automatically assigns IDs like `001`, `002` for chronological tracking.
* **Fathom-style Summaries:** Generates structured JSON summaries including Main Tasks, Subtasks, and Action Items.

### Meeting Continuity Workflow

The recorder features "Antigravity" memory logic:

1. **Thread Identification:** Users name meetings (e.g., "Snaphomz Sync").
2. **Context Recall:** If a meeting is marked as a "Continuation," the backend fetches the previous summary from SQLite.
3. **Progressive Summary:** OpenAI analyzes the new transcript alongside the old summary to track task completion and project velocity.

## 🛠️ Local Development

### Prerequisites

* Node.js 20+
* Deepgram API Key
* OpenAI API Key

### Setup

1. **Clone and Install Backend:**

```bash
cd backend
npm install

```

2. **Configure Environment:**
Create `backend/.env`:

```env
DEEPGRAM_API_KEY=your_key
OPENAI_API_KEY=your_key
OPENAI_MODEL=gpt-4o-mini
PORT=8080

```

3. **Load Extension:**

* Open `chrome://extensions`
* Enable **Developer Mode**
* Click **Load Unpacked** and select the `meetingrec` folder.

### Run Locally

```bash
# Start backend
cd backend
node server.js/npm start

```

Access the extension by joining a Google Meet.

## 📊 Data Management

### Local Storage Hierarchy

All session data is persisted in `backend/data/`:

* `/recordings/`: Original `.webm` audio files.
* `/transcripts/`: Raw `.txt` files with speaker labels.
* `/summaries/`: Structured `.json` containing:
* `mainTask` & `subtasks`
* `actionItemsByAssignee` (Grouped list)
* `continuation` (Progress, velocity, blockers)



### Database Schema (SQLite)

The `bmad.sqlite` file serves as the source of truth for:

* Session metadata (ID, Name, Date, Duration).
* Parent-Child relationships for continuation threads.
* Speaker name mapping and participant rosters.

## 🔒 Security & Best Practices

* **Local-First:** All sensitive transcripts and recordings stay on your local machine.
* **Environment Safety:** API keys are never hardcoded and must be managed via `.env`.
* **User Gesture:** Follows Chrome security policies requiring a user click to initiate tab capture.

## 🤝 Contributing

1. Create a feature branch for new AI prompt logic or UI tweaks.
2. Ensure sequential ID logic remains intact during DB migrations.
3. Test dual-stream audio capture after any changes to `offscreen.js`.

   
##📝 License:
MVP prototype for local use.
