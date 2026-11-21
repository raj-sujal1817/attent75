const mongoose = require("mongoose");

const dailyMarkSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "userInfo",
    required: true
  },

  subject: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "userSubject",
    required: true,
  },

  subjectName: {
    type: String
  },

  date: {
    type: Date,
    required: true
  },

  startTime: {
    type: String,
    required: true
  },

  endTime: {
    type: String,
    required: true
  },

  status: {
    type: String,
    enum: ["present", "absent", "holiday", "cancel"],
    required: true
  },

  // ---- Holiday notice "effect" fields -------------------------------
  // Set only on records that a holiday notice turned into Holiday.
  //
  // holidayNotices : which applied notice(s) make this date a Holiday.
  //                  While this list is not empty the record is locked as Holiday.
  // prevStatus     : the status before the first notice was applied
  //                  ("none" = there was no record). Used to restore it
  //                  when the last notice is removed.
  // holidayName    : e.g. "Diwali", shown on Dashboard / Mark / History.

  holidayNotices: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HolidayNotice"
    }
  ],

  prevStatus: {
    type: String,
    enum: ["present", "absent", "holiday", "cancel", "none"]
  },

  holidayName: {
    type: String
  }

},

{
  timestamps: true
}

);

dailyMarkSchema.index(
  {
    user:1,
    subject:1,
    date:1,
    startTime:1
  },

  {
    unique: true  
  }
);

// Speeds up per-subject status counts used on Dashboard / Subjects / Edit Subject
// (previously served only by the user+subject prefix of the unique index above,
// which meant Mongo still had to scan all of a user+subject's docs to filter status)
dailyMarkSchema.index({ user: 1, subject: 1, status: 1 });

// Speeds up the biometric section's distinct("date", {user, status}) calls on Dashboard
dailyMarkSchema.index({ user: 1, status: 1 });

// Speeds up Attendance History's find({user}).sort({date:-1}).limit(30)
// and the today's-marks range query on the Attendance Mark page
dailyMarkSchema.index({ user: 1, date: -1 });

// Finds every record a given holiday notice has turned into Holiday
// (used when a notice is removed / deleted / re-synced)
dailyMarkSchema.index({ user: 1, holidayNotices: 1 });


module.exports = mongoose.model("DailyMark", dailyMarkSchema);