import { useEffect } from "react";
import { useUi, type Toast } from "../state/ui";

/** Quanto um toast fica na tela. Uma mensagem repetida reinicia esta contagem. */
const TOAST_MS = 5000;

/**
 * Cada toast tem o SEU relógio.
 *
 * Antes o relógio era um só, armado pro primeiro da fila e re-armado a cada
 * mudança da lista: com três toasts, o terceiro só começava a morrer depois de o
 * primeiro sair — doze segundos de parede vermelha. Um componente por toast dá a
 * cada um a sua vida, e o `count` nas deps faz a repetição reiniciar o relógio
 * (a mensagem acabou de acontecer de novo; ela merece os 5 s inteiros).
 */
function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast.id, toast.count, onDismiss]);

  return (
    <div className={`toast ${toast.kind}`} onClick={() => onDismiss(toast.id)}>
      <span>{toast.text}</span>
      {/* "×3" conta a repetição sem gastar três toasts pra dizer a mesma coisa. */}
      {toast.count > 1 ? <b className="toast-count">×{toast.count}</b> : null}
    </div>
  );
}

/** Toasts empilhados no canto (somem sozinhos). */
export default function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);

  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
      ))}
    </div>
  );
}
