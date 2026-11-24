require('dotenv').config();

const { testGemini, extractRoutine, extractHolidays } = require("./utils/gemini");

const multer = require("multer");

const upload = multer({
  dest: "uploads/routines/",

  limits: {
    fileSize: 10 * 1024 * 1024 //10MB
  }

});

// Holiday notice upload: same 10MB limit as the routine import,
// but the file type is also checked here (PDF / JPG / JPEG / PNG only).
const HOLIDAY_MAX_MB = 10;

const holidayUpload = multer({
  dest: "uploads/holidays/",

  limits: {
    fileSize: HOLIDAY_MAX_MB * 1024 * 1024
  },

  fileFilter: (req, file, cb) => {
    const goodType = ["application/pdf", "image/jpeg", "image/png"].includes(file.mimetype);
    const goodName = /\.(pdf|jpe?g|png)$/i.test(file.originalname);

    if (goodType && goodName) {
      return cb(null, true);
    }

    const err = new Error("Unsupported file type.");
    err.code = "UNSUPPORTED_FILE_TYPE";
    cb(err);
  }
});

const express = require("express");
const mongoose = require("mongoose");

const { DateTime } = require("luxon");

const dns = require("dns");

// Public DNS is only forced on a developer machine (some home networks cannot
// resolve MongoDB Atlas). Hosting platforms have working DNS, so leave it alone there.
if (process.env.NODE_ENV !== "production") {
  dns.setServers(["1.1.1.1", "8.8.8.8"]);
}

const { 
  nowIST,
  nowISTDate,
  startOfTodayIST,
  endOfTodayIST,
  formattedToday,
  startOfDayIST,
  endOfDayIST } = require("./utils/date");


const bcrypt = require("bcrypt");
const rateLimit = require("express-rate-limit");
const otp = require("./utils/otp");
const { sendOtpEmail } = require("./utils/mailer");
const { describeGeminiError } = require("./utils/geminiErrors");
const aiQuota = require("./utils/aiQuota");
const helmet = require("helmet");
const compression = require("compression");
const session = require("express-session");
const MongoStore = require("connect-mongo").default;

const path = require("path");
const ejsMate = require("ejs-mate");
const methodOverride = require("method-override");
const app = express();

// Behind a proxy (Render / Railway etc.) the real visitor IP and "https" come from
// the proxy headers. Without this, every user looks like the same IP to the rate
// limiter and secure cookies do not work. Set TRUST_PROXY=0 to switch it off.
const IS_PROD = process.env.NODE_ENV === "production";

if (IS_PROD || process.env.TRUST_PROXY === "1") {
  app.set("trust proxy", 1);
}

app.disable("x-powered-by");

const { csrfSync } = require("csrf-sync");

const {
  generateToken,
  invalidCsrfTokenError,
  csrfSynchronisedProtection
} = csrfSync({
  getTokenFromRequest: (req) =>
    req.body?._csrf || req.headers["x-csrf-token"]
});



const markMissedAttendance = require("./utils/markMissedAttendance");

const userInfo = require("./models/loginfo");  // userInfo is a collection of u75 db..
const userSubject = require("./models/subjectsModel")  // userSubject is a collection of u75 db..
const semester = require("./models/semesterSet")  // semester is a collection of u75 db..
const attendanceCalculator = require("./utils/attendanceCalculator");
const calculateTotalClasses = require("./utils/attendanceCalculator");
const dailyMark = require("./models/attendReview");
const getWorkingDays = require("./utils/workingDaysCalci");
const needToGet75 = require("./utils/needClassesCalci");
const { getSubjectStatusCounts, getSubjectStatusCountsSplit, getCountsFor } = require("./utils/subjectStatusCounts");
const fs = require("fs");

// Holidays
const HolidayNotice = require("./models/holidayNotice");
const HolidayState = require("./models/holidayState");
const {
  parseHolidayResponse,
  parseYmd,
  cleanName,
  MAX_HOLIDAYS,
  MAX_TITLE_LENGTH
} = require("./utils/holidayParser");
const {
  applyNotice,
  removeNotice,
  reapplyAppliedNotices,
  ensureDefaultNotices,
  getNoticesForUser,
  findAccessibleNotice
} = require("./utils/holidayService");



// MongoDB connection

const dbUrl = process.env.MONGO_URI;

// Stop at start-up with a clear message instead of failing later on every request
for (const name of ["MONGO_URI", "SESSION_SECRET"]) {
  if (!process.env[name]) {
    console.error(`Missing ${name} in environment variables. Server not started.`);
    process.exit(1);
  }
}

mongoose.connect(dbUrl, {
  maxPoolSize: Number(process.env.MONGO_POOL_SIZE) || 20,
  minPoolSize: 2,   // keep a few connections warm so the first visit is not slow
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000
})
.then(() => console.log("CONNECTED"))
.catch(err => {
  // A server without a database only shows broken pages, so stop and let the host restart it
  console.error("MongoDB connection failed:", err);
  process.exit(1);
});


// Health check (before sessions, so monitors do not create session records)

app.get("/health", (req, res) => {
  const dbUp = mongoose.connection.readyState === 1;
  res.status(dbUp ? 200 : 503).json({ ok: dbUp });
});

// Smaller responses, and standard security headers.
// CSP is off because the pages use inline styles/scripts and CDN files.
app.use(compression());
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));


//Session

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,

    store: MongoStore.create({
      mongoUrl: dbUrl,
      // rolling:true would otherwise rewrite the session in MongoDB on EVERY request.
      // Now it is refreshed at most once a day (data changes are still saved at once).
      touchAfter: 24 * 3600
    }),

    cookie: {
      maxAge: 30*24*60*60*1000,
      httpOnly: true,
      sameSite: "lax",
      secure: IS_PROD
    },

    rolling: true
  })

);

app.engine("ejs", ejsMate);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(methodOverride("_method"));
app.use(express.urlencoded({ extended: true}));
app.use(express.static(path.join(__dirname, "/public")));


// Globally execute for all .ejs file...//

app.use((req, res, next) => {
  res.locals.formateTime = function(time){
    let [hours, minutes] = time.split(":");
    hours = Number(hours);
    
    let ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12 || 12;

    return `${hours}:${minutes} ${ampm}`;
  };

  next();

});



//====================================================
// Import routine (multipart) - multer PEHLE, CSRF BAAD MEIN
//
// Ye route global CSRF middleware se upar rehna zaroori hai,
// kyunki multipart form ka _csrf field multer hi parse karta hai.
// requireLogin function declaration hai (hoisted), isliye yahan use ho sakta hai.
//====================================================
// Same idea as the holiday one: show the routine upload page again with a message
async function renderRoutineImportError(req, res, status, message) {

  let currentUser = null;
  let quota;

  try {
    currentUser = await userInfo.findById(req.session.userId);
    quota = await aiQuota.getQuota(req.session.userId);
  } catch (err) {
    console.error("Could not load data for routine import page:", err);
  }

  return res.status(status).render("subjects/import_routine.ejs", {
    error: message,
    aiQuota: quota,
    csrfToken: generateToken(req),
    user: currentUser || { username: "User" }
  });
}

app.post(
  "/subjects/import-routine",

  requireLogin,

  function (req, res, next) {
    upload.single("routineFile")(req, res, function (err) {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).send(
            "File is too large (max 10MB). Please compress it to under 2MB and try again."
          );
        }
        return res.status(400).send("Failed to upload file. Please try again.");
      }
      next();
    });
  },

  // multer ke baad chalta hai, isliye req.body._csrf ab mil jayega
  csrfSynchronisedProtection,

  async (req, res) => {
    let aiSlot = null;

    try {
      if (!req.file) {
        return res.status(400).send("Please upload a routine file.");
      }

      // Each user has a few AI reads per day (the free Gemini key is shared by everybody)
      const slot = await aiQuota.reserve(req.session.userId);

      if (!slot.ok) {
        return renderRoutineImportError(
          req, res, 429,
          aiQuota.limitMessage(slot.quota, "Until then you can add your subjects manually.")
        );
      }

      aiSlot = slot;

      const routineData = await extractRoutine(req.file.path, req.file.mimetype);
      const parsedRoutine = JSON.parse(routineData);

      req.session.importedRoutine = parsedRoutine;

      // Ye route res.locals.user wale middleware se pehle hai,
      // isliye navbar ke liye user yahan khud fetch karna padta hai.
      const currentUser = await userInfo.findById(req.session.userId);

      res.render("subjects/routine_select.ejs", {
        routineData: parsedRoutine,
        csrfToken: generateToken(req),
        user: currentUser
      });

    } catch (err) {
      console.error("Routine extraction error:", err);

      // Free Gemini limit finished / service busy: tell the user when to try again
      const aiProblem = describeGeminiError(err);

      if (aiProblem.kind !== "other") {
        // Not the user's fault: give the AI read back
        if (aiSlot) await aiQuota.refund(req.session.userId, aiSlot.day);
        if (aiProblem.retryAfterSeconds) res.set("Retry-After", String(aiProblem.retryAfterSeconds));
        return renderRoutineImportError(req, res, aiProblem.status, aiProblem.message);
      }

      return renderRoutineImportError(
        req, res, 500,
        "Could not read this routine. Please try again with a clearer PDF or image."
      );
    } finally {
      if (req.file?.path) {
        try {
          await fs.promises.unlink(req.file.path);
        } catch (deleteErr) {
          console.error("Failed to delete temporary routine file:", deleteErr);
        }
      }
    }
  }
);


