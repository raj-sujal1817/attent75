const mongoose = require("mongoose");

// A holiday notice = a named list of holiday dates.
//
//  - Default notice  : isDefault = true, user = null  (added by you from the backend,
//                      shown to every user, pre-applied until the user removes it)
//  - Imported notice : isDefault = false, user = <owner> (uploaded by that user)
//
// Whether a notice is applied for a user lives in HolidayState, so the same
// default notice can be applied for one user and removed for another.

const holidayNoticeSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80
    },

    description: {
      type: String,
      trim: true,
      maxlength: 300
    },

    isDefault: {
      type: Boolean,
      default: false
    },

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "userInfo",
      default: null
    },

    holidays: [
      {
        // Stored as IST midnight, same as DailyMark.date
        date: {
          type: Date,
          required: true
        },

        name: {
          type: String,
          trim: true,
          maxlength: 80,
          default: "Holiday"
        },

        _id: false
      }
    ]
  },

  {
    timestamps: true
  }
);

// (no next() callback on purpose, it is not needed in newer Mongoose versions)
holidayNoticeSchema.pre("validate", function () {
  if (this.isDefault && this.user) {
    throw new Error("A default notice cannot belong to a user.");
  }

  if (!this.isDefault && !this.user) {
    throw new Error("An imported notice must belong to a user.");
  }
});

holidayNoticeSchema.index({ user: 1, createdAt: -1 });
holidayNoticeSchema.index({ isDefault: 1 });

module.exports = mongoose.model("HolidayNotice", holidayNoticeSchema);
