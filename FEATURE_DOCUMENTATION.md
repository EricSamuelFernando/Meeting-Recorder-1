# Multi-Meeting Task Tracking & Continuity Feature
## Technical Documentation for Team Lead

---

## 1. EXECUTIVE SUMMARY

**Current System:** Meeting Recorder that extracts tasks and action items from individual meetings.

**Proposed Enhancement:** Add cross-meeting task tracking to provide project-level visibility, progress monitoring, and AI-driven insights on task completion, blockers, and resource needs.

**Value Proposition:**
- Track task progress across multiple meetings
- Identify blockers and their timeline impact
- AI-powered completion estimates
- Automatic blocker resolution tracking
- Resource/help requirement identification

---

## 2. CURRENT SYSTEM OVERVIEW

### 2.1 Existing Functionality

The current meeting recorder system:

```
Meeting 1 (Jan 10)
  ↓
Audio Recording (tab + mic)
  ↓
Transcription (Deepgram)
  ↓
Task Extraction (OpenAI GPT-4o-mini)
  ↓
Summary Generated:
  - Main summary text
  - 5 main tasks
  - 12 subtasks (average)
  - Action items with assignees
  - Due dates/due phrases
  ↓
Email Notifications
  ↓
Data Stored (Session Summary JSON)
```

### 2.2 Current Output Format

**File:** `backend/data/summaries/{session-id}.json`

```json
{
  "summary": "Meeting about building meeting recorder features...",
  "tasks": [
    {
      "title": "Build meeting recorder like Fathom",
      "description": "Core product development with dual audio capture",
      "subtasks": [
        "Set up recording with remote speaker + microphone",
        "Integrate Deepgram for transcription",
        "Generate summaries with OpenAI",
        "Extract action items and due dates",
        "Send email notifications"
      ]
    },
    {
      "title": "Set up email notifications",
      "description": "Implement SMTP integration for action items",
      "subtasks": [...]
    }
  ],
  "insights": [
    "Decision: Use Gmail SMTP for email delivery",
    "Action Item: Configure SMTP credentials",
    "Important: Email extraction from Google Meet DOM"
  ]
}
```

### 2.3 Current Database Schema

```
meeting_sessions
├── session_id
├── created_at
├── transcript
└── summary (JSON blob)

meeting_participants
├── id
├── session_id
├── name
└── email

meeting_action_items
├── id
├── session_id
├── assignee
├── email
├── task_description
├── due_phrase
├── due_date
└── status

meeting_insights
├── id
├── session_id
├── label (Decision/Action Item/Important)
├── content
└── timestamp
```

---

## 3. PROPOSED FEATURE: MULTI-MEETING TASK TRACKING

### 3.1 Feature Overview

Add a task continuity layer that:
- **Remembers** tasks mentioned in previous meetings
- **Links** new tasks to previous tasks (parent-child relationships)
- **Tracks** progress metrics (days elapsed, % complete)
- **Identifies** blockers and their resolution
- **Generates** AI insights on velocity and estimated completion
- **Recommends** help/resources needed

### 3.2 Problem It Solves

**Scenario Without Feature:**
```
Meeting 1 (Jan 10): "Build meeting recorder"
  → Summary saved, then forgotten
  
Meeting 2 (Jan 16): "Added email feature"
  → No connection to Meeting 1 task
  → No visibility into progress
  → Manager asks: "What's the status on the recorder?"
  → Answer: Must manually check previous meetings
```

**Scenario With Feature:**
```
Meeting 1 (Jan 10): "Build meeting recorder"
  → Task stored with history tracking
  
Meeting 2 (Jan 16): "Added email feature"
  → AI recognizes: "Email feature" is subtask of "Build recorder"
  → Automatically calculates: 6 days elapsed, 60% complete
  → AI analysis: "At current pace, 4 more days needed"
  → Shows resolved blocker: "SMTP setup (was blocking, now resolved)"
  → Manager gets: Clear progress update without manual checking
```

