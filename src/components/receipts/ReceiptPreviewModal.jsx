import { Modal } from "../common/Modal";
import { ReceiptViewer } from "./ReceiptViewer";

export function ReceiptPreviewModal({ file, onClose }) {
  return (
    <Modal title="Receipt preview" wide onClose={onClose}>
      <ReceiptViewer file={file} />
    </Modal>
  );
}
