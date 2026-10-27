// Vercel catch-all: maps /api/<anything> to the app without needing a rewrite rule.
const { createApp } = require('../src/server');

const app = createApp();

module.exports = (req, res) => app(req, res);
