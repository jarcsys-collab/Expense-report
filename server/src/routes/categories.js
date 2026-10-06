import { Router } from "express";
import { HttpError } from "../middleware/errorHandler.js";
import { requireDatabase } from "../middleware/requireDatabase.js";
import { objectIdPattern, validate } from "../middleware/validate.js";
import { Category } from "../models/Category.js";
import { categorySchema, clientUuidPattern } from "../validation/category.js";

export const categoriesRouter = Router();
categoriesRouter.use(requireDatabase);

const byName = { locale: "en", strength: 2 };

// GET /api/categories
categoriesRouter.get("/", async (req, res) => {
  const categories = await Category.find().collation(byName).sort({ name: 1 });
  res.json({ categories });
});

// POST /api/categories
categoriesRouter.post("/", validate({ body: categorySchema }), async (req, res) => {
  const category = await Category.create(req.body);
  res.status(201).json(category);
});

// PUT /api/categories/:id
// :id is either a category's id, or the UUID the frontend assigns to a new
// category (its "Add category" form saves through PUT). A UUID creates the
// category on first save and updates the same one afterwards.
categoriesRouter.put("/:id", validate({ body: categorySchema }), async (req, res) => {
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
