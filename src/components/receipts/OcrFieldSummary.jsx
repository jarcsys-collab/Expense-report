import { confidenceText } from "../../utils/ocrConfirmation";
import { formatCurrency } from "../../utils/format";

export const FIELD_LABELS = {
  merchant: "Merchant",
  merchantAddress: "Merchant address",
  expenseDate: "Receipt date",
  receiptNumber: "Receipt number",
  currency: "Currency",
  amount: "Total",
  subtotal: "Subtotal",
  tax: "VAT / tax",
  paymentMethod: "Payment method",
  // Scored by the scan, though not tracked through review.
  expenseTime: "Receipt time",
  cardLastFour: "Card last four",
  tip: "Tip",
  discount: "Discount",
  serviceCharge: "Service charge",
  vatableSales: "VATable sales",
  lineItems: "Line items",
};
export const FIELD_STATUS = {
  extracted: { label: "Read from receipt", tone: "success" },
  confirmed: { label: "Confirmed", tone: "success" },
  corrected: { label: "Corrected", tone: "warning" },
  provided: { label: "Entered by employee", tone: "pending" },
  missing: { label: "Missing", tone: "danger" },
};
const VAT_LABELS = [
  ["vatableSales", "VATable sales"],
  ["vatExemptSales", "VAT-exempt sales"],
  ["zeroRatedSales", "Zero-rated sales"],
];

// How each scanned field ended up, and the VAT figures as printed on the receipt.
export function OcrFieldSummary({ expense }) {
  const fields = expense?.ocrQuality?.fields ?? [];
  const vat = VAT_LABELS.filter(([key]) => typeof expense?.vatBreakdown?.[key] === "number");
  if (!fields.length && !vat.length) return null;
  return (
    <details className="additional-fields ocr-summary">
      <summary>Scanned receipt details</summary>
      {fields.length > 0 && (
        <ul className="ocr-field-list">
          {fields.map(({ field, status, confidence }) => {
            const info = FIELD_STATUS[status] ?? FIELD_STATUS.extracted;
            return (
              <li key={field}>
                <span>{FIELD_LABELS[field] ?? field}</span>
                <span className="ocr-field-status">
                  {typeof confidence === "number" && status !== "missing" && <small>{confidenceText(confidence)}</small>}
                  <span className={`badge ${info.tone}`}>
                    <i />
                    {info.label}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {vat.length > 0 && (
        <>
          <h4 className="form-group-title">VAT as printed on the receipt</h4>
          <dl className="ocr-vat-list">
            {vat.map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{formatCurrency(expense.vatBreakdown[key], expense.currency || "PHP")}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </details>
  );
}
