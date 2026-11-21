const mongoose = require("mongoose");

// How many AI reads (routine / holiday notice) a user has used on one day.
// One document per user per IST day. Old ones delete themselves after 3 days.
//
// NOTE: "used" has no default on purpose. The quota code upserts with $inc on this field,
// and a default would clash with that $inc.
const aiUsageSchema = new mongoose.Schema({

  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "userInfo",
    required: true
  },

  day: {
    type: String,          // "2026-10-27" (IST)
    required: true
  },

  used: {
    type: Number
  },

  expiresAt: {
    type: Date
  }

});

aiUsageSchema.index({ user: 1, day: 1 }, { unique: true });
aiUsageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("AiUsage", aiUsageSchema);
