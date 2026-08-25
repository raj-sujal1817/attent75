const mongoose = require("mongoose");

const subjectsScehma = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },

    classesPerWeek: {
      type: Number,
      required: true,
    },

    // Date from which the current schedule is active
    currentScheduleFrom: {
      type: Date,
      required: true,
    },

    // Current active schedule
    currentSchedule: [
      {
        day: {
          type: String,
          enum: [
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday"
          ],
          required: true
        },

        start: {
          type: String,
          required: true
        },

        end: {
          type: String,
          required: true
        }
      }
    ],

    // Previous schedule records
    scheduleHistory: [
      {
        effectiveFrom: {
          type: Date,
          required: true
        },

        effectiveTo: {
          type: Date,
          required: true
        },

        schedule: [
          {
            day: {
              type: String,
              enum: [
                "Monday",
                "Tuesday",
                "Wednesday",
                "Thursday",
                "Friday",
                "Saturday"
              ],
              required: true
            },

            start: {
              type: String,
              required: true
            },

            end: {
              type: String,
              required: true
            }
          }
        ]
      }
    ],

    totalClasses: {
      type: Number,
      default: 0,
    },

    attendClasses: {
      type: Number,
      default: 0,
    },

    // Missed Classes or holidayClasses
    absentClasses: {
      type: Number,
      default: 0,
    },

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "userInfo",
      required: true,
    }
  },

  {
    timestamps: true
  }
);

// Every route filters userSubject queries by `user` (dashboard, subjects list,
// attendance mark, semester setup, etc.) — this was previously unindexed.
subjectsScehma.index({ user: 1 });

module.exports = mongoose.model("userSubject", subjectsScehma);