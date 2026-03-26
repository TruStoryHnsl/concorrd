import { useToastStore, type Toast } from "@/stores/toast";

const typeStyles: Record<Toast["type"], { icon: string; iconColor: string; border: string }> = {
  success: {
    icon: "check_circle",
    iconColor: "text-secondary",
    border: "border-secondary/20",
  },
  error: {
    icon: "error",
    iconColor: "text-error",
    border: "border-error/20",
  },
  info: {
    icon: "info",
    iconColor: "text-primary",
    border: "border-primary/20",
  },
};

function ToastItem({ toast }: { toast: Toast }) {
  const removeToast = useToastStore((s) => s.removeToast);
  const styles = typeStyles[toast.type];

  return (
    <div
      className={`glass-panel rounded-xl px-4 py-3 flex items-center gap-3 shadow-2xl border ${styles.border} animate-[slideIn_0.3s_ease-out]`}
    >
      <span className={`material-symbols-outlined text-lg ${styles.iconColor}`}>
        {styles.icon}
      </span>
      <p className="text-sm font-body text-on-surface flex-1 min-w-0">
        {toast.message}
      </p>
      <button
        onClick={() => removeToast(toast.id)}
        className="text-on-surface-variant hover:text-on-surface transition-colors shrink-0"
      >
        <span className="material-symbols-outlined text-base">close</span>
      </button>
    </div>
  );
}

function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 w-80 pointer-events-auto">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

export default ToastContainer;
