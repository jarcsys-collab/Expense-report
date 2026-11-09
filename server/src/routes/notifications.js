// The signed-in person's own notifications. Every query is limited to their identity
// from the server session: another person's notification simply is not found.
import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../middleware/errorHandler.js";
import { requireDatabase } from "../middleware/requireDatabase.js";
import { validate, validateObjectId } from "../middleware/validate.js";
import { Expense } from "../models/Expense.js";
import { NotificationEvent } from "../models/NotificationEvent.js";
import { canViewExpense } from "../services/expenseAccess.js";

export const notificationsRouter = Router();
notificationsRouter.use(requireDatabase);

// Delivered in-app notifications only. Mock test records never reach an inbox.
const mine = (user) => ({ recipientId: user.id, channel: "in_app", status: "delivered", provider: { $ne: "mock" } });

const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) });

// GET /api/notifications
notificationsRouter.get("/", validate({ query: listQuery }), async (req, res) => {
  const filter = mine(req.user);
  const [events, unread] = await Promise.all([
    NotificationEvent.find(filter).sort({ createdAt: -1 }).limit(req.validatedQuery.limit).lean(),
    NotificationEvent.countDocuments({ ...filter, readAt: null }),
  ]);
  // A link is offered only when this person may actually open the request.
  const expenseIds = events.map((event) => event.expenseId).filter(Boolean);
  const expenses = expenseIds.length
    ? await Expense.find({ _id: { $in: expenseIds } }, { employeeId: 1, assignedApproverId: 1 }).lean()
    : [];
  const viewable = new Set(expenses.filter((expense) => canViewExpense(req.user, expense)).map((expense) => String(expense._id)));
  res.json({
    unread,
    notifications: events.map((event) => ({
      id: String(event._id),
      title: event.title,
      body: event.body,
      severity: event.severity,
      test: event.test === true,
      createdAt: event.createdAt,
      readAt: event.readAt ?? null,
      expenseId: event.expenseId && viewable.has(String(event.expenseId)) ? String(event.expenseId) : null,
    })),
  });
});

// GET /api/notifications/unread-count
notificationsRouter.get("/unread-count", async (req, res) => {
  res.json({ unread: await NotificationEvent.countDocuments({ ...mine(req.user), readAt: null }) });
});

// POST /api/notifications/read-all
notificationsRouter.post("/read-all", async (req, res) => {
  await NotificationEvent.updateMany({ ...mine(req.user), readAt: null }, { $set: { readAt: new Date() } });
  res.status(204).end();
});

// POST /api/notifications/:id/read
notificationsRouter.post("/:id/read", validateObjectId(), async (req, res) => {
  const event = await NotificationEvent.findOneAndUpdate(
    { _id: req.params.id, ...mine(req.user) },
    { $set: { readAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!event) throw new HttpError(404, "NOTIFICATION_NOT_FOUND", "Notification not found.");
  res.status(204).end();
});
