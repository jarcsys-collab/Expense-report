import { Router } from "express";
import { databaseStatus } from "../config/database.js";
import { activeOcrProvider, ocrStatus } from "../services/ocrProvider.js";

export const healthRouter = Router();

// GET /api/health: liveness plus database state. Never includes connection details.
healthRouter.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "receiptflow-api",
    database: databaseStatus(),
    ocr: ocrStatus(),
    ocrProvider: activeOcrProvider(),
    time: new Date().toISOString(),
  });
});
