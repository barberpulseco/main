// Vercel serverless entry: every /api/* request is handled by the Express app.
// If the app can't start (usually a missing environment variable), answer every
// request with the reason instead of crashing with a bare 500.
let handler;
try {
  handler = require('../lib/app');
} catch (err) {
  console.error('Startup failed:', err.message);
  handler = (_req, res) => {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: `Server setup problem: ${err.message}` }));
  };
}
module.exports = handler;
