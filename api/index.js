// Vercel serverless entry point. src/bootstrap.js exports a callable (req, res) handler that
// builds the Express app lazily, so this file only has to re-export it.
module.exports = require('../src/bootstrap');
