import mongoose from "mongoose";

// Server-side sign-in sessions (temporary beta sign-in). The browser only holds
// a random token in an HttpOnly cookie; this stores its SHA-256 hash, so a
// database read never reveals a usable token. Expired sessions are removed by
// MongoDB's TTL index.
const sessionSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    user: {
      id: { type: String, required: true },
      name: { type: String, required: true },
      role: { type: String, required: true },
    },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: "sessions" },
);

sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = mongoose.model("Session", sessionSchema);
