import { Modal } from "../common/Modal";
import { ReceiptViewer } from "./ReceiptViewer";

// `expense` lets the viewer load the stored original of a saved scan.
export function ReceiptPreviewModal({ file, expense, onClose }) {
  return (
    <Modal title="Receipt preview" wide onClose={onClose}>
      <ReceiptViewer file={file} expense={expense} />
    </Modal>
  );
}
