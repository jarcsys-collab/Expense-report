export function TableSkeleton() {
  return (
    <div
      className="panel skeleton-table"
      aria-label="Loading expenses"
      aria-busy="true"
    >
      {Array.from(
        {
          length: 7,
        },
        (_, index) => (
          <div key={index} className="skeleton" />
        ),
      )}
    </div>
  );
}
