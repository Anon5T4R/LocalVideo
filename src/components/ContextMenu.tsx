/** Menu de contexto (botão direito) — o LocalVideo não tinha nenhum, e a falta
 *  aparecia: tudo passava por toolbar e atalho, e clicar com o direito num clipe
 *  não fazia nada, que num editor de vídeo lê como quebrado.
 *
 *  Genérico de propósito: recebe uma lista de itens e a posição do clique. Quem
 *  decide QUAIS ações aparecem é quem abre (a timeline monta as ações do clipe;
 *  outro lugar montaria as dele). Aqui só cuida do que todo menu precisa acertar
 *  e costuma errar: fechar ao clicar fora, fechar no Esc, e não vazar da tela.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  onClick: () => void;
  /** Cinza e sem clique — a ação existe mas não cabe agora (ex.: separar áudio
   *  de um clipe sem som). Mostrar desabilitado ensina que a ação existe. */
  disabled?: boolean;
  /** Risca um traço acima do item — agrupa sem precisar de submenu. */
  divider?: boolean;
  /** Ações destrutivas (remover) em vermelho. */
  danger?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export default function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Reposiciona pra dentro da janela DEPOIS de medir: aberto perto da borda de
  // baixo/direita, um menu que vaza fica com metade dos itens fora do alcance.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + r.width > window.innerWidth) left = Math.max(4, window.innerWidth - r.width - 4);
    if (top + r.height > window.innerHeight) top = Math.max(4, window.innerHeight - r.height - 4);
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    // `pointerdown` e não `click`: fechar no APERTAR faz o menu sumir antes de um
    // arraste começar, que é o que o usuário espera de menu de contexto.
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="ctxmenu" style={{ left: pos.left, top: pos.top }} role="menu">
      {items.map((it, i) => (
        <button
          key={i}
          className={`ctxmenu-item${it.danger ? " danger" : ""}${it.divider ? " divided" : ""}`}
          role="menuitem"
          disabled={it.disabled}
          onClick={() => {
            it.onClick();
            onClose();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
