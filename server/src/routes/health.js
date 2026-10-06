import { Router } from "express";
import { databaseStatus } from "../config/database.js";
import { ocrStatus } from "../services/veryfiService.js";

export const healthRouter = Router();

// GET /api/health: liveness plus database state. Never includes connection details.
healthRouter.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "receiptflow-api",
    database: databaseStatus(),
    ocr: ocrStatus(),
    time: new Date().toISOString(),
  });
});
