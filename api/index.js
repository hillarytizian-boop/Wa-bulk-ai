// Vercel serverless entry point. src/server.js exports a callable (req, res) handler that
// builds the Express app lazily, so this file only has to re-export it.
module.exports = require('../src/server');