---

## 4. SYSTEM ARCHITECTURE

### 4.1 New Database Table: `task_history`

```sql
CREATE TABLE task_history (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  task_title TEXT NOT NULL,
  task_description TEXT,
  parent_task_id TEXT,              -- NULL for main tasks, set for subtasks
  status TEXT,                      -- Open, In Progress, Completed, Blocked
  created_date TEXT,                -- When task was first mentioned
  updated_date TEXT,                -- When last mentioned
  days_elapsed INTEGER,             -- Calculated: today - created_date
  estimated_days INTEGER,           -- If user provided estimate
  actual_days_taken INTEGER,        -- If task completed
  blockers TEXT,                    -- JSON array of blocker objects
  help_needed TEXT,                 -- JSON array of help requests
  participant_assigned TEXT,        -- Who's responsible
  metadata TEXT,                    -- JSON: additional context
  FOREIGN KEY (session_id) REFERENCES meeting_sessions(session_id),
  FOREIGN KEY (parent_task_id) REFERENCES task_history(id)
)
```

### 4.2 Data Flow Architecture

```
Meeting 2 Recording
    │
    ├─→ Transcription (Deepgram)
    │
    ├─→ Task Extraction (OpenAI)
    │    ├─ Extract new tasks
    │    └─ Extract subtasks
    │
    ├─→ NEW: Task Linking Module
    │    ├─ Query previous sessions
    │    ├─ Ask AI: "Are these tasks related?"
    │    ├─ Link new tasks to parent tasks
    │    └─ Store relationships in task_history
    │
    ├─→ NEW: Progress Calculation Module
    │    ├─ Query task_history for previous mentions
    │    ├─ Calculate days_elapsed
    │    ├─ Count completed vs total subtasks
    │    ├─ Calculate progress percentage
    │    └─ Identify blockers
    │
    ├─→ NEW: AI Analysis Module
    │    ├─ Task velocity analysis
    │    ├─ Completion time estimation
    │    ├─ Blocker impact assessment
    │    ├─ Help/resource recommendation
    │    └─ Generate analysis report
    │
    ├─→ Summary Generation (Enhanced)
    │    ├─ Main summary (existing)
    │    ├─ New tasks (existing)
    │    ├─ Action items (existing)
    │    └─ NEW: taskContinuity section
    │
    └─→ Email Notification (existing)
```

### 4.3 Component: Task Linking Engine

**Purpose:** Determine if new tasks are related to previous tasks

**Process:**

```python
async function linkTasksAcrossMeetings(newSessionId, newTasks) {
  for each newTask in newTasks:
    1. Query database for all previous tasks
    2. Format prompt: 
       "New task: 'Add email notification'
        Previous tasks: ['Build meeting recorder', 'Set up database', ...]
        Is this new task a: continuation / subtask / new task?
        Return JSON with relationship info"
    3. Call OpenAI GPT-4o-mini
    4. Parse response for relationship type
    5. If related:
       - Store parent_task_id relationship
       - Update task_history record
       - Set status as "In Progress" or "Continued"
    6. If new:
       - Create new task_history entry
       - Set parent_task_id as NULL
}
```

**Example:**
```
New Task: "Add email notification feature"
Previous Tasks: [
  "Build meeting recorder like Fathom",
  "Set up database",
  "Configure Google Meet integration"
]

AI Analysis:
"This new task 'Add email notification' is a SUBTASK of 'Build meeting recorder'
because:
1. Email notifications were mentioned as a feature in the main task
2. Logically part of the complete recorder solution
3. Named component in the architecture"

Relationship Stored:
{
  parent_task_id: "task-1" (Build meeting recorder),
  relationship_type: "subtask",
  confidence: 0.95
}
```

### 4.4 Component: Progress Calculator

**Purpose:** Calculate metrics on task completion

