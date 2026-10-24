import { createContext, useCallback, useContext, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToastVariant = "error" | "warning" | "info" | "success";

export interface Toast {
  id: string;
  variant: ToastVariant;
  title: string;
  body?: string;
  /** Auto-dismiss duration in ms. 0 = no auto-dismiss. Default: 6000 */
  duration?: number;
}

interface ToastContextValue {
  addToast: (toast: Omit<Toast, "id">) => void;
  removeToast: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

// ---------------------------------------------------------------------------
// Styling helpers
// ---------------------------------------------------------------------------

const VARIANT_STYLES: Record<ToastVariant, React.CSSProperties> = {
  error:   { background: "#3a1a1a", borderColor: "#cf222e", color: "#f9a8b0" },
  warning: { background: "#3a2e0a", borderColor: "#9a6700", color: "#f0c85a" },
  info:    { background: "#0d2044", borderColor: "#0969da", color: "#79b8ff" },
  success: { background: "#0f2e18", borderColor: "#1a7f37", color: "#56d364" },
};

const VARIANT_ICONS: Record<ToastVariant, string> = {
  error:   "✖",
  warning: "⚠",
  info:    "ℹ",
  success: "✔",
};

// ---------------------------------------------------------------------------
// ToastItem
// ---------------------------------------------------------------------------

function ToastItem({ toast, onRemove }: { toast: Toast; onRemove: () => void }) {
  const style = VARIANT_STYLES[toast.variant];

  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        padding: "12px 14px",
        borderRadius: 8,
        border: `1px solid ${style.borderColor}`,
        background: style.background,
        color: style.color,
        boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
        maxWidth: 380,
        wordBreak: "break-word",
        animation: "toast-in 0.2s ease",
      }}
    >
      <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>
        {VARIANT_ICONS[toast.variant]}
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{toast.title}</div>
        {toast.body && (
          <div style={{ fontSize: 13, marginTop: 4, opacity: 0.9 }}>{toast.body}</div>
        )}
      </div>
      <button
        onClick={onRemove}
        aria-label="Dismiss notification"
        style={{
          background: "transparent",
          color: "inherit",
          border: "none",
          cursor: "pointer",
          padding: 0,
          fontSize: 16,
          lineHeight: 1,
          flexShrink: 0,
          opacity: 0.7,
        }}
      >
        ×
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ToastProvider
// ---------------------------------------------------------------------------

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    clearTimeout(timers.current[id]);
    delete timers.current[id];
  }, []);

  const addToast = useCallback(
    (toast: Omit<Toast, "id">) => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const duration = toast.duration ?? 6000;
      setToasts((prev) => [...prev, { ...toast, id }]);
      if (duration > 0) {
        timers.current[id] = setTimeout(() => removeToast(id), duration);
      }
    },
    [removeToast]
  );

  return (
    <ToastContext.Provider value={{ addToast, removeToast }}>
      {children}
      <style>{`
        @keyframes toast-in {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      <div
        aria-label="Notifications"
        style={{
          position: "fixed",
          bottom: 20,
          right: 20,
          zIndex: 9999,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          pointerEvents: "none",
        }}
      >
        {toasts.map((t) => (
          <div key={t.id} style={{ pointerEvents: "auto" }}>
            <ToastItem toast={t} onRemove={() => removeToast(t.id)} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
