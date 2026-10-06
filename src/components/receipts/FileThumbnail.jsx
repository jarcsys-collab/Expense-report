import { useEffect, useState } from "react";
import { FileImage } from "lucide-react";

export function FileThumbnail({ file }) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return failed ? (
    <FileImage size={24} />
  ) : (
    <img
      className="file-thumbnail"
      src={url}
      alt={`Receipt section ${file.name}`}
      onError={() => setFailed(true)}
    />
  );
}
