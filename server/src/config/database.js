import mongoose from "mongoose";
import { env, redactSecrets as redact } from "./env.js";
import "../models/index.js";

// Fail fast instead of queueing queries while disconnected.
mongoose.set("bufferCommands", false);
mongoose.set("strictQuery", true);

export const isDatabaseConfigured = () => Boolean(env.mongoUri);
export const isDatabaseConnected = () => mongoose.connection.readyState === 1;

export function databaseStatus() {
  if (!isDatabaseConfigured()) return "not_configured";
  return ["disconnected", "connected", "connecting", "disconnecting"][mongoose.connection.readyState] ?? "unknown";
}

// Never log the connection string: driver errors can echo hosts or credentials.
mongoose.connection.on("disconnected", () => console.warn("MongoDB disconnected"));
mongoose.connection.on("reconnected", () => console.info("MongoDB reconnected"));
mongoose.connection.on("error", (error) => console.error(`MongoDB error: ${redact(error.message)}`));

export async function connectDatabase() {
  if (!isDatabaseConfigured()) {
    console.warn("MONGODB_URI is not set: starting without a database. Data routes return 503.");
    return false;
  }
  try {
    await mongoose.connect(env.mongoUri, {
      dbName: env.mongoDbName,
      serverSelectionTimeoutMS: 10_000,
    });
    console.info(`MongoDB connected (database "${env.mongoDbName}")`);
  } catch (error) {
    console.error(`MongoDB connection failed: ${redact(error.message)}`);
    return false;
  }
  try {
    await prepareCollections();
  } catch (error) {
    console.error(`Could not prepare collections/indexes: ${redact(error.message)}`);
  }
  return true;
}

// Models are compiled before the connection opens and command buffering is
// off, so automatic index builds would be skipped. Create the collections
// (users, expenses, receiptJobs, categories) and their indexes explicitly.
// createIndexes() only adds missing indexes; it never drops any.
async function prepareCollections() {
  for (const name of mongoose.modelNames()) {
    const model = mongoose.model(name);
    await model.createCollection().catch((error) => {
      if (error?.codeName !== "NamespaceExists") throw error;
    });
    await model.createIndexes();
  }
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}
