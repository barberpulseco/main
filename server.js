// Local dev server: `npm run dev`. On Vercel, api/index.js is used instead.
try { process.loadEnvFile?.('.env'); } catch {}
const app = require('./lib/app');
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Barber Pulse running → http://localhost:${port}`));