**Metrics Calculated:**

```javascript
async function calculateTaskProgress(taskId) {
  // Get all mentions of this task across meetings
  const allMentions = await query(
    "SELECT * FROM task_history WHERE id = ? OR parent_task_id = ?",
    [taskId, taskId]
  );
  
  // Calculate timeline
  const createdDate = allMentions[0].created_date;  // Jan 10
  const today = new Date();
  const daysElapsed = daysBetween(createdDate, today);  // 6 days
  
  // Calculate progress
  const completed = allMentions.filter(t => t.status === 'Completed').length;  // 3
  const total = allMentions.length;  // 5
  const progressPercent = (completed / total) * 100;  // 60%
  
  // Calculate velocity
  const velocity = total / daysElapsed;  // 0.83 subtasks/day
  const estimatedRemaining = (total - completed) / velocity;  // 2.4 days
  
  // Extract blockers
  const blockers = allMentions
    .filter(t => t.blockers)
    .flatMap(t => JSON.parse(t.blockers));
  
  // Extract help needs
  const helpNeeds = allMentions
    .filter(t => t.help_needed)
    .flatMap(t => JSON.parse(t.help_needed));
  
  return {
    daysElapsed: 6,
    progressPercent: 60,
    subtasksCompleted: 3,
    subtasksTotal: 5,
    velocity: 0.83,
    estimatedDaysRemaining: 2.4,
    blockers: [...],
    helpNeeded: [...]
  };
}
```

**Output Example:**
```json
{
  "taskId": "task-1",
  "taskTitle": "Build meeting recorder like Fathom",
  "createdDate": "2026-01-10",
  "daysElapsed": 6,
  "progressPercent": 60,
  "subtasksCompleted": 3,
  "subtasksTotal": 5,
  "velocity": "0.83 subtasks/day",
  "estimatedDaysRemaining": 2.4,
  "estimatedCompletionDate": "2026-01-19",
  "blockers": [
    {
      "blocker": "SMTP email setup",
      "mentionedInMeeting": 1,
      "resolvedInMeeting": 2,
      "daysBocked": 2,
      "status": "Resolved"
    }
  ],
  "helpNeeded": [
    "Code review for email implementation",
    "Testing with multiple participants"
  ]
}
```

### 4.5 Component: AI Analysis Engine

**Purpose:** Generate insights using GPT-4o-mini

**Analysis Generated:**

```javascript
async function generateTaskAnalysis(taskId, progressMetrics) {
  const prompt = `
    You are a project manager analyzing task progress.
    
    Task: "${progressMetrics.taskTitle}"
    Started: ${progressMetrics.daysElapsed} days ago
    Progress: ${progressMetrics.progressPercent}% complete
    Completed: ${progressMetrics.subtasksCompleted}/${progressMetrics.subtasksTotal} subtasks
    Velocity: ${progressMetrics.velocity} subtasks/day
    
    Blockers (resolved):
    ${progressMetrics.blockers.map(b => `- ${b.blocker} (${b.daysBocked} days impact)`).join('\n')}
    
    Help Needed:
    ${progressMetrics.helpNeeded.join(', ')}
    
    Provide a brief analysis (3-4 sentences) that includes:
    1. Current completion velocity
    2. Estimated days remaining
    3. Blocker impact assessment
    4. Recommendations for faster completion
    5. Critical resources/help needed
  `;
  
  const response = await openai.createChatCompletion({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }]
  });
  
  return response.choices[0].message.content;
}
```

**Sample Output:**

> "The 'Build meeting recorder' task is progressing at 0.83 subtasks per day. At this velocity, with 2 subtasks remaining, the project should be complete by January 19th. The SMTP setup blocker, which delayed progress by 2 days in Meeting 1, has been successfully resolved. To accelerate completion, prioritize code review of the email implementation (mentioned in help needs) and schedule parallel testing with multiple participants to unblock other team members who depend on this feature."

