
## Architecture Analysis: Recorder 

The **Recorder** project is designed as a **hybrid local-first application**. Unlike the cloud-native, serverless architecture of SnapAudit, Recorder focuses on local processing and storage:

* **Data Flow:** It uses the Chrome **Offscreen API** to bypass browser limitations for audio capture, mixing system and microphone audio before sending it to a local Node.js server.
* **Intelligence Layer:** It leverages a "Best-of-Breed" AI strategy, using **Deepgram** (optimized for speed/accuracy in transcription) alongside **OpenAI** (optimized for reasoning/summarization).
* **Storage Strategy:** It uses **SQLite** for relational session data and the local **filesystem** for "blob" storage (WebM/Text/JSON), making it highly portable for a single-user environment.

# Recorder - Google Meet Intelligence MVP

An intelligent meeting assistant that captures, transcribes, and summarizes Google Meet sessions using a Chrome Extension and a local Node.js processing engine.

## 🏗️ Architecture

### Infrastructure Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Local / Client Infrastructure                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐         ┌──────────────┐      ┌────────────┐  │
│  │    Chrome    │ ────────│  Offscreen   │ ────▶│ Deepgram   │  │
│  │  Extension   │         │   Document   │      │ (Transcribe)│  │
│  └──────┬───────┘         └──────┬───────┘      └────────────┘  │
│         │                        │                     ▲        │
│         ▼                        ▼                     │        │
│  ┌──────────────┐         ┌──────────────┐      ┌────────────┐  │
│  │ Content Script│         │   Node.js    │ ────▶│   OpenAI   │  │
│  │ (Meet UI)    │         │    Server    │      │ (Summarize)│  │
│  └──────────────┘         └──────┬───────┘      └────────────┘  │
│                                  │                              │
│                    ┌─────────────┼─────────────┐                │
│                    │             │             │                │
│                    ▼             ▼             ▼                │
│              ┌─────────┐   ┌───────────┐   ┌─────────┐          │
│              │ SQLite  │   │Local Files│   │   Env   │          │
│              │ (DB)    │   │(WebM/Text)│   │ (Secrets)│          │
│              └─────────┘   └───────────┘   └─────────┘          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

```

### Tech Stack

**Frontend (Chrome Extension):**

* Manifest V3
* Chrome Offscreen API (for audio capture)
* Vanilla JS / HTML / CSS
* Chrome Tab Capture API

**Backend:**

* Node.js v20+
* Express (Web Framework)
* SQLite3 (Database)
* Fluent-ffmpeg (Audio processing)

**AI Services:**

* **Deepgram (Nova-2):** High-speed, multi-speaker transcription
* **OpenAI (GPT-4o-mini):** Intelligent summarization and insight extraction

## 🚀 How It Works

The application follows a four-stage processing pipeline:

1. **Capture:** The extension injects a controller into Google Meet. Upon user gesture, it opens an offscreen document to capture and mix the tab audio and microphone stream.
2. **Ingestion:** On "Stop," the audio is sent as a WebM blob to the local Node.js server via a multipart/form-data POST request.
3. **Intelligence:** The backend coordinates with Deepgram for transcription and OpenAI for generating structured summaries.
4. **Persistence:** Results are indexed in SQLite, while raw audio and transcripts are stored in the `backend/data/` directory.

## 🛠️ Local Development

### Prerequisites

* Node.js 20+
* Chrome Browser
* Deepgram & OpenAI API Keys

### Setup

1. **Clone the repository:**
```bash
git clone [repository-url]
cd meetingrec

```


2. **Backend Configuration:**
```bash
cd backend
npm install
cp .env.example .env
# Add your DEEPGRAM_API_KEY and OPENAI_API_KEY to .env

```


3. **Start the Backend:**
```bash
node server.js/npm start

```


*Server runs at `http://localhost:8080*`
4. **Extension Installation:**
* Open `chrome://extensions`
* Enable **Developer Mode**
* Click **Load unpacked**
* Select the `meetingrec` root folder



## 📊 Data Management & Storage

All session data is stored locally to ensure privacy and low latency.

**Directory Structure (`backend/data/`):**

* `/recordings/`: Original `.webm` audio files
* `/transcripts/`: Raw `.txt` files from Deepgram
* `/summaries/`: AI-generated `.json` insights
* `bmad.sqlite`: Main database containing session metadata and speaker maps

**API Endpoints:**

* `GET /api/sessions`: Retrieve all historical meetings
* `GET /api/sessions/:id`: Detailed view of transcript and summary
* `POST /api/sessions/:id/speaker-map`: Update participant names post-meeting

## 🔒 Security & Privacy

* **Local Processing:** Audio files and transcripts never leave your local machine, except when sent to AI providers via encrypted API calls.
* **Environment Safety:** API keys are never hardcoded and must be provided via a `.env` file (which is git-ignored).
* **Permissions:** The extension utilizes the "Offscreen" permission to ensure recording only occurs when explicitly triggered by the user.

## 📝 License

MVP prototype for local use.
