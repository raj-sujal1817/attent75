# Attent75 – what changed and how to deploy

## Files to replace
app.js, utils/gemini.js, utils/subjectStatusCounts.js, package.json, .gitignore, .env.example
Then: delete node_modules, run `npm install`, run `npm run dev`, test locally.

Also delete from your project: `utils/subjectStatusCounts 2.js`, `views/dashboard/dash_index 2.ejs`,
`views/partials/navbar 2.ejs`, all `.DS_Store`, and `uploads/routines/*` (a real timetable PDF is inside).

## What changed
- Rate limit: 100/IP/15min (was 30, shared Wi-Fi locked users out) + 15/email/15min for login/signup/forgot.
- trust proxy on in production (rate limiter sees real user IP).
- Session: touchAfter 24h (was a DB write on every request).
- MongoDB: pool size 20, 10s timeout, app exits if DB cannot connect (host restarts it); exits at start if MONGO_URI / SESSION_SECRET missing.
- Added helmet, compression, /health route, graceful shutdown, request timeouts, 404 page.
- Gemini: max 3 at a time, queue of 15, 60s timeout, uploaded files deleted, user gets "AI busy" + quota refunded.
- Dashboard: one DB pass instead of two; no NaN% when no working days.
- Holiday toggle: one bulkWrite instead of one query per class.
- Double tap on attendance no longer shows "Error Found".
- Semester form validated (dates valid, end after start).
- /holidays and default-notice checks no longer repeat on every page view.
- /test-gemini only in development; /time-check removed.
- User lookup per request now loads only the username.
- package.json cleaned (ngrok and ~60 internal packages removed; helmet, compression added).

## Speed round (after load test: dashboard ~10 pages/s, median 1.8 s)
- Dashboard: all database queries now run in ONE wave (was two waves one after the other); read-only data uses lean().
- Username for the navbar is remembered in memory for 5 minutes (one query less per page).
- Attendance tap: 3 lookups run together; the refreshed class list reuses data already loaded (about 7 round trips -> 3).
- Mark page loads subjects and marks together.
- minPoolSize 2 keeps database connections warm.
- BIGGEST WIN is outside the code: put the Atlas cluster in Mumbai (ap-south-1) and the app host in the nearest region.

## Deploy checklist (Render / Railway)
1. Push to GitHub (check `git status`: no .env, no uploads, no node_modules).
2. MongoDB Atlas: allow the host's IP (or 0.0.0.0/0 for free tier), use a dedicated DB user.
3. Host settings: Build `npm install`, Start `npm start`, Health check path `/health`.
4. Set every variable from .env.example, with NODE_ENV=production.
5. Email: Gmail allows ~500 mails/day. For real users use Brevo / Resend / SES SMTP (only SMTP_* values change).
6. Open the live URL: sign up, verify OTP, add semester, mark attendance, upload routine.
7. Load test from your laptop: `npx autocannon -c 50 -d 20 https://YOUR-URL/health`