---

## 5. FEATURE IMPLEMENTATION

### 5.1 New Database Table Creation

```javascript
// In server.js - during database initialization
db.run(`
  CREATE TABLE IF NOT EXISTS task_history (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_title TEXT NOT NULL,
    task_description TEXT,
    parent_task_id TEXT,
    status TEXT DEFAULT 'Open',
    created_date TEXT,
    updated_date TEXT,
    days_elapsed INTEGER,
    estimated_days INTEGER,
    actual_days_taken INTEGER,
    blockers TEXT,
    help_needed TEXT,
    participant_assigned TEXT,
    metadata TEXT,
    FOREIGN KEY (session_id) REFERENCES meeting_sessions(session_id),
    FOREIGN KEY (parent_task_id) REFERENCES task_history(id)
  )
`);
```

### 5.2 New Endpoints

**POST /api/sessions/:id/task-continuity**
- Input: `sessionId`, `newTasks`
- Process: Link tasks, calculate progress, generate analysis
- Output: Enhanced summary with `taskContinuity` section

**GET /api/tasks/:taskId/history**
- Output: Complete task history across meetings

**GET /api/tasks/:taskId/progress**
- Output: Progress metrics and AI analysis

### 5.3 Integration with Existing Flow

**Modified `summarizeTranscript()` function:**

```javascript
async function summarizeTranscript(transcript, sessionId) {
  // Existing: Generate summary and tasks
  const { summary, tasks, insights } = await aiSummarize(transcript);
  
  // NEW: Link tasks and generate continuity
  const taskContinuity = await generateTaskContinuity(sessionId, tasks);
  
  // Return enhanced summary
  return {
    summary,
    tasks,
    insights,
    taskContinuity  // ← NEW
  };
}
```

### 5.4 Implementation Phases

**Phase 1 (Week 1):** Database & Infrastructure
- Create `task_history` table
- Add migration scripts
- Create helper functions

**Phase 2 (Week 2):** Task Linking
- Implement AI-powered task linking
- Store relationships in database
- Add error handling

**Phase 3 (Week 3):** Progress Tracking
- Calculate progress metrics
- Store blocker information
- Track velocity

**Phase 4 (Week 4):** AI Analysis & Integration
- Implement analysis generation
- Integrate with summary pipeline
- Test end-to-end flow

---

## 6. DATA FLOW EXAMPLE

### 6.1 Meeting 1 (Jan 10)

**Input:** Recording of 1-speaker discussing meeting recorder project

**Transcript Excerpt:**
> "Today we're going to build a meeting recorder like Fathom. We need recording with dual audio, transcription with Deepgram, summaries with OpenAI, action item extraction, and email notifications. The SMTP setup is a blocker right now - we don't have Gmail configured yet."

**Output:**
```json
{
  "summary": "Meeting to discuss building a meeting recorder application...",
  "tasks": [
    {
      "title": "Build meeting recorder like Fathom",
      "subtasks": [
        "Recording with dual audio",
        "Transcription (Deepgram)",
        "Summary generation (OpenAI)",
        "Action item extraction",
        "Email notifications"
      ]
    }
  ],
  "action_items": [
    {
      "task": "Set up Gmail SMTP credentials",
      "assignee": "Alex Johnson",
      "due_phrase": "ASAP"
    }
  ]
}
```

**Stored in `task_history`:**
```
task_id: task-1
task_title: "Build meeting recorder like Fathom"
session_id: session-1
status: "In Progress"
created_date: "2026-01-10"
subtasks: [
  {id: sub-1, title: "Recording with dual audio", status: "In Progress"},
  {id: sub-2, title: "Transcription", status: "In Progress"},
  {id: sub-3, title: "Summary", status: "In Progress"},
  {id: sub-4, title: "Action items", status: "Not Started"},
  {id: sub-5, title: "Email notifications", status: "Not Started"}
]
blockers: [
  {
    name: "SMTP setup",
    impact: "Blocking email notifications feature",
    mentioned_date: "2026-01-10"
  }
]
```

