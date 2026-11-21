const mongoose = require("mongoose");

// One document per (user, notice): is this notice applied for this user?
//
// For a default notice the document is created the first time the user
// opens the app after the notice is added (applied = true).
// If the user removes it, applied becomes false and it stays false.

const holidayStateSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "userInfo",
      required: true
    },

    notice: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HolidayNotice",
      required: true
    },

    applied: {
      type: Boolean,
      default: false
    }
  },

  {
    timestamps: true
  }
);

holidayStateSchema.index({ user: 1, notice: 1 }, { unique: true });
holidayStateSchema.index({ notice: 1, applied: 1 });

module.exports = mongoose.model("HolidayState", holidayStateSchema);
