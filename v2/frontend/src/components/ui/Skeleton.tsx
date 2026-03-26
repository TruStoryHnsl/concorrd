interface SkeletonProps {
  className?: string;
  /** Width — accepts Tailwind width class or raw value */
  width?: string;
  /** Height — accepts Tailwind height class or raw value */
  height?: string;
  /** Render as a circle */
  circle?: boolean;
}

function Skeleton({ className = "", width, height, circle = false }: SkeletonProps) {
  const sizeStyle: React.CSSProperties = {};
  if (width) sizeStyle.width = width;
  if (height) sizeStyle.height = height;

  return (
    <div
      className={`skeleton-shimmer ${circle ? "rounded-full" : "rounded-lg"} ${className}`}
      style={sizeStyle}
    />
  );
}

/** A pre-built card skeleton matching the GlassPanel + stat layout */
function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="glass-panel rounded-xl p-5 space-y-3">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-8 w-32" />
      {Array.from({ length: lines - 2 }).map((_, i) => (
        <Skeleton key={i} className="h-2 w-full" />
      ))}
    </div>
  );
}

export { Skeleton, SkeletonCard };
export default Skeleton;
