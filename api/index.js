'use strict';

// Vercel serverless entry point: the whole Express app runs as one function.
// Static files in public/ are served by Vercel's CDN (see vercel.json).
const { loadConfig } = require('../server/config');
const { createApp } = require('../server/app');

let handler;
try {
  handler = createApp(loadConfig()).app;
} catch (err) {
  // Never leak configuration details to clients.
  console.error(`[fatal] ${err.message}`);
  handler = (_req, res) => {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Server misconfigured.' }));
  };
}

module.exports = handler;
