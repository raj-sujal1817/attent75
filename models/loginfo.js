const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({

  username: {
    type: String,
    required: true,
    trim: true,
  },

  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,   // A@Gmail.com and a@gmail.com are the same account
    trim: true,
  },

  password: {
    type: String,
    required: true,
  },

  // Email verification.
  // - New accounts are created with emailVerified: false and become true after the OTP.
  // - Old accounts (created before this feature) do not have the field at all (undefined),
  //   they are asked to verify once, the next time they log in.
  emailVerified: {
    type: Boolean,
  },

  // One OTP slot, used for both "verify" (signup / old users) and "reset" (forgot password).
  // Only a hash of the code is stored, never the code itself.
  otpHash: String,
  otpPurpose: String,          // "verify" | "reset"
  otpExpiresAt: Date,
  otpAttempts: { type: Number, default: 0 },
  otpLastSentAt: Date,         // for the 60 second resend gap
  otpWindowStart: Date,        // start of the current 1 hour window
  otpSendCount: { type: Number, default: 0 },   // how many codes were sent in that window

});

module.exports = mongoose.model("userInfo", userSchema);
