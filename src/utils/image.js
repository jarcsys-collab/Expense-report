export async function transformImage(file, rotation = 0, trim = 0) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  const width = bitmap.width * (1 - trim * 2);
  const height = bitmap.height * (1 - trim * 2);
  const sideways = rotation % 180 !== 0;
  canvas.width = sideways ? height : width;
  canvas.height = sideways ? width : height;
  const context = canvas.getContext("2d");
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((rotation * Math.PI) / 180);
  context.drawImage(
    bitmap,
    bitmap.width * trim,
    bitmap.height * trim,
    width,
    height,
    -width / 2,
    -height / 2,
    width,
    height,
  );
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(
              new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), {
                type: "image/jpeg",
              }),
            )
          : reject(new Error("Image could not be edited.")),
      "image/jpeg",
      0.92,
    ),
  );
}
export const imageTools = {
  async analyze(file) {
    if (!file.type.startsWith("image/") || /hei[cf]/.test(file.type)) {
      return [];
    }
    try {
      const bitmap = await createImageBitmap(file);
      const warnings =
        bitmap.width < 700 || bitmap.height < 700
          ? ["Low image resolution. Check that all receipt text is readable."]
          : [];
      bitmap.close();
      return warnings;
    } catch {
      return [
        "Preview unavailable on this device. You can continue with the original file.",
      ];
    }
  },
  async optimize(file) {
    if (
      !file.type.startsWith("image/") ||
      /hei[cf]/.test(file.type) ||
      file.size < 3 * 1024 * 1024
    ) {
      return file;
    }
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width * scale;
    canvas.height = bitmap.height * scale;
    canvas
      .getContext("2d")
      .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return new Promise((resolve) =>
      canvas.toBlob(
        (blob) =>
          resolve(
            blob && blob.size < file.size
              ? new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), {
                  type: "image/jpeg",
                })
              : file,
          ),
        "image/jpeg",
        0.9,
      ),
    );
  },
};
