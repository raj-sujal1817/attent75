const { GoogleGenAI } = require("@google/genai");
const { HOLIDAY_PROMPT } = require("./holidayParser");

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});


// ------------------------------------------------------------------
// Protection for the shared Gemini key
//
// - Only a few AI reads run at the same time (GEMINI_MAX_CONCURRENT, default 3).
//   Others wait in a short line; if the line is full the user is told to retry.
// - Every read has a time limit (GEMINI_TIMEOUT_MS, default 60 s), so a stuck
//   Google call cannot hold a user (and a slot) forever.
// - The file uploaded to Google is deleted after reading (it would otherwise stay
//   for 48 hours and fill the storage of the shared key).
//
// Errors carry status 503, so geminiErrors.js shows "AI is busy, try again in a
// few minutes" and the user's daily AI read is given back.
// ------------------------------------------------------------------

const MAX_CONCURRENT = Number(process.env.GEMINI_MAX_CONCURRENT) || 3;
const MAX_WAITING = Number(process.env.GEMINI_MAX_WAITING) || 15;
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 60000;

let running = 0;
const waiting = [];

function busyError(message) {
  const err = new Error(message);
  err.status = 503;
  err.code = "AI_BUSY";
  return err;
}

function acquireSlot() {
  if (running < MAX_CONCURRENT) {
    running++;
    return Promise.resolve();
  }

  if (waiting.length >= MAX_WAITING) {
    return Promise.reject(busyError("AI queue is full. UNAVAILABLE"));
  }

  return new Promise((resolve) => waiting.push(resolve));
}

function releaseSlot() {
  const next = waiting.shift();

  if (next) {
    next();            // hand the slot straight to the next waiting request
  } else {
    running--;
  }
}

function withTimeout(promise, ms) {
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(busyError("AI request timed out. UNAVAILABLE")), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Upload the file, run one Gemini call on it, always clean up, within the limits above.
async function readFileWithGemini(filePath, mimeType, buildRequest) {

  await acquireSlot();

  let uploadedFile = null;
  let finished = false;

  try {
    return await withTimeout((async () => {

      uploadedFile = await ai.files.upload({
        file: filePath,
        config: { mimeType: mimeType }
      });

      // We already gave up (timeout) while the upload was running: remove it now
      if (finished) {
        ai.files.delete({ name: uploadedFile.name }).catch(() => {});
        throw busyError("AI request timed out. UNAVAILABLE");
      }

      const interaction = await ai.interactions.create(buildRequest(uploadedFile));

      return interaction.output_text;
    })(), TIMEOUT_MS);

  } finally {
    finished = true;
    releaseSlot();

    if (uploadedFile && uploadedFile.name) {
      ai.files.delete({ name: uploadedFile.name }).catch(() => {});
    }
  }
}

async function testGemini() {
  const interaction = await ai.interactions.create({
    model: "gemini-3.6-flash",
    input: "Say hello to Attent75 in one short sentence.",
    store: false
  });

  return interaction.output_text;
}

const ROUTINE_PROMPT = `
Analyze this timetable image.

Extract all subjects and their weekly schedules.

Use the subject names exactly as written in the timetable schedule.
Do NOT expand or rename short subject names.

Return ONLY raw JSON.

Do NOT use markdown.
Do NOT use \`\`\`json.
Do NOT use code fences.

{
  "subjects": [
    {
      "name": "Subject Name",
      "schedule": [
        {
          "day": "Monday",
          "start": "10:00",
          "end": "11:00"
        }
      ]
    }
  ]
}

Rules:
- Include every visible class from the timetable.
- Use the exact subject name shown in the schedule.
- Do NOT expand short names into full names.
- Include laboratory classes.
- Preserve visible group identifiers such as G1, G2, A, B, C, D, etc.
- For example:
  - DSA Lab (G1) → DSA Lab (G1)
  - DSA Lab (G2) → DSA Lab (G2)
  - OS Lab (G1) → OS Lab (G1)
  - OS Lab (G2) → OS Lab (G2)
- Do NOT merge different groups into one subject.
- Do NOT remove or change group identifiers.
- If the same subject has a Tutorial entry, DO NOT create a separate Tutorial subject.
- Merge Tutorial classes into the main subject.
  Example:
  - DM → DM
  - DM (Tutorial) → DM
  Both schedules must be stored under the same "DM" subject.
- Do NOT treat Tutorial as a separate subject.
- Completely ignore Library classes.
- Do NOT create a subject named Library.
- Ignore Library even if it appears as a regular class, tutorial, lab, or group.
- Do not duplicate identical schedule entries for the same subject.
- Days: Monday to Saturday.
- Time format: HH:mm.
- Do not include room numbers, faculty names, subject codes, or other unrelated information.
`;

async function extractRoutine(filePath, mimeType) {

  return readFileWithGemini(filePath, mimeType, (uploadedFile) => ({
    model: "gemini-3.6-flash",

    // A straightforward "read the image, extract structured JSON" task:
    // it does not need deep multi-step reasoning, so keep thinking low (faster).
    generation_config: {
      thinking_level: "low"
    },

    input: [
      { type: "text", text: ROUTINE_PROMPT },
      {
        type: "image",
        uri: uploadedFile.uri,
        mime_type: uploadedFile.mimeType
      }
    ],

    store: false
  }));
}


// Reads a holiday notice (PDF / image) and returns Gemini's raw JSON text.
// Use parseHolidayResponse() (utils/holidayParser.js) to clean it.
async function extractHolidays(filePath, mimeType) {

  return readFileWithGemini(filePath, mimeType, (uploadedFile) => ({
    model: "gemini-3.6-flash",

    // Reading a table into JSON does not need deep reasoning.
    generation_config: {
      thinking_level: "low"
    },

    input: [
      { type: "text", text: HOLIDAY_PROMPT },
      {
        // Same call shape as extractRoutine (a PDF is passed the same way).
        type: "image",
        uri: uploadedFile.uri,
        mime_type: uploadedFile.mimeType
      }
    ],

    store: false
  }));
}

module.exports = {
  ai,
  testGemini,
  extractRoutine,
  extractHolidays
};