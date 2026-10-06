// Serialize documents the way the frontend expects: string `id`, no `_id`/`__v`.
export const toJSONOptions = {
  virtuals: false,
  versionKey: false,
  flattenMaps: true,
  transform(doc, ret) {
    if (ret._id !== undefined) {
      ret.id = String(ret._id);
      delete ret._id;
    }
    return ret;
  },
};
