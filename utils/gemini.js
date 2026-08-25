const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

async function testGemini() {
  const interaction = await ai.interactions.create({
    model: "gemini-3.6-flash",
    input: "Say hello to Attent75 in one short sentence.",
    store: false
  });

  return interaction.output_text;
}

async function extractRoutine(filePath, mimeType) {

  console.time("GEMINI FILE UPLOAD");


  const uploadedFile = await ai.files.upload({
    file: filePath,
    config: {
      mimeType: mimeType
    }
  });

  console.timeEnd("GEMINI FILE UPLOAD");

  console.time("GEMINI ANALYSIS");

  console.log("Gemini file uploaded:", uploadedFile.uri);

  const interaction = await ai.interactions.create({
    model: "gemini-3.6-flash",

    // This is a straightforward "read the image, extract structured JSON"
    // task — it doesn't need deep multi-step reasoning. Gemini 3.x models
    // default to thinking_level "high", which spends extra time on internal
    // reasoning before answering. Lowering it here removes that overhead
    // without changing the model, prompt, or expected output format.
    generation_config: {
      thinking_level: "low"
    },

    input: [
      {
        type: "text",
       text: `
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
`
      },
      {
        type: "image",
        uri: uploadedFile.uri,
        mime_type: uploadedFile.mimeType
      }
    ],

    store: false
  });

  console.timeEnd("GEMINI ANALYSIS");

  return interaction.output_text;
}


module.exports = {
  ai,
  testGemini,
  extractRoutine
};