const express = require('express');
const router = express.Router();
const { getTaskAndSubtasks } = require('./database');
const { calculateTaskProgress, generateTaskAnalysis } = require('./taskContinuity');

// GET /api/tasks/:taskId/history
router.get('/:taskId/history', async (req, res) => {
    try {
        const { taskId } = req.params;
        const history = await getTaskAndSubtasks(taskId);
        if (!history || history.length === 0) {
            return res.status(404).json({ message: 'Task not found.' });
        }
        res.json(history);
    } catch (error) {
        console.error('Error fetching task history:', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});

// GET /api/tasks/:taskId/progress
router.get('/:taskId/progress', async (req, res) => {
    try {
        const { taskId } = req.params;
        const progressMetrics = await calculateTaskProgress(taskId);
        if (!progressMetrics) {
            return res.status(404).json({ message: 'Could not calculate progress for task.' });
        }
        const aiAnalysis = await generateTaskAnalysis(progressMetrics);
        res.json({
            progressMetrics,
            aiAnalysis
        });
    } catch (error) {
        console.error('Error fetching task progress:', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});


module.exports = router;