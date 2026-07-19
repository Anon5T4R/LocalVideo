import { create } from "zustand";

export type Theme =
  | "light"
  | "dark"
  | "system"
  | "nature"
  | "darkblue"
  | "calmgreen"
  | "pastelpink"
  | "punkprincess";

export interface Toast {
  id: number;
  kind: "info" | "error" | "ok";
  text: string;
  /** Quantas vezes ESTA mesma mensagem chegou (ver `pushToast`). */
  count: number;
}

interface UiState {
  theme: Theme;
  settingsOpen: boolean;
  toasts: Toast[];
  /**
   * Quais seções do inspetor o usuário abriu/fechou NESTA sessão.
   *
   * Só o que ele MEXEU entra aqui — `undefined` significa "ainda não opinou", e
   * aí vale o padrão da seção (aberta quando a propriedade está em uso). Se
   * guardássemos o estado inicial de todas, o padrão "nasce aberta porque tem
   * valor" morreria no primeiro render e a dica visual se perderia.
   *
   * Sessão e não `localStorage` de propósito: é preferência de momento (estou
   * mexendo em cor agora), não configuração.
   */
  sections: Record<string, boolean>;
  /**
   * Há um menu da topbar (Arquivo/Importar) aberto?
   *
   * Mora aqui e não no componente porque quem precisa da resposta é o handler
   * GLOBAL de teclas do `App`: sem isso, "S" cortaria a timeline por trás do
   * menu Arquivo aberto e "Del" apagaria um clipe enquanto se lê "Salvar como".
   * É a mesma trava que `settingsOpen` e o modal de exportação já tinham.
   */
  menuOpen: boolean;
  /**
   * Há uma CONFIRMAÇÃO aberta (remover trilha não-vazia)?
   *
   * Existe pelo mesmo motivo que `menuOpen`: o handler global de teclas do `App`
   * precisa calar. Sem isto, "Del" enquanto se lê "remover a trilha com 4
   * clipes?" apagaria um clipe por trás do diálogo — e o usuário atribuiria o
   * sumiço ao botão que ainda nem clicou. Campo próprio (e não reusar
   * `menuOpen`) porque o nome é o que explica a trava daqui a seis meses.
   */
  confirmOpen: boolean;
  /**
   * A folha de atalhos (tecla `?`) está aberta?
   *
   * Até a v0.9 a lista de atalhos existia só na tela VAZIA — ou seja, ela sumia
   * exatamente quando começava a ser útil (com projeto aberto não havia como
   * consultar, e o app tem uns vinte). Entra na mesma trava de teclas que
   * `menuOpen`/`confirmOpen`: com a folha aberta, "S" não pode cortar a timeline
   * por trás dela.
   */
  helpOpen: boolean;
  /**
   * O painel de mídia (a coluna da esquerda) está aberto?
   *
   * Nasce ABERTO e persiste em `localStorage` — as duas coisas por disciplina,
   * não por moda. Aberto porque painel com conteúdo em uso nasce visível (é a
   * regra da suíte: o usuário não deve ter que descobrir onde foi parar o que
   * ele acabou de importar). Persistente — e não de sessão como `sections` —
   * porque é LAYOUT de bancada, não "estou mexendo em cor agora": quem edita em
   * tela pequena fecha o painel uma vez e não quer reabri-lo a cada projeto. É o
   * mesmo critério do tema e do interruptor de snap.
   */
  poolOpen: boolean;
  /**
   * O caminho que está sendo arrastado DO painel pra timeline agora (`null` =
   * nenhum). Mora no store porque o gesto atravessa dois componentes que não se
   * conhecem: quem começa é o `MediaPool`, quem termina (e sabe converter pixel
   * em ms e achar a lane) é a `Timeline`.
   *
   * Só o CAMINHO, e não a posição do ponteiro: guardar x/y aqui faria a store
   * disparar re-render de todo mundo a 60 Hz durante o arrasto. Cada lado segue
   * o ponteiro no seu próprio `pointermove` e mantém o rastro em estado local.
   */
  poolDragPath: string | null;

  setTheme: (t: Theme) => void;
  setMenuOpen: (v: boolean) => void;
  setConfirmOpen: (v: boolean) => void;
  setHelpOpen: (v: boolean) => void;
  setPoolOpen: (v: boolean) => void;
  setPoolDragPath: (v: string | null) => void;
  setSettingsOpen: (v: boolean) => void;
  /** Abre/fecha uma seção do inspetor (`open` explícito sobrescreve o padrão). */
  toggleSection: (id: string, open: boolean) => void;
  pushToast: (kind: Toast["kind"], text: string) => void;
  dismissToast: (id: number) => void;
}

const THEME_KEY = "localvideo.theme";
const POOL_KEY = "localvideo.pool";

/** O painel de mídia começa ABERTO (ausente = aberto); só um "0" gravado o
 *  fecha. O `typeof` é o de sempre: este módulo roda em teste Node. */
function loadPoolOpen(): boolean {
  if (typeof localStorage === "undefined") return true;
  return localStorage.getItem(POOL_KEY) !== "0";
}

export const THEMES: Theme[] = [
  "system",
  "light",
  "dark",
  "nature",
  "darkblue",
  "calmgreen",
  "pastelpink",
  "punkprincess",
];

/** O `typeof` não é paranoia: este módulo é importado por teste que roda em
 *  Node (sem `localStorage`), e o `i18n` ao lado já se guarda igual. */
function loadTheme(): Theme {
  const v = typeof localStorage !== "undefined" ? localStorage.getItem(THEME_KEY) : null;
  return v && (THEMES as string[]).includes(v) ? (v as Theme) : "system";
}

/** Aplica o tema no <html data-theme> (resolvendo "system" pela mídia). */
export function applyTheme(theme: Theme) {
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  document.documentElement.dataset.theme = resolved;
}

let nextToast = 1;

export const useUi = create<UiState>((set) => ({
  theme: loadTheme(),
  settingsOpen: false,
  toasts: [],
  sections: {},
  menuOpen: false,
  confirmOpen: false,
  helpOpen: false,
  poolOpen: loadPoolOpen(),
  poolDragPath: null,

  setMenuOpen: (menuOpen) => set({ menuOpen }),
  setConfirmOpen: (confirmOpen) => set({ confirmOpen }),
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  setPoolOpen: (poolOpen) => {
    try {
      localStorage.setItem(POOL_KEY, poolOpen ? "1" : "0");
    } catch {
      /* sem localStorage (teste em Node) o painel ainda abre/fecha na sessão */
    }
    set({ poolOpen });
  },
  setPoolDragPath: (poolDragPath) => set({ poolDragPath }),
  toggleSection: (id, open) => set((s) => ({ sections: { ...s.sections, [id]: open } })),

  setTheme: (theme) => {
    localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
    set({ theme });
  },
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  /**
   * Mensagem repetida NÃO vira tijolo novo: ela conta.
   *
   * Tentar o mesmo arquivo quebrado três vezes empilhava três retângulos
   * vermelhos idênticos — que é ruído, não informação. O `id` fica o mesmo de
   * propósito (o React não remonta o toast); só o `count` sobe, e é ele que
   * reinicia o relógio de saída lá no `Toasts`.
   */
  pushToast: (kind, text) =>
    set((s) => {
      const i = s.toasts.findIndex((t) => t.text === text && t.kind === kind);
      if (i < 0) return { toasts: [...s.toasts, { id: nextToast++, kind, text, count: 1 }] };
      const toasts = s.toasts.slice();
      toasts[i] = { ...toasts[i], count: toasts[i].count + 1 };
      return { toasts };
    }),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