//====================================================
// Import holiday notice (multipart) - same pattern as import-routine:
// multer PEHLE, CSRF BAAD MEIN, aur ye global CSRF se upar hona zaroori hai.
//====================================================

const MAX_NOTICES_PER_USER = 20;

// Render the upload page again with a message (used for every upload problem).
async function renderHolidayImportError(req, res, status, message) {

  let currentUser = null;
  let quota;

  try {
    currentUser = await userInfo.findById(req.session.userId);
    quota = await aiQuota.getQuota(req.session.userId);
  } catch (err) {
    console.error("Could not load user for holiday import page:", err);
  }

  return res.status(status).render("holidays/holiday_import.ejs", {
    error: message,
    aiQuota: quota,
    csrfToken: generateToken(req),
    user: currentUser || { username: "User" }
  });
}

// Review page ("select page"): the dates AI found, before anything is saved.
async function renderHolidayReview(req, res, status, data, message) {

  let currentUser = null;
  let sem = null;

  try {
    [currentUser, sem] = await Promise.all([
      userInfo.findById(req.session.userId),
      semester.findOne({ user: req.session.userId }).lean()
    ]);
  } catch (err) {
    console.error("Could not load data for holiday review page:", err);
  }

  return res.status(status).render("holidays/holiday_select.ejs", {
    holidayData: data,
    semester: sem,
    error: message,
    csrfToken: generateToken(req),
    user: currentUser || { username: "User" }
  });
}

app.post(
  "/holidays/import",

  requireLogin,

  function (req, res, next) {
    holidayUpload.single("holidayFile")(req, res, function (err) {
      if (err) {

        if (err.code === "LIMIT_FILE_SIZE") {
          return renderHolidayImportError(
            req, res, 400,
            `File is too large (max ${HOLIDAY_MAX_MB}MB). Please compress it and try again.`
          );
        }

        if (err.code === "UNSUPPORTED_FILE_TYPE") {
          return renderHolidayImportError(
            req, res, 400,
            "Unsupported file type. Please upload a PDF, JPG, JPEG or PNG file."
          );
        }

        console.error("Holiday upload error:", err);
        return renderHolidayImportError(req, res, 400, "Failed to upload file. Please try again.");
      }

      next();
    });
  },

  // multer ke baad: ab req.body._csrf mil jayega.
  // If the token is wrong, delete the uploaded file before failing.
  function (req, res, next) {
    csrfSynchronisedProtection(req, res, function (err) {
      if (err && req.file && req.file.path) {
        fs.unlink(req.file.path, () => {});
      }
      next(err);
    });
  },

  async (req, res) => {
    let aiSlot = null;

    try {

      if (!req.file) {
        return renderHolidayImportError(req, res, 400, "Please choose a file to upload.");
      }

      const noticeCount = await HolidayNotice.countDocuments({ user: req.session.userId });

      if (noticeCount >= MAX_NOTICES_PER_USER) {
        return renderHolidayImportError(
          req, res, 400,
          `You can keep up to ${MAX_NOTICES_PER_USER} imported notices. Please delete one you no longer need.`
        );
      }

      // Each user has a few AI reads per day (the free Gemini key is shared by everybody)
      const slot = await aiQuota.reserve(req.session.userId);

      if (!slot.ok) {
        return renderHolidayImportError(
          req, res, 429,
          aiQuota.limitMessage(slot.quota, "Until then you can still apply the BEU notice or your saved notices.")
        );
      }

      aiSlot = slot;

      const rawText = await extractHolidays(req.file.path, req.file.mimetype);
      const parsed = parseHolidayResponse(rawText);

      // Nothing is saved yet: the user reviews the dates first
      // (the review form sends everything back when they press Save).
      return renderHolidayReview(req, res, 200, parsed);

    } catch (err) {
      console.error("Holiday extraction error:", err);

      // Free Gemini limit finished / service busy: tell the user when to try again
      const aiProblem = describeGeminiError(err);

      if (aiProblem.kind !== "other") {
        // Not the user's fault: give the AI read back
        if (aiSlot) await aiQuota.refund(req.session.userId, aiSlot.day);
        return renderHolidayImportError(req, res, aiProblem.status, aiProblem.message);
      }

      return renderHolidayImportError(
        req, res, 500,
        "Could not read this notice. Please try again with a clearer PDF or image."
      );

    } finally {
      if (req.file && req.file.path) {
        try {
          await fs.promises.unlink(req.file.path);
        } catch (deleteErr) {
          console.error("Failed to delete temporary holiday file:", deleteErr);
        }
      }
    }
  }
);


// Global CSRF protection (iske neeche ke saare POST routes protected hain)
app.use(csrfSynchronisedProtection);

app.use((req, res, next) => {
  res.locals.csrfToken = generateToken(req);
  next();
});

// One-time messages that survive a redirect (success / error banners).
// Views already show `success` and `error` when they are set.
app.use((req, res, next) => {
  if (req.session && req.session.flash) {
    res.locals.success = req.session.flash.success;
    res.locals.error = req.session.flash.error;
    delete req.session.flash;
  }
  next();
});


//home route 

app.get("/", (req, res) => {
  if(req.session.userId) {
    return res.redirect("/dashboard");
  }
  res.redirect("/login");
});

//====================================================
// AUTH: signup, e-mail OTP verification, login, forgot password
//
// - New account: created with emailVerified:false -> OTP mailed -> after the
//   correct code the user is logged in automatically (no second login).
// - Old accounts (no emailVerified field) verify once, at their next login.
// - OTP code is stored only as a hash (see utils/otp.js), expires in 10 minutes,
//   allows 5 wrong tries, and can be re-sent after 60 seconds (max 5 per hour).
//====================================================

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT) || 100,   // per IP per 15 minutes (a hostel / college Wi-Fi shares one IP)
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).send("Too many attempts. Please wait a few minutes and try again.");
  }
});

// Per e-mail limit: stops guessing passwords / codes for one account even when the
// attacker changes IP. Counted per e-mail address, so one user cannot block others.
const emailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.EMAIL_RATE_LIMIT) || 15,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  keyGenerator: (req) => "email:" + String((req.body && req.body.email) || "").trim().toLowerCase().slice(0, 254),
  skip: (req) => !(req.body && req.body.email),
  handler: (req, res) => {
    res.status(429).send("Too many attempts for this account. Please wait a few minutes and try again.");
  }
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;   // bcrypt only reads the first 72 bytes

// Used so a wrong e-mail takes about as long as a wrong password
const DUMMY_HASH = bcrypt.hashSync("attent75-dummy", 10);

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Normal lookup first; the second lookup finds old accounts that were saved
// with capital letters before e-mails were lowercased.
async function findUserByEmail(email) {
  const exact = await userInfo.findOne({ email });
  if (exact) return exact;
  return userInfo.findOne({ email: new RegExp("^" + escapeRegex(email) + "$", "i") });
}

