const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { v4: uuidv4 } = require('uuid'); // For generating unique IDs
const path = require('path');

let db;

async function initializeDatabase() {
    db = await open({
        filename: path.join(__dirname, '../data/bmad.sqlite'),
        driver: sqlite3.Database
    });

    // Ensure the parent table exists for Foreign Key constraints
    await db.exec(`
      CREATE TABLE IF NOT EXISTS meeting_sessions (
        session_id TEXT PRIMARY KEY,
        created_at TEXT,
        transcript TEXT,
        summary TEXT
      )
    `);

    // Add new columns for Meeting Naming & Sequential IDs if they don't exist
    const columns = await db.all("PRAGMA table_info(meeting_sessions)");
    const colNames = columns.map(c => c.name);
    
    if (!colNames.includes('numeric_session_id')) await db.exec("ALTER TABLE meeting_sessions ADD COLUMN numeric_session_id INTEGER");
    if (!colNames.includes('meeting_name')) await db.exec("ALTER TABLE meeting_sessions ADD COLUMN meeting_name TEXT");
    if (!colNames.includes('parent_session_id')) await db.exec("ALTER TABLE meeting_sessions ADD COLUMN parent_session_id TEXT");

    // As per section 5.1 of the documentation
    await db.exec(`
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

    console.log("Database initialized and task_history table is ready.");
    return db;
}

function getDb() {
    if (!db) {
        throw new Error("Database not initialized. Call initializeDatabase() first.");
    }
    return db;
}

// --- Helper functions for task_history ---

async function getPreviousTasks() {
    const db = getDb();
    return await db.all("SELECT id, task_title, task_description FROM task_history WHERE parent_task_id IS NULL");
}

async function storeNewTask(task, sessionId, parentTaskId = null) {
    const db = getDb();
    const taskId = uuidv4();
    const now = new Date().toISOString();
    await db.run(
        `INSERT INTO task_history (id, session_id, task_title, task_description, parent_task_id, status, created_date, updated_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [taskId, sessionId, task.title, task.description || '', parentTaskId, 'In Progress', now, now]
    );
    return taskId;
}

async function getTaskAndSubtasks(taskId) {
    const db = getDb();
    return await db.all(`
        WITH RECURSIVE task_hierarchy(id, parent_task_id, task_title, status, created_date, blockers, help_needed) AS (
            SELECT id, parent_task_id, task_title, status, created_date, blockers, help_needed FROM task_history WHERE id = ?
            UNION ALL
            SELECT t.id, t.parent_task_id, t.task_title, t.status, t.created_date, t.blockers, t.help_needed FROM task_history t JOIN task_hierarchy th ON t.parent_task_id = th.id
        )
        SELECT * FROM task_hierarchy;
    `, [taskId]);
}

async function getUniqueParentTasksForSession(sessionId) {
    const db = getDb();
    const tasksInSession = await db.all('SELECT parent_task_id FROM task_history WHERE session_id = ? AND parent_task_id IS NOT NULL', [sessionId]);
    const parentIds = [...new Set(tasksInSession.map(t => t.parent_task_id))];
    if (parentIds.length === 0) return [];
    const placeholders = parentIds.map(() => '?').join(',');
    return await db.all(`SELECT id, task_title FROM task_history WHERE id IN (${placeholders})`, parentIds);
}

module.exports = {
    initializeDatabase,
    getDb,
    getPreviousTasks,
    storeNewTask,
    getTaskAndSubtasks,
    getUniqueParentTasksForSession
};