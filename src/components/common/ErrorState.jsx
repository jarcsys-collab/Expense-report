import { TriangleAlert } from "lucide-react";

export function ErrorState({ message, retry }) {
  return (
    <div className="error-state" role="alert">
      <TriangleAlert size={22} />
      <div>
        <strong>Unable to load data</strong>
        <p>{message}</p>
      </div>
      <button className="button" onClick={retry}>
        Retry
      </button>
    </div>
  );
}
