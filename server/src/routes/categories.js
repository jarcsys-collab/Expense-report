import { Router } from "express";
import { HttpError } from "../middleware/errorHandler.js";
import { requireDatabase } from "../middleware/requireDatabase.js";
import { requireRole } from "../middleware/requireRole.js";
import { objectIdPattern, validate } from "../middleware/validate.js";
import { Category } from "../models/Category.js";
import { categorySchema, clientUuidPattern } from "../validation/category.js";

export const categoriesRouter = Router();
categoriesRouter.use(requireDatabase);

const byName = { locale: "en", strength: 2 };

// Category policies are managed by Finance. Everyone signed in can read the
// active categories and choose one; only these roles can create or change them.
const MANAGERS = ["FINANCE_ADMIN"];
const canManage = (user) => MANAGERS.includes(user?.role);

// GET /api/categories
// Finance admins see every category (including inactive ones, to manage them);
// other users only see active categories they can select.
categoriesRouter.get("/", async (req, res) => {
  const filter = canManage(req.user) ? {} : { active: { $ne: false } };
  const categories = await Category.find(filter).collation(byName).sort({ name: 1 });
  res.json({ categories });
});

// POST /api/categories
categoriesRouter.post("/", requireRole(...MANAGERS), validate({ body: categorySchema }), async (req, res) => {
  const category = await Category.create(req.body);
  res.status(201).json(category);
});

// PUT /api/categories/:id
// Renaming, remapping or deactivating a category never changes existing
// expenses: they keep the category name and policy key they were saved with.
// :id is either a category's id, or the UUID the frontend assigns to a new
// category (its "Add category" form saves through PUT). A UUID creates the
// category on first save and updates the same one afterwards.
categoriesRouter.put("/:id", requireRole(...MANAGERS), validate({ body: categorySchema }), async (req, res) => {
  const { id } = req.params;
  const options = { returnDocument: "after", runValidators: true };
  let category;
  if (objectIdPattern.test(id)) {
    category = await Category.findByIdAndUpdate(id, req.body, options);
    if (!category) throw new HttpError(404, "CATEGORY_NOT_FOUND", "Category not found.");
  } else if (clientUuidPattern.test(id)) {
    category = await Category.findOneAndUpdate({ clientId: id }, { ...req.body, clientId: id }, {
      ...options,
      upsert: true,
      setDefaultsOnInsert: true,
    });
  } else {
    throw new HttpError(400, "INVALID_ID", "The id is not a valid id.");
  }
  res.json(category);
});