---

### 6.2 Meeting 2 (Jan 16)

**Input:** Recording of 1-speaker discussing progress

**Transcript Excerpt:**
> "We've made good progress on the meeting recorder. The recording with dual audio is working, Deepgram transcription is done, and summaries are generating. We set up the Gmail SMTP, so email notifications are now ready. Next, we need to add multi-participant support and finish the task extraction feature."

**New Tasks Extracted:**
```
- Add multi-participant support
- Complete task extraction feature
- Improve email notification formatting
```

**AI Task Linking Analysis:**

For each new task, AI asks: "Is this related to previous tasks?"

```
New Task 1: "Add multi-participant support"
  Previous Task: "Build meeting recorder like Fathom"
  AI Analysis: "This is a subtask/continuation of the main recorder task"
  → Linked as: parent_task_id = task-1

New Task 2: "Complete task extraction feature"
  Previous Task: "Build meeting recorder like Fathom"
  AI Analysis: "Task extraction was subtask #4, this is its continuation"
  → Linked as: parent_task_id = task-1 (subtask of sub-4)

New Task 3: "Improve email notification formatting"
  Previous Task: "Build meeting recorder like Fathom"
  AI Analysis: "Email notifications was subtask #5, this is refinement"
  → Linked as: parent_task_id = task-1 (subtask of sub-5)
```

**Progress Calculation:**

```
Task: "Build meeting recorder"
Created: Jan 10
Today: Jan 16
Days Elapsed: 6 days

Subtasks Status:
- Recording with dual audio: COMPLETED ✓
- Transcription (Deepgram): COMPLETED ✓
- Summary generation: COMPLETED ✓
- Action items extraction: IN PROGRESS (50%)
- Email notifications: COMPLETED ✓

Progress: 4.5/5 = 90% complete
Velocity: 0.75 subtasks/day
Estimated Days Remaining: (0.5) / 0.75 = 0.67 days
Estimated Completion: Jan 17

Blockers:
- SMTP Setup: RESOLVED (Jan 16, was blocking email feature for 1 day)

Help Needed:
- Code review of task extraction algorithm
- Testing with multiple participants
```

**AI Analysis Generated:**

> "The 'Build meeting recorder' project has made significant progress, reaching 90% completion in 6 days. At the current velocity of 0.75 subtasks/day, the remaining 0.5 subtasks should be complete by January 17th. The SMTP setup blocker that was limiting email notifications has been resolved. To complete the final features, focus on task extraction refinement and scheduling multi-participant testing. Both require peer code review—recommend pairing with another developer for validation."

**Final Output (Enhanced Summary):**

```json
{
  "summary": "Progress meeting on meeting recorder project. 90% complete.",
  "tasks": [
    {
      "title": "Add multi-participant support",
      "description": "...",
      "subtasks": [...]
    },
    {
      "title": "Complete task extraction feature",
      "description": "...",
      "subtasks": [...]
    }
  ],
  "action_items": [
    {
      "task": "Code review task extraction algorithm",
      "assignee": "Alex Johnson",
      "due_phrase": "End of week"
    }
  ],
  "taskContinuity": {
    "previousTasks": [
      {
        "taskId": "task-1",
        "taskTitle": "Build meeting recorder like Fathom",
        "createdDate": "2026-01-10",
        "daysElapsed": 6,
        "progressPercent": 90,
        "subtasksCompleted": 4,
        "subtasksTotal": 5,
        "completedSubtasks": [
          "Recording with dual audio",
          "Transcription with Deepgram",
          "Summary generation",
          "Email notifications"
        ],
        "inProgressSubtasks": [
          "Action item extraction"
        ],
        "velocity": "0.75 subtasks/day",
        "estimatedDaysRemaining": 0.67,
        "estimatedCompletionDate": "2026-01-17"
      }
    ],
    "blockers": [
      {
        "blockerName": "SMTP Setup",
        "status": "Resolved",
        "resolvedInMeeting": 2,
        "daysBocked": 1,
        "impact": "Delayed email notification feature"
      }
    ],
    "aiAnalysis": "The 'Build meeting recorder' project has made significant progress, reaching 90% completion in 6 days. At the current velocity of 0.75 subtasks/day, the remaining 0.5 subtasks should be complete by January 17th. The SMTP setup blocker has been resolved. To complete the final features, focus on task extraction refinement and multi-participant testing with peer code review."
  }
}
```

