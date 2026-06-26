import React, { createContext, useCallback, useContext, useRef, useState } from 'react';

// Lightweight toast system (no npm dep). One provider at the App root exposes
// useToast().show(); toasts stack bottom-right and auto-dismiss after ~3s.
// Used for success feedback (decision recorded, report copied) so the views no
// longer have to overload their page-level error string for positive signals.

type ToastTone = 'success' | 'error' | 'info';
interface ToastItem { id: number; message: string; tone: ToastTone; }
interface ToastApi { show: (message: string, tone?: ToastTone) => void; }

const ToastContext = createContext<ToastApi | null>(null);

// Safe no-op fallback so a component rendered outside the provider never crashes.
const NOOP: ToastApi = { show: () => {} };

export function useToast(): ToastApi {
  return useContext(ToastContext) ?? NOOP;
}

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const show = useCallback((message: string, tone: ToastTone = 'success') => {
    const id = ++seq.current;
    setToasts((list) => [...list, { id, message, tone }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 3000);
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="toast-stack" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`} role="status">{t.message}</div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};
