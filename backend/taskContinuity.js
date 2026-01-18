const { OpenAI } = require('openai');
const { getPreviousTasks, storeNewTask, getTaskAndSubtasks, getUniqueParentTasksForSession } = require('./database');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

/**
 * 4.3 Component: Task Linking Engine
 */
async function linkTasksAcrossMeetings(newSessionId, newTasks) {
    const previousTasks = await getPreviousTasks();
    if (previousTasks.length === 0) {
        for (const newTask of newTasks) { await storeNewTask(newTask, newSessionId, null); }
        return;
    }

    const previousTaskTitles = previousTasks.map(t => `'${t.task_title}'`).join(', ');

    for (const newTask of newTasks) {
        const prompt = `
          Analyze the relationship between a new task and a list of existing project tasks.
          New Task: "${newTask.title}"
          Description: "${newTask.description}"
          Existing Tasks: [${previousTaskTitles}]
          Is the new task a continuation of, a subtask of, or completely unrelated to any of the existing tasks?
          Respond in a JSON object: { "relationship": "continuation" | "subtask" | "new", "parent_task_title": "The EXACT title of the parent task from the list provided, or null" }
        `;

        const aiResponse = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" },
        });

        const relationshipInfo = JSON.parse(aiResponse.choices[0].message.content);
        console.log(`[Task Linking] AI Analysis for "${newTask.title}":`, JSON.stringify(relationshipInfo));

        let parentTaskId = null;
        if (relationshipInfo.relationship !== 'new' && relationshipInfo.parent_task_title) {
            const target = relationshipInfo.parent_task_title.toLowerCase().trim();
            
            // 1. Exact match (case-insensitive)
            let parentTask = previousTasks.find(t => t.task_title.toLowerCase().trim() === target);

            // 2. Fuzzy match (check if one contains the other to handle punctuation/minor variations)
            if (!parentTask) {
                parentTask = previousTasks.find(t => 
                    t.task_title.toLowerCase().includes(target) || target.includes(t.task_title.toLowerCase())
                );
            }
            
            if (parentTask) {
                parentTaskId = parentTask.id;
                console.log(`[Task Linking] Successfully linked to parent: "${parentTask.task_title}"`);
            } else {
                console.log(`[Task Linking] WARNING: AI suggested parent "${relationshipInfo.parent_task_title}" but it was not found in DB.`);
            }
        }
        await storeNewTask(newTask, newSessionId, parentTaskId);
    }
}

/**
 * 4.4 Component: Progress Calculator
 */
async function calculateTaskProgress(taskId) {
    const allMentions = await getTaskAndSubtasks(taskId);
    if (allMentions.length === 0) return null;

    const mainTask = allMentions[0];
    const createdDate = new Date(mainTask.created_date);
    const today = new Date();
    const daysElapsed = Math.round((today - createdDate) / (1000 * 60 * 60 * 24));

    const completed = allMentions.filter(t => t.status === 'Completed').length;
    const total = allMentions.length;
    const progressPercent = total > 0 ? (completed / total) * 100 : 0;

    const velocity = daysElapsed > 0 ? completed / daysElapsed : 0;
    const estimatedRemaining = velocity > 0 ? (total - completed) / velocity : Infinity;
    const estimatedCompletionDate = isFinite(estimatedRemaining) ? new Date(new Date().setDate(today.getDate() + estimatedRemaining)).toISOString().split('T')[0] : "N/A";

    const blockers = allMentions.filter(t => t.blockers).flatMap(t => JSON.parse(t.blockers));
    const helpNeeded = allMentions.filter(t => t.help_needed).flatMap(t => JSON.parse(t.help_needed));

    return {
        taskId: mainTask.id,
        taskTitle: mainTask.task_title,
        createdDate: mainTask.created_date.split('T')[0],
        daysElapsed,
        progressPercent: Math.round(progressPercent),
        subtasksCompleted: completed,
        subtasksTotal: total,
        velocity: velocity.toFixed(2),
        estimatedDaysRemaining: isFinite(estimatedRemaining) ? estimatedRemaining.toFixed(1) : "N/A",
        estimatedCompletionDate,
        blockers,
        helpNeeded
    };
}

/**
 * 4.5 Component: AI Analysis Engine
 */
async function generateTaskAnalysis(progressMetrics) {
    if (!progressMetrics) return "No progress data available for analysis.";

    const prompt = `
      You are a concise project manager. Based on the following data, provide a brief analysis (3-4 sentences).
      Task: "${progressMetrics.taskTitle}"
      Progress: ${progressMetrics.progressPercent}% complete (${progressMetrics.subtasksCompleted}/${progressMetrics.subtasksTotal} subtasks)
      Velocity: ${progressMetrics.velocity} subtasks/day
      Projected Completion: ${progressMetrics.estimatedCompletionDate}
      Blockers: ${progressMetrics.blockers.length > 0 ? progressMetrics.blockers.map(b => b.name).join(', ') : 'None'}
      Help Needed: ${progressMetrics.helpNeeded.length > 0 ? progressMetrics.helpNeeded.join(', ') : 'None'}
      Your analysis should cover status, velocity, projected completion, and a call to action for any blockers or help needed.
    `;

    const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }]
    });

    return response.choices[0].message.content;
}

/**
 * Main orchestrator function for generating the task continuity report.
 */
async function generateTaskContinuity(sessionId, newTasks) {
    await linkTasksAcrossMeetings(sessionId, newTasks);

    const parentTasks = await getUniqueParentTasksForSession(sessionId);

    const continuityReport = {
        previousTasks: [],
        blockers: [],
        aiAnalysis: ""
    };

    let analysisText = "";

    for (const task of parentTasks) {
        const progressMetrics = await calculateTaskProgress(task.id);
        if (progressMetrics) {
            const analysis = await generateTaskAnalysis(progressMetrics);
            continuityReport.previousTasks.push(progressMetrics);
            continuityReport.blockers.push(...progressMetrics.blockers);
            analysisText += analysis + "\n\n";
        }
    }
    
    continuityReport.aiAnalysis = analysisText.trim();
    return continuityReport;
}

module.exports = {
    generateTaskContinuity,
    calculateTaskProgress,
    generateTaskAnalysis
};