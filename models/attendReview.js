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


module.exports = mongoose.model("DailyMark", dailyMarkSchema);