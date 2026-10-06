import { Receipt } from "lucide-react";

export function EmptyState({
  title = "No expenses found",
  message = "Try another search or adjust your filters.",
  children,
}) {
  return (
    <div className="empty">
      <Receipt size={32} />
      <h3>{title}</h3>
      <p>{message}</p>
      {children}
    </div>
  );
}
