import mongoose from "mongoose";

// Server-side ReceiptFlow sessions (Microsoft Entra ID sign-in, or the
// temporary beta sign-in). The browser only holds a random token (HttpOnly
// cookie, or in memory as a bearer token); this stores its SHA-256 hash, so a
// database read never reveals a usable token. Expired sessions are removed by
// MongoDB's TTL index.
const sessionSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    user: {
      id: { type: String, required: true },
      name: { type: String, required: true },
      role: { type: String, required: true },
      // Which sign-in created the session. Identities never mix: Entra users
      // are keyed by their Entra object id, the beta account by "beta-user".
      provider: { type: String, enum: ["entra", "beta"], default: "beta" },
      email: { type: String, default: "" },
      department: { type: String, default: "" },
      jobTitle: { type: String, default: "" },
    },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: "sessions" },
);

sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = mongoose.model("Session", sessionSchema);
