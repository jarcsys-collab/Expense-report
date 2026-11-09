// Checks a receipt's own figures against each other (Philippine VAT in particular).
// Pure: it never changes a value and never fills one in. A problem is reported for a
// person to look at; a figure that was not printed is simply not checked.
//
//   VATable sales + VAT-exempt + zero-rated + VAT = total (VAT-inclusive receipts)
//   VAT = 12% of VATable sales (the Philippine standard rate)
export const PH_VAT_RATE = 0.12;

const known = (value) => typeof value === "number" && Number.isFinite(value);
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
const fmt = (n) => n.toFixed(2);

/**
 * @param {object} expense amount, tax, subtotal, serviceCharge, tip, discount and
 *   vatBreakdown { vatableSales, vatExemptSales, zeroRatedSales }
 * @returns {{ code: string, message: string }[]}
 */
export function receiptConsistencyIssues(expense) {
  const issues = [];
  const total = expense?.amount;
  const tax = expense?.tax;
  const vat = expense?.vatBreakdown ?? {};
  const hasTotal = known(total) && total > 0;
  const hasTax = known(tax) && tax > 0;

  if (hasTotal && hasTax && tax >= total) {
    issues.push({ code: "tax_not_less_than_total", message: `The VAT/tax (${fmt(tax)}) is not less than the total (${fmt(total)}).` });
  }

  if (known(vat.vatableSales) && vat.vatableSales > 0) {
    if (hasTax && !near(tax, vat.vatableSales * PH_VAT_RATE, Math.max(0.5, vat.vatableSales * 0.005))) {
      issues.push({
        code: "vat_rate_mismatch",
        message: `The VAT (${fmt(tax)}) is not 12% of the VATable sales (${fmt(vat.vatableSales)}; 12% is ${fmt(vat.vatableSales * PH_VAT_RATE)}).`,
      });
    }
    if (hasTotal && hasTax) {
      const net = vat.vatableSales + (vat.vatExemptSales || 0) + (vat.zeroRatedSales || 0) + tax;
      const charges = (expense.serviceCharge || 0) + (expense.tip || 0) - (expense.discount || 0);
      const tolerance = Math.max(0.05, total * 0.001);
      if (!near(net, total, tolerance) && !near(net + charges, total, tolerance)) {
        issues.push({
          code: "vat_breakdown_mismatch",
          message: `The VAT breakdown adds up to ${fmt(net)}, which does not match the total (${fmt(total)}).`,
        });
      }
    }
  }
  return issues;
}