function passwordProblem(password) {
  if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Password can be at most ${PASSWORD_MAX} characters.`;
  return null;
}

// Makes a code, saves its hash, e-mails it. Returns { ok:true } or { ok:false, reason, wait }.
async function sendCode(user, purpose) {
  const gate = otp.canSend(user);
  if (!gate.ok) return gate;

  const before = {
    otpLastSentAt: user.otpLastSentAt,
    otpWindowStart: user.otpWindowStart,
    otpSendCount: user.otpSendCount
  };

  const code = otp.issueCode(user, purpose);
  await user.save();

  try {
    await sendOtpEmail(user.email, user.username, code, purpose);
  } catch (err) {
    console.error("OTP email failed:", err);

    // The user never got a code, so do not make them wait for the next try
    user.otpLastSentAt = before.otpLastSentAt;
    user.otpWindowStart = before.otpWindowStart;
    user.otpSendCount = before.otpSendCount;
    await user.save();

    return { ok: false, reason: "mail" };
  }

  return { ok: true };
}

// Log the user in (fresh session) and send them to the right first page.
function startSession(req, res, user) {
  req.session.regenerate((err) => {
    if (err) {
      return res.status(500).send("Unable to create a secure session. Please try again.");
    }

    req.session.userId = user._id;

    req.session.save(async (saveErr) => {
      if (saveErr) {
        return res.status(500).send("Unable to save session. Please try again.");
      }

      let to = "/";

      try {
        const sem = await semester.findOne({ user: user._id });
        if (!sem) to = "/semester/setup";   // brand new user: set up the semester first
      } catch (e) {
        console.error("Semester check after login failed:", e);
      }

      res.redirect(to);
    });
  });
}

function flashTo(req, res, type, message, to) {
  req.session.flash = { [type]: message };
  req.session.save(() => res.redirect(to));
}

function waitText(seconds) {
  return `Please wait ${seconds} second${seconds === 1 ? "" : "s"} before asking for a new code.`;
}

const LIMIT_TEXT = "Too many codes were sent to this email. Please try again after an hour.";
const MAIL_FAIL_TEXT = "We could not send the email right now. Please check the address and try again in a minute.";


// ---------------- Signup ----------------

app.get("/signup", (req, res) => {
  if (req.session.userId) return res.redirect("/");
  res.render("users/signup.ejs");
});

app.post("/signup", authLimiter, emailLimiter, async (req, res) => {

  const username = String(req.body.username || "").replace(/\s+/g, " ").trim();
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || "");

  const formData = { username, email };

  const fail = (message) =>
    res.status(400).render("users/signup.ejs", { error: message, formData });

  try {

    if (username.length < 2 || username.length > 30) {
      return fail("Username must be 2 to 30 characters.");
    }

    if (!EMAIL_RE.test(email) || email.length > 254) {
      return fail("Please enter a valid email address.");
    }

    const problem = passwordProblem(password);
    if (problem) return fail(problem);

    const existing = await findUserByEmail(email);

    // A real account (old, or already verified) cannot be taken over.
    // Only a signup that never finished (emailVerified === false) can be started again.
    if (existing && existing.emailVerified !== false) {
      return fail("An account with this email already exists. Please sign in.");
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    let user = existing;

    if (user) {
      user.username = username;
      user.password = hashedPassword;
    } else {
      user = new userInfo({ username, email, password: hashedPassword, emailVerified: false });
    }

    await user.save();

    const sent = await sendCode(user, "verify");

    if (!sent.ok && sent.reason === "mail") return fail(MAIL_FAIL_TEXT);
    if (!sent.ok && sent.reason === "limit") return fail(LIMIT_TEXT);
    // reason "wait": a code was sent a moment ago, just continue to the code page

    req.session.pendingVerify = String(user._id);

    return req.session.save(() => res.redirect("/verify-email"));

  } catch (err) {

    if (err && err.code === 11000) {
      return fail("An account with this email already exists. Please sign in.");
    }

    console.error("Signup error:", err);
    return res.status(500).render("users/signup.ejs", {
      error: "Something went wrong. Please try again.",
      formData
    });
  }
});


// ---------------- Verify e-mail ----------------

async function loadPendingUser(req) {
  const id = req.session.pendingVerify;
  if (!id || !mongoose.isValidObjectId(id)) return null;
  return userInfo.findById(id);
}

function renderVerify(res, user, status, extra) {
  return res.status(status).render("users/verify_email.ejs", Object.assign({
    maskedEmail: otp.maskEmail(user.email),
    resendIn: otp.resendWaitSeconds(user)
  }, extra || {}));
}

app.get("/verify-email", async (req, res) => {
  try {
    if (req.session.userId) return res.redirect("/");

    const user = await loadPendingUser(req);
    if (!user || user.emailVerified === true) return res.redirect("/login");

    return renderVerify(res, user, 200);

  } catch (err) {
    console.error("Verify page error:", err);
    return res.redirect("/login");
  }
});

app.post("/verify-email", authLimiter, async (req, res) => {
  try {
    const user = await loadPendingUser(req);
    if (!user) return res.redirect("/login");

    if (user.emailVerified === true) return startSession(req, res, user);

    const result = otp.checkCode(user, "verify", req.body.code);

    if (result === "ok") {
      user.emailVerified = true;
      await user.save();
      return startSession(req, res, user);   // new users go straight into the app
    }

    await user.save();

    const message =
      result === "wrong"
        ? `That code is not correct. ${Math.max(0, otp.OTP_MAX_ATTEMPTS - user.otpAttempts)} tries left.`
        : result === "expired"
          ? "This code has expired. Press Resend code to get a new one."
          : result === "locked"
            ? "Too many wrong tries. Press Resend code to get a new one."
            : "No active code. Press Resend code to get a new one.";

    return renderVerify(res, user, 400, { error: message });

  } catch (err) {
    console.error("Verify error:", err);
    return res.status(500).send("Something went wrong. Please try again.");
  }
});

app.post("/verify-email/resend", authLimiter, async (req, res) => {
  try {
    const user = await loadPendingUser(req);
    if (!user || user.emailVerified === true) return res.redirect("/login");

    const sent = await sendCode(user, "verify");

    if (sent.ok) {
      return flashTo(req, res, "success", `A new code was sent to ${otp.maskEmail(user.email)}.`, "/verify-email");
    }

    if (sent.reason === "wait") return flashTo(req, res, "error", waitText(sent.wait), "/verify-email");
    if (sent.reason === "limit") return flashTo(req, res, "error", LIMIT_TEXT, "/verify-email");

    return flashTo(req, res, "error", MAIL_FAIL_TEXT, "/verify-email");

  } catch (err) {
    console.error("Resend error:", err);
    return flashTo(req, res, "error", "Something went wrong. Please try again.", "/verify-email");
  }
});

// "Wrong email? Go back": a signup that never finished is removed so the
// address is free again. Old accounts (emailVerified undefined) are never touched.
app.post("/verify-email/change", authLimiter, async (req, res) => {
  try {
    const user = await loadPendingUser(req);

    if (user && user.emailVerified === false) {
      await userInfo.deleteOne({ _id: user._id, emailVerified: false });
    }
  } catch (err) {
    console.error("Change email error:", err);
  }

  delete req.session.pendingVerify;
  req.session.save(() => res.redirect("/signup"));
});


// ---------------- Login ----------------

app.get("/login", (req, res) => {
  if (req.session.userId) return res.redirect("/");
  res.render("users/login.ejs");
});

app.post("/login", authLimiter, emailLimiter, async (req, res) => {

  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || "");

  const fail = (message) =>
    res.status(400).render("users/login.ejs", { error: message, formData: { email } });

  try {

    const user = EMAIL_RE.test(email) ? await findUserByEmail(email) : null;

    const isMatch = await bcrypt.compare(password, user ? user.password : DUMMY_HASH);

    // One message for both cases, so nobody can use this page to find out which emails are registered
    if (!user || !isMatch) {
      return fail("Incorrect email or password.");
    }

    // Old accounts and unfinished signups must verify their email first
    if (user.emailVerified !== true) {

      const sent = await sendCode(user, "verify");

      if (!sent.ok && sent.reason === "mail") return fail(MAIL_FAIL_TEXT);

      req.session.pendingVerify = String(user._id);
      req.session.flash = {
        success: sent.ok
          ? `Please verify your email to continue. We sent a code to ${otp.maskEmail(user.email)}.`
          : "Please verify your email to continue. Use the code we sent earlier, or press Resend code."
      };

      return req.session.save(() => res.redirect("/verify-email"));
    }

    return startSession(req, res, user);

  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).render("users/login.ejs", {
      error: "Something went wrong. Please try again.",
      formData: { email }
    });
  }
});


// ---------------- Forgot / reset password ----------------
// The pages never say whether an email is registered.

app.get("/forgot-password", (req, res) => {
  if (req.session.userId) return res.redirect("/");
  res.render("users/forgot_password.ejs");
});

app.post("/forgot-password", authLimiter, emailLimiter, async (req, res) => {

  const email = normalizeEmail(req.body.email);

  try {

    if (!EMAIL_RE.test(email)) {
      return res.status(400).render("users/forgot_password.ejs", {
        error: "Please enter a valid email address.",
        formData: { email }
      });
    }

    const user = await findUserByEmail(email);

    if (user) {
      const sent = await sendCode(user, "reset");

      if (!sent.ok && sent.reason === "mail") {
        return res.status(500).render("users/forgot_password.ejs", {
          error: MAIL_FAIL_TEXT,
          formData: { email }
        });
      }
    }

    req.session.pendingReset = email;
    req.session.resetSentAt = Date.now();
    req.session.flash = { success: `If an account exists for ${otp.maskEmail(email)}, we sent a code to it.` };

    return req.session.save(() => res.redirect("/reset-password"));

  } catch (err) {
    console.error("Forgot password error:", err);
    return res.status(500).render("users/forgot_password.ejs", {
      error: "Something went wrong. Please try again.",
      formData: { email }
    });
  }
});

function resetResendIn(req) {
  const left = 60 - Math.floor((Date.now() - (req.session.resetSentAt || 0)) / 1000);
  return left > 0 ? left : 0;
}

function renderReset(req, res, status, extra) {
  return res.status(status).render("users/reset_password.ejs", Object.assign({
    maskedEmail: otp.maskEmail(req.session.pendingReset),
    resendIn: resetResendIn(req)
  }, extra || {}));
}

app.get("/reset-password", (req, res) => {
  if (req.session.userId) return res.redirect("/");
  if (!req.session.pendingReset) return res.redirect("/forgot-password");
  return renderReset(req, res, 200);
});

app.post("/reset-password", authLimiter, async (req, res) => {
  try {
    const email = req.session.pendingReset;
    if (!email) return res.redirect("/forgot-password");

    const password = String(req.body.password || "");
    const confirm = String(req.body.confirmPassword || "");

    const problem = passwordProblem(password);
    if (problem) return renderReset(req, res, 400, { error: problem });

    if (password !== confirm) {
      return renderReset(req, res, 400, { error: "The two passwords do not match." });
    }

    const user = await findUserByEmail(email);

    // Same message for "no such account" and "wrong / expired code"
    const badCode = "That code is wrong or has expired. Check the code, or press Resend code.";

    if (!user) return renderReset(req, res, 400, { error: badCode });

    const result = otp.checkCode(user, "reset", req.body.code);

    if (result !== "ok") {
      await user.save();
      return renderReset(req, res, 400, { error: badCode });
    }

    user.password = await bcrypt.hash(password, 10);
    user.emailVerified = true;   // they just proved they own this email
    await user.save();

    delete req.session.pendingReset;
    delete req.session.resetSentAt;

    return flashTo(req, res, "success", "Password changed. Please sign in with your new password.", "/login");

  } catch (err) {
    console.error("Reset password error:", err);
    return res.status(500).send("Something went wrong. Please try again.");
  }
});

app.post("/reset-password/resend", authLimiter, async (req, res) => {
  try {
    const email = req.session.pendingReset;
    if (!email) return res.redirect("/forgot-password");

    if (resetResendIn(req) > 0) {
      return flashTo(req, res, "error", waitText(resetResendIn(req)), "/reset-password");
    }

    const user = await findUserByEmail(email);

    if (user) {
      const sent = await sendCode(user, "reset");

      if (!sent.ok && sent.reason === "mail") {
        return flashTo(req, res, "error", MAIL_FAIL_TEXT, "/reset-password");
      }
    }

    req.session.resetSentAt = Date.now();

    return flashTo(req, res, "success", `If an account exists for ${otp.maskEmail(email)}, we sent a new code to it.`, "/reset-password");

  } catch (err) {
    console.error("Reset resend error:", err);
    return flashTo(req, res, "error", "Something went wrong. Please try again.", "/reset-password");
  }
});


//middilware function 

const userCache = new Map();

app.use(async (req, res, next) => {
  try {
    res.locals.user = null;

    if (!req.session || !req.session.userId) {
      return next();
    }

    // The navbar only needs the username. Remember it in memory for 5 minutes so
    // most requests skip this database round trip.
    const uidKey = String(req.session.userId);
    const cached = userCache.get(uidKey);

    let user = cached && Date.now() - cached.at < 5 * 60 * 1000 ? cached.user : null;

    if (!user) {
      user = await userInfo.findById(req.session.userId).select("username").lean();

      if (user) {
        if (userCache.size > 20000) userCache.clear();
        userCache.set(uidKey, { user, at: Date.now() });
      }
    }

    if (!user) {
      return req.session.destroy((err) => {
        if (err) {
          return next(err);
        }

        res.clearCookie("connect.sid");
        return res.redirect("/login");
      });
    }

    res.locals.user = user;
    next();
  } catch (err) {
    next(err);
  }
});


/* Authentication guard for protected routes */

function requireLogin(req, res, next) {
  if (!req.session || !req.session.userId) {

    // API requests receive JSON instead of an HTML redirect
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({
        success: false,
        message: "Please login to continue."
      });
    }

    // Browser page requests go to login
    return res.redirect("/login");
  }

  next();
}

// Protect all routes defined AFTER this line
app.use(requireLogin);


// Gemini connection test: development only (in production any logged-in user
// could call it and use up the shared AI quota).
if (!IS_PROD) {
  app.get("/test-gemini", async (req, res) => {
    try {
      const result = await testGemini();
      res.send(`<h1>Gemini Connected ✅</h1><p>${result}</p>`);
    } catch (err) {
      console.error("Gemini Error:", err);
      res.status(500).send("Gemini connection failed.");
    }
  });
}


//====================================================
// HOLIDAYS
// (the upload route POST /holidays/import is defined above, before CSRF)
//====================================================

// Everyone gets the default notice(s) applied the first time they come in.
// (Remembered in memory so the 5 busiest pages do not repeat the check on every visit.)
const defaultsChecked = new Set();

app.get(
  ["/dashboard", "/attendance/mark", "/attendance/history", "/subjects", "/holidays"],
  async (req, res, next) => {
    const uid = String(req.session.userId);

    // Already checked for this user since the server started: skip the database work
    if (!defaultsChecked.has(uid)) {
      try {
        await ensureDefaultNotices(req.session.userId);

        if (defaultsChecked.size > 20000) defaultsChecked.clear();   // keep memory small
        defaultsChecked.add(uid);
      } catch (err) {
        console.error("Default holiday notice error:", err);
      }
    }
    next();
  }
);

// Re-check applied notices after a subject / schedule / semester change,
// so new classes also become Holiday and removed classes stop being Holiday.
async function refreshHolidays(userId) {
  try {
    lastHolidayRefresh.set(String(userId), Date.now());
    await reapplyAppliedNotices(userId);
  } catch (err) {
    console.error("Holiday refresh error:", err);
  }
}

const lastHolidayRefresh = new Map();

function flashAndRedirect(req, res, type, message, to) {
  req.session.flash = { [type]: message };
  req.session.save(() => res.redirect(to || "/holidays"));
}

// qs turns holidays[0], holidays[1] ... into an object once there are
// more than 20 rows, so accept both shapes.
function toList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

app.get("/holidays", async (req, res) => {
  try {
    const userId = req.session.userId;

    // Quietly repairs anything that got out of step. Every route that changes
    // subjects / semester already calls refreshHolidays itself, so this safety
    // net only needs to run now and then (not on every page view).
    const key = String(userId);
    const last = lastHolidayRefresh.get(key) || 0;

    if (Date.now() - last > 10 * 60 * 1000) {
      await refreshHolidays(userId);

      if (lastHolidayRefresh.size > 20000) lastHolidayRefresh.clear();
      lastHolidayRefresh.set(key, Date.now());
    }

    const holidayNotices = await getNoticesForUser(userId);

    res.render("holidays/holiday_index.ejs", { holidayNotices });

  } catch (err) {
    console.error(err);
    res.status(500).send("Something went wrong.");
  }
});

app.get("/holidays/import", async (req, res) => {
  let quota;

  try {
    quota = await aiQuota.getQuota(req.session.userId);
  } catch (err) {
    console.error("AI quota lookup failed:", err);
  }

  res.render("holidays/holiday_import.ejs", { aiQuota: quota });
});

// Save the reviewed notice
app.post("/holidays", async (req, res) => {

  const userId = req.session.userId;

  const title = String(req.body.noticeTitle || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE_LENGTH);

  const submitted = toList(req.body.holidays).slice(0, MAX_HOLIDAYS);

  // What we show again if something is wrong, so the user's edits are not lost
  const echo = {
    title,
    holidays: submitted.map((row) => ({
      date: String((row && row.date) || ""),
      name: String((row && row.name) || "")
    }))
  };

  try {

    const clean = [];
    const seen = new Set();

    for (const row of submitted) {

      const dt = parseYmd(String((row && row.date) || ""));

      if (!dt) continue;

      const key = dt.toFormat("yyyy-MM-dd");

      if (seen.has(key)) continue;

      seen.add(key);
      clean.push({ date: dt.toJSDate(), name: cleanName(row.name) });
    }

    if (!title) {
      return renderHolidayReview(req, res, 400, echo, "Please give this notice a title.");
    }

    if (clean.length === 0) {
      return renderHolidayReview(req, res, 400, echo, "Select at least one holiday with a valid date.");
    }

    const noticeCount = await HolidayNotice.countDocuments({ user: userId });

    if (noticeCount >= MAX_NOTICES_PER_USER) {
      return flashAndRedirect(
        req, res, "error",
        `You can keep up to ${MAX_NOTICES_PER_USER} imported notices. Please delete one you no longer need.`
      );
    }

    clean.sort((a, b) => a.date - b.date);

    const applyNow = req.body.applyNow === "1";

    const notice = await HolidayNotice.create({
      title,
      user: userId,
      isDefault: false,
      holidays: clean
    });

    await HolidayState.create({ user: userId, notice: notice._id, applied: applyNow });

    if (!applyNow) {
      return flashAndRedirect(
        req, res, "success",
        `"${title}" saved with ${clean.length} holiday${clean.length === 1 ? "" : "s"}. Press Apply when you are ready.`
      );
    }

    let message = `"${title}" saved and applied.`;

    try {
      const result = await applyNotice(userId, notice.toObject());

      if (result.added === 0) {
        message += " No classes were marked yet. They will be marked automatically once your semester and subjects are set up.";
      }

    } catch (err) {
      console.error("Applying imported notice failed:", err);
      return flashAndRedirect(
        req, res, "error",
        `"${title}" was saved, but applying it failed. Please press Apply to try again.`
      );
    }

    return flashAndRedirect(req, res, "success", message);

  } catch (err) {
    console.error("Saving holiday notice failed:", err);
    return renderHolidayReview(req, res, 500, echo, "Could not save the notice. Please try again.");
  }
});

app.post("/holidays/:id/apply", async (req, res) => {
  try {
    const userId = req.session.userId;

    const notice = mongoose.isValidObjectId(req.params.id)
      ? await findAccessibleNotice(req.params.id, userId)
      : null;

    if (!notice) {
      return flashAndRedirect(req, res, "error", "Notice not found.");
    }

    await HolidayState.updateOne(
      { user: userId, notice: notice._id },
      { $set: { applied: true } },
      { upsert: true }
    );

    const result = await applyNotice(userId, notice);

    let message = `"${notice.title}" applied.`;

    if (result.added === 0) {
      message += " No classes were marked yet. They will be marked automatically once your semester and subjects are set up.";
    }

    return flashAndRedirect(req, res, "success", message);

  } catch (err) {
    console.error("Apply holiday notice failed:", err);
    return flashAndRedirect(req, res, "error", "Could not apply this notice. Please try again.");
  }
});

app.post("/holidays/:id/remove", async (req, res) => {
  try {
    const userId = req.session.userId;

    const notice = mongoose.isValidObjectId(req.params.id)
      ? await findAccessibleNotice(req.params.id, userId)
      : null;

    if (!notice) {
      return flashAndRedirect(req, res, "error", "Notice not found.");
    }

    // Undo the holiday marks first, then remember that it is not applied
    await removeNotice(userId, notice);

    await HolidayState.updateOne(
      { user: userId, notice: notice._id },
      { $set: { applied: false } },
      { upsert: true }
    );

    return flashAndRedirect(
      req, res, "success",
      `"${notice.title}" removed. Your attendance for those dates is back to normal.`
    );

  } catch (err) {
    console.error("Remove holiday notice failed:", err);
    return flashAndRedirect(req, res, "error", "Could not remove this notice. Please try again.");
  }
});

app.post("/holidays/:id/delete", async (req, res) => {
  try {
    const userId = req.session.userId;

    const notice = mongoose.isValidObjectId(req.params.id)
      ? await findAccessibleNotice(req.params.id, userId)
      : null;

    if (!notice) {
      return flashAndRedirect(req, res, "error", "Notice not found.");
    }

    if (notice.isDefault) {
      return flashAndRedirect(
        req, res, "error",
        "This notice comes with Attent75 and cannot be deleted. You can remove it instead."
      );
    }

    await removeNotice(userId, notice);

    await HolidayState.deleteMany({ notice: notice._id });
    await HolidayNotice.deleteOne({ _id: notice._id, user: userId });

    return flashAndRedirect(req, res, "success", `"${notice.title}" deleted.`);

  } catch (err) {
    console.error("Delete holiday notice failed:", err);
    return flashAndRedirect(req, res, "error", "Could not delete this notice. Please try again.");
  }
});


// Logout

app.post("/logout", (req, res, next) => {
  req.session.destroy((err) => {
    if (err) {
      return next(err);
    }

    res.clearCookie("connect.sid");
    return res.redirect("/login");
  });
});

// semester Setup 

app.get("/semester/setup", async (req, res) => {
  const sem = await semester.findOne({user: req.session.userId});
  res.render("semester/setup.ejs", {semester: sem});
});


app.post("/semester/setup", async (req, res) => {


  try {

      const {
      semesterName,
      startDate,
      endDate,
    } = req.body;

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (
      !String(semesterName || "").trim() ||
      String(semesterName).length > 60 ||
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime())
    ) {
      return res.status(400).send("Please enter a semester name and valid dates.");
    }

    if (end <= start) {
      return res.status(400).send("Semester end date must be after the start date.");
    }

    const semInfo = await semester.findOneAndUpdate(

      {
        user: req.session.userId
      },

      {
        semesterName,
        startDate,
        endDate,
        user: req.session.userId
      },

      {
        upsert: true,
        new: true
      }
    );



    if (semInfo) {
      semInfo.lastAttendanceSyncDate = null;                               
      await semInfo.save();
    }

    const subjects = await userSubject.find({ user: req.session.userId});

    // Each subject's recalculation + save is independent of the others,
    // so they're run in parallel instead of one at a time.
    await Promise.all(subjects.map(sub => {
      sub.totalClasses = calculateTotalClasses(sub, semInfo);
      return sub.save();
    }));

    // Semester dates may have changed: re-check applied holiday notices
    await refreshHolidays(req.session.userId);

    res.redirect("/dashboard");

  }catch(err){
    console.log(err);
    res.send("Something went wrong.");
  }



});




// dashboard

app.get("/dashboard", async (req, res) => {

  try{

    
    const userId = req.session.userId;

    

    const [subjects, semInfo, splitCounts, todayNoticeHoliday, presentDates, holidayDates] = await Promise.all([
      // Only select fields this route actually uses — scheduleHistory isn't
      // needed here and can grow large over a semester.
      userSubject.find({user:userId}).select("name currentSchedule totalClasses").lean(),
      semester.findOne({user:userId}).lean(),
      // ONE pass over the user's records gives both sets of numbers:
      //   all     = whole semester (semester-end denominator)
      //   current = only records up to today (IST) (current attendance)
      getSubjectStatusCountsSplit(userId, endOfTodayIST()),
      // Is today a holiday because of a holiday notice? (name is shown on the dashboard)
      dailyMark
        .findOne({
          user: userId,
          date: startOfTodayIST(),
          status: "holiday",
          "holidayNotices.0": { $exists: true }
        })
        .select("holidayName")
        .lean(),

      // Present days and holiday days (see the notes further down). They only need
      // the user id, so they run together with everything above (one round trip).
      dailyMark.distinct("date", { user: userId, status: "present" }),
      dailyMark.distinct("date", { user: userId, status: "holiday", date: { $lte: endOfTodayIST() } })
    ]);


    let dailySchedule = [];
    let dashboardShow = [];

    const statusCounts = splitCounts.all;
    const currentStatusCounts = splitCounts.current;

    // Computed once instead of on every subject×class iteration.
    const todayDay = nowIST().toFormat("cccc");

    for (let subject of subjects) {

      // srif Aaj ki classes ko show krana hai dashboard pr ....

      for(let cls of subject.currentSchedule){

        // Srif Aaj Waali classes

        if(cls.day === todayDay){

          let room = "apna class";

            dailySchedule.push({
              
            subjectId: subject._id,
            name: subject.name,
            startTime: cls.start,
            apnaClass: room,

          });
        } 
      }


      // ye neeche waala concept dono for loop k use ka hai
      // jo each subject k total persent,absent,cancel,holiday ko count kr 
      // each subject ka percentage bta rha....

      // No query here anymore — counts come from the single aggregation
      // fetched once above (getSubjectStatusCounts), instead of 4 separate
      // countDocuments queries per subject.
      const {
        present: presentCount,
        holiday: holidayCount,
        cancel: cancelCount
      } = getCountsFor(statusCounts, subject._id);

      // Current attendance is calculated independently for EACH subject:
      // Present / (Present + Absent), using records up to today's IST date.
      // Holiday and Cancel are excluded from classes actually conducted.
      const currentCounts = getCountsFor(currentStatusCounts, subject._id);
      const currentConductedClasses =
        currentCounts.present + currentCounts.absent;

      const currentPercent = currentConductedClasses > 0
        ? (currentCounts.present * 100) / currentConductedClasses
        : 0;

      // Preserve the existing semester-end calculation:
      // Present so far / (planned semester classes - holidays - cancellations).
      const finalClasses = subject.totalClasses - holidayCount - cancelCount;
      const finalPercent = finalClasses > 0
        ? (presentCount * 100) / finalClasses
        : 0;

      //push

      dashboardShow.push({
        subjectName: subject.name,
        presentCount,
        currentPresentCount: currentCounts.present,
        currentAbsentCount: currentCounts.absent,
        currentConductedClasses,
        currentPercent: currentPercent.toFixed(1),
        finalPercent: finalPercent.toFixed(1)
      });

    }




    // Left days in Semester..

    if(!semInfo) {
      return res.redirect("/semester/setup");
    }



    let leftDays = 0;

    const exactDate = startOfTodayIST();

    const endDate = startOfDayIST(semInfo.endDate);
    const startDate = startOfDayIST(semInfo.startDate);

    if(semInfo){
      
      const diff = endDate - exactDate;

      leftDays = Math.ceil( diff / (1000*60*60*24));

    }


    // BIOMETRIC LOGIC.....

    // finding total workingDays....

    const workingDays = getWorkingDays(startDate, endDate);


    // Total present days & total holiday days — these are independent
    // queries, so they're run in parallel instead of one-after-another.

    // Holidays are counted only up to today, because workingDays above is
    // counted only up to today too. (Holiday notices create Holiday records
    // for future dates as well; counting those would shrink the total.)
    // (presentDates / holidayDates were fetched together with the other queries above.)

    const userPresentDays = presentDates.length;

    const userHolidays = holidayDates.length;

    const actulWorkingDays = workingDays - userHolidays ;

    // No working days yet (e.g. semester not started) must not show NaN / Infinity
    const biometricPercent = actulWorkingDays > 0
      ? (userPresentDays * 100) / actulWorkingDays
      : 0;

    const needDays = needToGet75(userPresentDays, actulWorkingDays);  

    const bioDashInfo = {
      biometric: biometricPercent.toFixed(1),
      needClasses: needDays,
      remainingDays: leftDays,
      semStartDate : startDate
    }

    dailySchedule.sort((a,b) => {
      return a.startTime.localeCompare(b.startTime);
    });

    res.render("dashboard/dash_index.ejs", {
      subjects: dashboardShow,
      todayClasses: dailySchedule,
      stats: bioDashInfo,
      todayDate: formattedToday(),
      // name of today's holiday (from a holiday notice), or null
      todayHoliday: todayNoticeHoliday ? (todayNoticeHoliday.holidayName || "Holiday") : null
    });


  }catch(err){
    console.log(err);
    res.send("Something went wrong.");
  }


});











// Subjects

app.get("/subjects", async (req, res) => {

  try {


    const userId = req.session.userId;

    // subjects + all status counts fetched in parallel; counts come from a
    // single aggregation instead of 4 countDocuments queries per subject.
    const [subjects, statusCounts] = await Promise.all([
      userSubject.find({user: userId}).select("name classesPerWeek currentSchedule totalClasses"),
      getSubjectStatusCounts(userId)
    ]);



    let subjectsList = [];



    for (let subject of subjects) {

      // ye neeche waala concept dono for loop k use ka hai
      // jo each subject k total persent,absent,cancel,holiday ko count kr 
      // each subject ka percentage bta rha....

      const {
        present: presentCount,
        absent: absentCount,
        holiday: holidayCount,
        cancel: cancelCount
      } = getCountsFor(statusCounts, subject._id);

      const finalClasses =  subject.totalClasses - holidayCount - cancelCount;

      const finalPercent = finalClasses > 0 ? (presentCount * 100) / finalClasses : 0;



      //push

      subjectsList.push({

        ...subject.toObject(),

        finalClasses : finalClasses,

        attendClasses: presentCount,

        missedClasses: absentCount,

        finalPercent: finalPercent.toFixed(1)

      });

    }

    
    res.render("subjects/sub_index.ejs", {subjectsList: subjectsList});


  }catch(err){
    console.log(err);
    res.send("Something went wrong.");
  }

  
});




app.post("/subjects", async (req, res) => {

  try {

    // Find user's semester
    const Semester = await semester.findOne({
      user: req.session.userId
    });

    const userId = req.session.userId;

    if (!Semester) {
      return res.send("SEMESTER DETAILS NOT FOUND.");
    }


    //====================================================
    // AI ROUTINE IMPORT
    //====================================================

    if (req.body.importMode === "ai") {

      const routine =
        req.session.importedRoutine;

      if (
        !routine ||
        !Array.isArray(routine.subjects)
      ) {
        return res.send("IMPORTED ROUTINE NOT FOUND.");
      }


      let selectedSubjects =
        req.body.selectedSubjects || [];


      // If only one checkbox selected,
      // Express gives a string.
      if (!Array.isArray(selectedSubjects)) {
        selectedSubjects = [selectedSubjects];
      }


      if (selectedSubjects.length === 0) {
        return res.send(
          "PLEASE SELECT AT LEAST ONE SUBJECT."
        );
      }


      // New subjects added
      Semester.lastAttendanceSyncDate = null;


      // Create every checked subject
      for (const index of selectedSubjects) {

        const data =
          routine.subjects[Number(index)];


        if (!data || !data.schedule?.length) {
          continue;
        }


        const subject = new userSubject({

          name: data.name,

          // Backend calculates this
          classesPerWeek:
            data.schedule.length,

          currentScheduleFrom:
            Semester.startDate,

          currentSchedule:
            data.schedule,

          scheduleHistory: [],

          user: userId
        });


        // Existing Attent75 calculation
        subject.totalClasses =
          calculateTotalClasses(
            subject,
            Semester
          );


        // Save to MongoDB
        await subject.save();

      }


      await Semester.save();


      // Routine is no longer needed
      delete req.session.importedRoutine;

      // New subjects: classes on already-applied holiday dates become Holiday too
      await refreshHolidays(userId);

      // Go to normal subjects page
      return res.redirect("/subjects");
    }



    // NORMAL FLOW.....//





    // Create new subject
    const subject = new userSubject({
      name: req.body.subjectName,

      classesPerWeek: req.body.classesPerWeek,

      // Current active schedule starts from semester start date
      currentScheduleFrom: Semester.startDate,

      // User's current schedule
      currentSchedule: req.body.schedule,

      // No previous schedule when subject is first created
      scheduleHistory: [],

      user: req.session.userId
    });

    // New subject ke past classes ko sync karne ke liye

    if (Semester) {
      Semester.lastAttendanceSyncDate = null;
      await Semester.save();
    }

    // Calculate total classes
    const totalClasses = calculateTotalClasses(
      subject,
      Semester
    );

    subject.totalClasses = totalClasses;

    // Save subject
    await subject.save();

    // New subject: its classes on already-applied holiday dates become Holiday too
    await refreshHolidays(req.session.userId);

    res.redirect("/subjects");

  } catch (err) {

    console.log(err);

    res.send("ERROR WHILE SAVING SUBJECT.");

  }

});

// Adding new subjects...


app.get("/subjects/new", (req, res) => {
  res.render("subjects/sub_new.ejs");
});


// page for upload routine files...
// (POST route upar defined hai, CSRF se pehle)

app.get("/subjects/import-routine", async (req, res) => {
  let quota;

  try {
    quota = await aiQuota.getQuota(req.session.userId);
  } catch (err) {
    console.error("AI quota lookup failed:", err);
  }

  res.render("subjects/import_routine.ejs", { aiQuota: quota });
});


//===========================================================
// Edit Subject - By Subject ID
//===========================================================

app.get("/subjects/:id/edit", async (req, res) => {

  try {

    const { id } = req.params;
    const userId = req.session.userId;

    // Find subject
    const editSub = await userSubject.findOne({
      _id: id,
      user: userId
    });

    // Subject not found
    if (!editSub) {
      return res.status(404).send("SUBJECT NOT FOUND.");
    }


    //===========================================================
    // Get Attendance Statistics
    //===========================================================

    const [
      presentCount,
      absentCount,
      holidayCount,
      cancelCount
    ] = await Promise.all([

      dailyMark.countDocuments({
        user: userId,
        subject: editSub._id,
        status: "present"
      }),

      dailyMark.countDocuments({
        user: userId,
        subject: editSub._id,
        status: "absent"
      }),

      dailyMark.countDocuments({
        user: userId,
        subject: editSub._id,
        status: "holiday"
      }),

      dailyMark.countDocuments({
        user: userId,
        subject: editSub._id,
        status: "cancel"
      })

    ]);

    


    //===========================================================
    // Calculate Final Classes & Attendance Percentage
    //===========================================================

    const finalClasses =
      editSub.totalClasses - holidayCount - cancelCount;

    const finalPercent =
      finalClasses > 0
        ? (presentCount * 100) / finalClasses
        : 0;


    //===========================================================
    // Prepare Statistics
    //===========================================================

    const subjectsList = [

      {
        ...editSub.toObject(),

        finalClasses: finalClasses,

        attendClasses: presentCount,

        missedClasses: absentCount,

        finalPercent: finalPercent.toFixed(1)
      }

    ];


    //===========================================================
    // Render Edit Page
    //===========================================================

    res.render("subjects/edit.ejs", {

      subject: editSub,

      stats: subjectsList,

    });


  } catch (err) {

    console.log("ERROR WHILE OPENING EDIT SUBJECT:", err);

    res.status(500).send("Something went wrong.");

  }

});



//===========================================================
// Update (Edit) Subject
//===========================================================

app.post("/subjects/:id", async (req, res) => {

  try {

    const subjectId = req.params.id;
    const userId = req.session.userId;


    // -------------------------------------------------------
    // 1. Find existing subject
    // -------------------------------------------------------

    const subject = await userSubject.findOne({
      _id: subjectId,
      user: userId
    });

    if (!subject) {
      return res.send("SUBJECT NOT FOUND.");
    }


    // -------------------------------------------------------
    // 2. Find user's semester
    // -------------------------------------------------------

    const semInfo = await semester.findOne({
      user: userId
    });

    if (!semInfo) {
      return res.send("SEMESTER DETAILS NOT FOUND.");
    }


    // -------------------------------------------------------
    // 3. Store old subject name
    // -------------------------------------------------------

    const oldSubjectName = subject.name;


    // -------------------------------------------------------
    // 4. Get updated data from edit form
    // -------------------------------------------------------

    const newName = req.body.subjectName;

    const newClassesPerWeek = Number(
      req.body.classesPerWeek
    );

    const newSchedule = Array.isArray(req.body.schedule)
      ? req.body.schedule
      : [req.body.schedule];


    // -------------------------------------------------------
    // 5. Get today's date in IST
    // -------------------------------------------------------

    const changeDate = DateTime
      .now()
      .setZone("Asia/Kolkata")
      .startOf("day");


    // -------------------------------------------------------
    // 6. Check whether schedule has changed
    // -------------------------------------------------------

    const oldSchedule = JSON.stringify(
      subject.currentSchedule
    );

    const updatedSchedule = JSON.stringify(
      newSchedule
    );

    const scheduleChanged =
      oldSchedule !== updatedSchedule;


    // -------------------------------------------------------
    // 7. Handle schedule change
    // -------------------------------------------------------

    if (scheduleChanged) {

      // -----------------------------------------------------
      // Check if current schedule was already changed today
      // -----------------------------------------------------

      const currentScheduleFrom = DateTime
        .fromJSDate(subject.currentScheduleFrom)
        .setZone("Asia/Kolkata")
        .startOf("day");


      const sameDayScheduleEdit =
        currentScheduleFrom.toMillis() ===
        changeDate.toMillis();


      // -----------------------------------------------------
      // CASE 1:
      // Schedule was already changed today
      //
      // Just replace current schedule.
      // Do NOT create another history record.
      // -----------------------------------------------------

      if (sameDayScheduleEdit) {

        subject.currentSchedule =
          newSchedule;

      }


      // -----------------------------------------------------
      // CASE 2:
      // Schedule was not changed today
      //
      // Move old schedule to history.
      // Then set new schedule as current.
      // -----------------------------------------------------

      else {

        const oldScheduleEnd = changeDate
          .minus({ days: 1 })
          .toJSDate();


        // Save old current schedule in history

        subject.scheduleHistory.push({

          effectiveFrom:
            subject.currentScheduleFrom,

          effectiveTo:
            oldScheduleEnd,

          schedule:
            subject.currentSchedule

        });


        // Set new schedule as current

        subject.currentSchedule =
          newSchedule;


        // New schedule starts today

        subject.currentScheduleFrom =
          changeDate.toJSDate();

      }

    }


    // -------------------------------------------------------
    // 8. Update subject basic information
    // -------------------------------------------------------

    subject.name =
      newName;

    subject.classesPerWeek =
      newClassesPerWeek;


    // -------------------------------------------------------
    // 9. Recalculate total classes
    // -------------------------------------------------------

    subject.totalClasses =
      attendanceCalculator(
        subject,
        semInfo
      );


    // -------------------------------------------------------
    // 10. Save updated subject
    // -------------------------------------------------------

    await subject.save();


    // -------------------------------------------------------
    // 11. Update subject name in existing attendance records
    // -------------------------------------------------------

    if (oldSubjectName !== newName) {

      await dailyMark.updateMany(
        {
          subject: subjectId,
          user: userId
        },

        {
          subjectName: newName
        }
      );

    }


    // -------------------------------------------------------
    // 12. Schedule may have changed: re-check applied holiday notices
    // -------------------------------------------------------

    await refreshHolidays(userId);


    // -------------------------------------------------------
    // 13. Redirect
    // -------------------------------------------------------

    res.redirect("/subjects");


  } catch (err) {

    console.log(err);

    res.send("Something went wrong.");

  }

});



//==========================================================//
  // delete subject .....//
//==========================================================//



app.post("/subjects/:id/delete", async (req, res) => {

  try {

    await userSubject.findOneAndDelete(

      {
        _id: req.params.id,
        user: req.session.userId
      }

    );

    await dailyMark.deleteMany({
      subject : req.params.id,
      user: req.session.userId
    });



    res.redirect("/subjects");

  }catch(err){
    console.log(err);
    res.send("ERROR WHILE DELETING SUBJECT..");
  }
  
});





// Mark Attendance page..... //


// ============================================================
// Shared helper: build today's scheduled classes + their current
// attendance status. Used by both the GET render and the POST
// AJAX response, so the "what does today look like" logic lives
// in exactly one place.
// ============================================================

async function getTodayClassesWithStatus(userId, knownSubjects) {

  const startOfDay = startOfTodayIST();
  const endOfDay = endOfTodayIST();

  // Subjects and today's marks do not depend on each other: fetch together.
  // (knownSubjects: the caller already loaded them, so skip that query.)
  const [subjects, todayMark] = await Promise.all([
    knownSubjects || userSubject.find({user: userId}).select("name currentSchedule").lean(),
    dailyMark.find({
      user: userId,
      date: {
        $gte: startOfDay,
        $lte: endOfDay
      }
    }).lean()
  ]);

  const todayDay = nowIST().toFormat("cccc");

  let todayClasses = [];

  for (let subject of subjects) {
    for (let cls of subject.currentSchedule) {
      if (cls.day === todayDay) {

        const mark = todayMark.find(m =>
          m.subject.toString() === subject._id.toString() && m.startTime === cls.start
        );

        todayClasses.push({
          subjectId: subject._id,
          name: subject.name,
          startTime: cls.start,
          endTime: cls.end,
          status: mark ? mark.status : null,

          // Set only when a holiday NOTICE made this class a Holiday
          // (a Holiday you pressed yourself has no name and is not locked)
          holidayName:
            mark && mark.holidayNotices && mark.holidayNotices.length > 0
              ? (mark.holidayName || "Holiday")
              : null
        });
      }
    }
  }

  todayClasses.sort((a,b) => a.startTime.localeCompare(b.startTime));

  return todayClasses;
}

// Sends the result of an attendance-marking action.
// - AJAX callers (fetch, marked via X-Requested-With) get back the fresh
//   today's-classes+status list as JSON, so the page can update in place.
// - Non-JS/classic form submits still get the old redirect, so the page
//   keeps working even with JavaScript disabled.
async function respondAfterAttendanceChange(req, res) {
  if (req.xhr) {
    const classes = await getTodayClassesWithStatus(req.session.userId, req.todaySubjects);
    return res.json({ success: true, classes });
  }
  return res.redirect("/attendance/mark");
}

// Same idea for error responses — AJAX callers get JSON they can parse
// and show inline; classic form submits keep the old plain-text response.
function sendMarkError(req, res, status, message) {
  if (req.xhr) {
    return res.status(status).json({ success: false, message });
  }
  return res.status(status).send(message);
}


app.get("/attendance/mark", async (req, res) => {

  const todayClasses = await getTodayClassesWithStatus(req.session.userId);

  res.render("attendance/mark.ejs", {classes: todayClasses});
});


// ============================================================
// POST: Mark Attendance
// ============================================================

app.post("/attendance/mark", async (req, res) => {

  try {

    // ========================================================
    // 1. Get current user's semester + all subjects
    //
    // These two lookups don't depend on each other, so they're
    // fetched in parallel instead of one after another. This is
    // the highest-frequency write route in the app (fired on
    // every attendance tap), so shaving a round trip here matters.
    // ========================================================

    const [semInfo, subjects] = await Promise.all([
      semester.findOne({ user: req.session.userId }),
      userSubject.find({ user: req.session.userId }).select("name currentSchedule").lean()
    ]);

    // Reused when the fresh class list is sent back (saves one query)
    req.todaySubjects = subjects;


    // ========================================================
    // 2. Validate semester information
    // ========================================================

    if (
      !semInfo ||
      !semInfo.endDate
    ) {

      return sendMarkError(req, res, 400,
        "Semester information not available."
      );

    }


    // ========================================================
    // 3. Check semester end date
    // ========================================================

    const currentDate =
      startOfDayIST(
        nowISTDate()
      );

    const semEnd =
      startOfDayIST(
        semInfo.endDate
      );


    // Attendance marking not allowed
    // after semester end date

    if (
      currentDate > semEnd
    ) {

      return sendMarkError(req, res, 403,
        "Semester has ended."
      );

    }


    // ========================================================
    // 4. Get request data
    // ========================================================

    const {
      subjectId,
      subjectName,
      startTime,
      endTime,
      status
    } = req.body;


    // ========================================================
    // 5. Today's date
    // ========================================================

    const today =
      startOfTodayIST();


    // ========================================================
    // 6. Get today's day name
    //
    // Example:
    // Monday
    // Tuesday
    // Wednesday
    // ========================================================

    const todayDay =
      nowIST().toFormat("cccc");


    // ========================================================
    // 7. Build today's scheduled classes
    //
    // (subjects were already fetched above, in parallel with semInfo)
    //
    // This contains ONLY today's actual classes
    // according to currentSchedule.
    // ========================================================

    const todayClasses = [];


    for (
      const subject of subjects
    ) {

      const currentSchedule =
        subject.currentSchedule || [];


      for (
        const cls of currentSchedule
      ) {

        if (
          cls.day === todayDay
        ) {

          todayClasses.push({

            subjectId:
              subject._id,

            subjectName:
              subject.name,

            startTime:
              cls.start,

            endTime:
              cls.end

          });

        }

      }

    }


    // ========================================================
    // 9. If no class is scheduled today
    // ========================================================

    if (
      todayClasses.length === 0
    ) {

      return await respondAfterAttendanceChange(req, res);

    }


    // ========================================================
    // 10. Check whether today is already FULL HOLIDAY
    //
    // IMPORTANT:
    //
    // Holiday is GLOBAL.
    //
    // If every scheduled class today has a holiday record,
    // then the whole day is considered Holiday.
    // ========================================================

    // The three lookups below do not depend on each other, so they run together
    // (one round trip instead of three).
    const [holidayRecords, noticeHolidayToday, prefetchedRecord] =
      await Promise.all([

        dailyMark.find({
          user: req.session.userId,
          date: today,
          status: "holiday"
        })
        .select("subject startTime")
        .lean(),

        dailyMark
          .findOne({
            user: req.session.userId,
            date: today,
            "holidayNotices.0": { $exists: true }
          })
          .select("holidayName")
          .lean(),

        // The record for the tapped class (only needed for Present / Absent / Cancel)
        (mongoose.isValidObjectId(req.body.subjectId) && req.body.startTime)
          ? dailyMark.findOne({
              user: req.session.userId,
              subject: req.body.subjectId,
              date: today,
              startTime: req.body.startTime
            })
          : Promise.resolve(null)
      ]);


    // ========================================================
    // 11. Create unique keys for today's classes
    // ========================================================

    const todayClassKeys =
      new Set(

        todayClasses.map(
          cls =>
            `${cls.subjectId}_${cls.startTime}`
        )

      );


    // ========================================================
    // 12. Create unique keys for Holiday records
    // ========================================================

    const holidayKeys =
      new Set(

        holidayRecords.map(
          record =>
            `${record.subject}_${record.startTime}`
        )

      );


    // ========================================================
    // 13. Check if ALL today's scheduled classes
    // are currently Holiday
    // ========================================================

    const isFullHoliday =
      todayClassKeys.size > 0 &&
      todayClassKeys.size === holidayKeys.size &&
      [...todayClassKeys].every(
        key =>
          holidayKeys.has(key)
      );


    // ========================================================
    // 13b. Is today a Holiday because of a holiday NOTICE?
    //
    // Such a day is locked: it can only be changed by removing the
    // notice from the Holidays page (that also restores the old status).
    // A Holiday the user pressed by themselves is not locked.
    // ========================================================

    const noticeHolidayMessage = noticeHolidayToday
      ? `Today is a holiday${noticeHolidayToday.holidayName ? ` (${noticeHolidayToday.holidayName})` : ""} from a holiday notice. ` +
        "To change it, remove that notice from the Holidays page."
      : null;


    // ========================================================
    // ========================================================
    // 14. GLOBAL HOLIDAY TOGGLE
    // ========================================================
    // ========================================================

    if (
      status === "holiday"
    ) {

      // Locked by a holiday notice: do not undo it from here
      if (
        noticeHolidayMessage
      ) {

        return sendMarkError(req, res, 403, noticeHolidayMessage);

      }



      // ======================================================
      // CASE A:
      //
      // Today is already FULL HOLIDAY.
      //
      // Clicking Holiday again means:
      //
      // → Remove Holiday
      // → Unmark ALL today's classes
      //
      // This ensures partial Holiday can never remain.
      // ======================================================

      if (
        isFullHoliday
      ) {

        await dailyMark.deleteMany({

          user:
            req.session.userId,

          date:
            today

        });


        return await respondAfterAttendanceChange(req, res);

      }


      // ======================================================
      // CASE B:
      //
      // Today is NOT full Holiday.
      //
      // Clicking Holiday means:
      //
      // → ALL today's classes become Holiday.
      //
      // Any existing Present / Absent / Cancel record
      // will be changed to Holiday.
      // ======================================================

      // One database call for all of today's classes (instead of one per class)
      await dailyMark.bulkWrite(
        todayClasses.map(cls => ({
          updateOne: {
            filter: {
              user: req.session.userId,
              subject: cls.subjectId,
              date: today,
              startTime: cls.startTime
            },
            update: {
              $set: {
                subjectName: cls.subjectName,
                endTime: cls.endTime,
                status: "holiday"
              },
              $setOnInsert: {
                user: req.session.userId,
                subject: cls.subjectId,
                date: today,
                startTime: cls.startTime
              }
            },
            upsert: true
          }
        })),
        { ordered: false }
      );


      return await respondAfterAttendanceChange(req, res);

    }


    // ========================================================
    // ========================================================
    // 15. BLOCK INDIVIDUAL ATTENDANCE DURING FULL HOLIDAY
    // ========================================================
    // ========================================================
    //
    // If whole day is Holiday,
    // user cannot mark only one subject as:
    //
    // Present
    // Absent
    // Cancel
    //
    // Holiday must remain GLOBAL.
    // ========================================================

    if (
      isFullHoliday
    ) {

      // Tell the user WHY nothing changed when a notice made today a holiday
      if (
        noticeHolidayMessage
      ) {

        return sendMarkError(req, res, 403, noticeHolidayMessage);

      }

      return await respondAfterAttendanceChange(req, res);

    }


    // ========================================================
    // 16. Validate normal attendance status
    // ========================================================

    const allowedStatuses = [
      "present",
      "absent",
      "cancel"
    ];


    if (
      !allowedStatuses.includes(status)
    ) {

      return sendMarkError(req, res, 400,
        "Invalid attendance status."
      );

    }


    // ========================================================
    // 17. Validate subjectId
    // ========================================================

    if (
      !subjectId ||
      !startTime
    ) {

      return sendMarkError(req, res, 400,
        "Invalid attendance data."
      );

    }


    // ========================================================
    // 18. Make sure requested subject/class
    // actually belongs to today's schedule
    // ========================================================

    const requestedClass =
      todayClasses.find(

        cls =>

          cls.subjectId.toString() ===
            subjectId.toString() &&

          cls.startTime ===
            startTime

      );


    if (
      !requestedClass
    ) {

      return sendMarkError(req, res, 400,
        "Invalid class selection."
      );

    }


    // ========================================================
    // 19. Find existing attendance record
    // ========================================================

    const existingRecord = prefetchedRecord;


    // ========================================================
    // 20. Existing record found
    // ========================================================

    if (
      existingRecord
    ) {


      // ======================================================
      // Same status clicked again
      //
      // Example:
      //
      // Present → Present
      //
      // Result:
      // Unmark / Delete record
      // ======================================================

      if (
        existingRecord.status === status
      ) {

        await dailyMark.deleteOne({

          _id:
            existingRecord._id

        });


        return await respondAfterAttendanceChange(req, res);

      }


      // ======================================================
      // Different status selected
      //
      // Example:
      //
      // Present → Absent
      // Absent  → Present
      // Cancel  → Present
      //
      // Existing record will be updated.
      // ======================================================

      existingRecord.status =
        status;

      existingRecord.subjectName =
        subjectName ||
        requestedClass.subjectName;

      existingRecord.endTime =
        endTime ||
        requestedClass.endTime;


      await existingRecord.save();


    }

    // ========================================================
    // 21. No existing record
    //
    // Create new attendance record
    // ========================================================

    else {

      await dailyMark.create({

        user:
          req.session.userId,

        subject:
          subjectId,

        subjectName:
          subjectName ||
          requestedClass.subjectName,

        date:
          today,

        startTime:
          startTime,

        endTime:
          endTime ||
          requestedClass.endTime,

        status:
          status

      });

    }


    // ========================================================
    // 22. Redirect back to Mark Attendance page
    // ========================================================

    return await respondAfterAttendanceChange(req, res);


  } catch (
    err
  ) {

    // Two quick taps can try to create the same record twice. The unique index
    // stops the second one: that is not an error for the user, show the fresh state.
    if (err && err.code === 11000) {
      try {
        return await respondAfterAttendanceChange(req, res);
      } catch (e) {
        console.error("Attendance refresh after duplicate failed:", e);
      }
    }

    console.error(
      "❌ Attendance marking error:",
      err
    );

    return sendMarkError(req, res, 500,
      "Error Found"
    );

  }

});


// Attendance History ....//


app.get("/attendance/history", async (req, res) => {


  const userId = req.session.userId;

  const semInfo = await semester.findOne({
    user: userId
  });

  if (semInfo) {

    // Automatic missed attendance sync
    await markMissedAttendance(
      userId,
      semInfo
    );

  }

  // Holiday notices create Holiday records for FUTURE dates too,
  // so only show records up to today (otherwise they would fill the top of the list).
  const history = await dailyMark.find({
     user: req.session.userId,
     date: { $lte: endOfTodayIST() }
    })
    .sort({date: -1 })
    .limit(30);

  res.render("attendance/history.ejs", {attendanceHistory: history});

});



// attendance history edit page...//

app.get("/attendance/history/:id/edit", async (req, res) => {

  const {id} = req.params;

  const record = await dailyMark.findOne({
    _id: id,
    user: req.session.userId
  });

  if(!record){
    return res.send("Record Not Found");
  }

  // A holiday made by a holiday notice cannot be edited here.
  // Removing the notice (Holidays page) restores the old status.
  if (record.holidayNotices && record.holidayNotices.length > 0) {
    return res.status(403).send(
      "This day is a holiday because of a holiday notice, so it cannot be edited. " +
      "To change it, remove the notice from the Holidays page."
    );
  }

  res.render("attendance/edit_history.ejs", {record});

});

//post request for attendance history edit page...//

app.post("/attendance/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const record = await dailyMark.findOne({
      _id: id,
      user: req.session.userId
    });

    if (!record) {
      return res.status(404).send("Attendance record not found");
    }

    // Locked by a holiday notice (see the edit page above)
    if (record.holidayNotices && record.holidayNotices.length > 0) {
      return res.status(403).send(
        "This day is a holiday because of a holiday notice, so it cannot be edited. " +
        "To change it, remove the notice from the Holidays page."
      );
    }

    record.status = status;

    await record.save();

    res.redirect(`/attendance/history/${id}/edit?updated=true`);

  } catch (err) {
    console.error("Past attendance update error:", err);
    res.status(500).send("Server Error");
  }
});



app.get("/pyq", (req, res) => {
  res.render("pyq/pyq_index.ejs");
});



// Unknown page
app.use((req, res) => {
  res.status(404).send("Page not found.");
});

// Error handler (ek hi rakha hai)
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err === invalidCsrfTokenError || err.code === "EBADCSRFTOKEN") {
    console.error("CSRF FAIL ->", req.method, req.originalUrl);
    console.error("Content-Type:", req.headers["content-type"]);
    console.error("Body token:", req.body?._csrf);
    return res.status(403).send(
      "Security check failed. Please refresh the page and try again."
    );
  }

  console.error("Application error:", err);
  return res.status(500).send("Something went wrong. Please try again later.");
});


const PORT = process.env.PORT || 9010;

const server = app.listen(PORT, () => {
  console.log(`app is listen on port ${PORT}`);
});

// A hung request must not stay open forever
server.requestTimeout = 120000;
server.headersTimeout = 65000;
server.keepAliveTimeout = 61000;   // longer than the hosting proxy's, avoids random 502s

// One bad promise somewhere must be logged, not silently kill (or freeze) the app
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  process.exit(1);   // state is unknown: exit and let the host restart a clean process
});

// Host is restarting / deploying: finish running requests, then close the database
function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);

  server.close(async () => {
    try {
      await mongoose.connection.close();
    } catch (e) {
      console.error("Error while closing database:", e);
    }
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 10000).unref();   // do not hang forever
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
