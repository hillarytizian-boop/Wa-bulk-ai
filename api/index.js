// Vercel serverless entry point. All /api/* requests are rewritten here (see vercel.json).
const { createApp } = require('../src/server');

const app = createApp();

module.exports = (req, res) => app(req, res);