---

## 7. BENEFITS & ROI

### 7.1 Organizational Benefits

| Benefit | Impact | Stakeholder |
|---------|--------|-------------|
| **Cross-meeting visibility** | Know project status without manual checking | Manager/Lead |
| **Blocker tracking** | Identify what's slowing progress | Team |
| **Velocity metrics** | Realistic completion estimates | Manager |
| **Help identification** | Know when team needs support | Manager |
| **Accountability** | Clear record of progress | Manager |
| **Reduced meetings** | AI analysis replaces status meetings | Team |

### 7.2 Quantified Impact

**Before:** Manager needs to manually review 3 meeting summaries to understand project status
**After:** AI-generated summary automatically shows status, blockers, and risks in 1 section

**Time saved:** ~15 min per project per week = 1 hour/month

---

## 8. TECHNICAL REQUIREMENTS

### 8.1 New Dependencies

```json
{
  "nodemailer": "^6.9.0",        // (existing)
  "openai": "^4.0.0",            // (existing)
  "sqlite3": "^5.1.0"            // (existing)
}
```

**No new npm packages required** - uses existing OpenAI API

### 8.2 API Rate Considerations

**OpenAI API Calls per Meeting:**
- Task linking: 1 call per meeting
- Task analysis: 1 call per task
- Total: ~2-3 API calls per meeting (vs. 2 for existing feature)

**Additional cost:** ~$0.005-0.01 per meeting

### 8.3 Storage Requirements

**Additional database space:**
- `task_history` table: ~500 bytes per task mentioned
- Estimate: 50-100 KB per meeting (minimal)

---

## 9. TIMELINE & MILESTONES

```
Week 1:    Database setup, schema migration
Week 2:    Task linking implementation
Week 3:    Progress calculation engine
Week 4:    AI analysis & integration
Week 5:    Testing & refinement
Week 6:    Deployment & monitoring
```

---

## 10. RISKS & MITIGATION

| Risk | Mitigation |
|------|-----------|
| AI incorrectly links unrelated tasks | Add manual review option; confidence threshold |
| Task naming inconsistencies | Implement fuzzy matching in linking logic |
| Performance with large task history | Index task_history table; pagination for queries |
| API cost overrun | Monitor call patterns; set rate limits |

---

## 11. QUESTIONS FOR DISCUSSION

1. Should we add manual task creation (vs. only from meetings)?
2. Do we need a dashboard to visualize task progress?
3. Should team members be able to update task status manually?
4. Do we want historical data from previous projects?
5. Should we integrate with project management tools (Jira, Asana)?

---

## 12. APPENDIX: CURRENT SYSTEM STATUS

✅ **Completed Features:**
- Meeting recording (dual audio)
- Transcription (Deepgram)
- Summary generation (OpenAI)
- Task extraction
- Action item generation
- Email notifications
- Single participant email routing
- Database storage

🔄 **In Development:**
- Multi-participant support
- Screen sharing integration

📋 **Proposed (This Feature):**
- Multi-meeting task tracking
- Task linking across meetings
- Progress metrics
- AI analysis engine
- Continuity reporting

---

**Document Version:** 1.0
**Last Updated:** January 16, 2026
**Prepared By:** Development Team
