import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { useWorkspace } from "../../hooks/useWorkspace";
import { api } from "../../services/api";
import { fetchReceiptBlob } from "../../services/receiptFiles";
import { transformImage } from "../../utils/image";
import { Modal } from "../common/Modal";
import { Spinner } from "../common/Spinner";

export function ImageEditModal({ file, onClose, onSave }) {
  const { run } = useWorkspace();
  const [trim, setTrim] = useState(0);
  const [rotation, setRotation] = useState(0);
  const [saving, setSaving] = useState(false);
  const [sourceFile, setSourceFile] = useState();
  useEffect(() => {
    run(async () => {
      const _ = await fetchReceiptBlob(file);
      setSourceFile(
        new File([_], file.name, {
          type: _.type,
        }),
      );
    });
  }, [file]);
  return (
    <Modal
      title="Crop & rotate receipt"
      onClose={() => {
        if (!saving) {
          onClose();
        }
      }}
    >
      <div className="capture-preview">
        <img
          src={file.url}
          alt="Receipt crop preview"
          style={{
            clipPath: `inset(${trim * 100}%)`,
            transform: `rotate(${rotation}deg)`,
          }}
        />
      </div>
      <label className="field">
        Trim edges ({Math.round(trim * 100)}%)
        <input
          type="range"
          min="0"
          max=".2"
          step=".01"
          value={trim}
          onChange={(_) => setTrim(Number(_.target.value))}
        />
      </label>
      <p className="muted">
        Trims each edge equally. Keep every line of text visible. The edited
        copy will be added alongside your original.
      </p>
      <footer>
        <button
          className="button"
          onClick={() => setRotation((_) => (_ + 90) % 360)}
        >
          <RotateCw size={16} />
          Rotate
        </button>
        <button
          className="button primary"
          disabled={saving || !sourceFile}
          onClick={async () => {
            setSaving(true);
            const _ = await run(async () => {
              const edited = await transformImage(sourceFile, rotation, trim);
              return api.saveEditedFile(edited, file.pageNumber + 1);
            }, "Edited receipt added");
            setSaving(false);
            if (_) {
              onSave(_);
              onClose();
            }
          }}
        >
          {saving ? <Spinner /> : null}Save edited copy
        </button>
      </footer>
    </Modal>
  );
}
