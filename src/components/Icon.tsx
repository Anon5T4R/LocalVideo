/** Ícones do LocalVideo — SVG inline, um lugar só.
 *
 *  Existe por causa de um bug concreto: o botão de play era o caractere `▶`
 *  (U+25B6) em texto, e a pilha de fontes (`Segoe UI`) NÃO tem esse glifo no
 *  WebView2. O triângulo simplesmente sumia, enquanto o Espaço seguia tocando —
 *  o usuário via um botão de play sem play. O pause (`❚❚`) aparecia porque cai
 *  no `Segoe UI Symbol` do fallback; essa assimetria é que denunciava a causa.
 *
 *  Depender da fonte do sistema pra desenhar ícone é apostar no que cada
 *  máquina tem instalado. SVG desenha igual em todo lugar, herda a cor do texto
 *  (`currentColor`) e escala sem serrilhar. Emoji some junto (renderiza colorido
 *  e destoa de uma UI monocromática).
 *
 *  Todos no mesmo `viewBox 0 0 24 24`, traço de 2px, pontas arredondadas — pra
 *  parecerem uma família e não um saco de símbolos avulsos. Um `name` que não
 *  existe vira `null` em vez de quebrar a tela.
 */

export type IconName =
  | "play"
  | "pause"
  | "prev"
  | "next"
  | "rewind"
  | "forward"
  | "split"
  | "trash"
  | "ripple"
  | "fit"
  | "undo"
  | "redo"
  | "warn"
  | "plus"
  | "check"
  | "close"
  | "addVideo"
  | "addAudio"
  | "detachAudio"
  | "subtitle"
  | "settings"
  | "export";

interface Props {
  name: IconName;
  /** Lado do quadrado em px. O ícone é quadrado por construção. */
  size?: number;
  /** Rótulo pra leitor de tela. Sem ele o ícone é decorativo (`aria-hidden`),
   *  o que é o certo quando o botão ao lado já tem texto ou `title`. */
  label?: string;
  className?: string;
}

/** Os caminhos de cada ícone. `stroke` = contorno (a maioria); `fill` = sólido
 *  (só onde a forma cheia é o que se reconhece: play, o triângulo). */
const PATHS: Record<IconName, { d: string; fill?: boolean }> = {
  // Sólidos: a silhueta É o ícone.
  play: { d: "M8 5v14l11-7z", fill: true },
  pause: { d: "M6 5h4v14H6zM14 5h4v14h-4z", fill: true },
  prev: { d: "M7 5v14M18 5L9 12l9 7z", fill: true },
  next: { d: "M17 5v14M6 5l9 7-9 7z", fill: true },
  rewind: { d: "M11 5L2 12l9 7zM22 5l-9 7 9 7z", fill: true },
  forward: { d: "M13 5l9 7-9 7zM2 5l9 7-9 7z", fill: true },
  // Contornos.
  split: { d: "M6 4v16M9 8h9M9 16h9M18 5l-3 3 3 3M18 13l-3 3 3 3" },
  trash: { d: "M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13" },
  ripple: { d: "M5 6v12M9 9h10M19 6l3 3-3 3M9 15h6" },
  fit: { d: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" },
  undo: { d: "M9 7L4 12l5 5M4 12h11a5 5 0 0 1 0 10h-3" },
  redo: { d: "M15 7l5 5-5 5M20 12H9a5 5 0 0 0 0 10h3" },
  warn: { d: "M12 3L2 20h20zM12 9v5M12 17v.5" },
  plus: { d: "M12 5v14M5 12h14" },
  check: { d: "M4 12l5 6L20 5" },
  close: { d: "M6 6l12 12M18 6L6 18" },
  addVideo: { d: "M3 6h13v9H3zM16 9l5-3v9l-5-3M8 4v2M12 4v2" },
  addAudio: { d: "M4 15V9h4l5-4v14l-5-4zM17 8a5 5 0 0 1 0 8" },
  detachAudio: { d: "M4 8h10v8H4zM17 6v12M17 6l-2 2M17 6l2 2M17 18l-2-2M17 18l2-2" },
  subtitle: { d: "M4 5h16v14H4zM7 11h4M13 11h4M7 15h7" },
  settings: {
    d: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6M19 12l2-1-1-3-2 .5-2-1.5V6h-4v1.5L8 9l-2-.5-1 3 2 1-0 0-2 1 1 3 2-.5 2 1.5V21h4v-1.5L16 18l2 .5 1-3z",
  },
  export: { d: "M12 3v12M8 8l4-5 4 5M4 15v4h16v-4" },
};

export default function Icon({ name, size = 16, label, className }: Props) {
  const p = PATHS[name];
  if (!p) return null;
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    className,
    // Decorativo por padrão: o botão ao redor costuma ter texto/title, e um
    // leitor de tela lendo "ícone play" DEPOIS do texto "Play" é ruído.
    role: label ? "img" : undefined,
    "aria-label": label,
    "aria-hidden": label ? undefined : true,
    focusable: false,
  } as const;
  return p.fill ? (
    <svg {...common} fill="currentColor">
      <path d={p.d} />
    </svg>
  ) : (
    <svg
      {...common}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={p.d} />
    </svg>
  );
}
