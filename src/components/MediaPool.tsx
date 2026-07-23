import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";

import ContextMenu, { type MenuItem } from "./ContextMenu";
import Icon from "./Icon";
import { t } from "../lib/i18n";
import { formatDuration } from "../lib/probe";
import { baseVideoTrack, mediaUsageCount, trackEnd } from "../lib/timeline";
import { baseName, dirName, useEditor } from "../state/editor";
import { resolveLaneDrop, type LaneDrop } from "../state/lanedrop";
import { useUi } from "../state/ui";

/**
 * O PAINEL DE MÍDIA (o "pool") — a coluna da esquerda com tudo que foi importado.
 *
 * O buraco que ele fecha: até a v0.10, importar jogava o clipe direto na
 * timeline e **reusar um arquivo já importado exigia reimportar do disco** —
 * abrir o diálogo, navegar até a pasta, achar o arquivo de novo, esperar a sonda
 * outra vez. O estado sempre esteve todo aqui (o `media` do editor já guarda
 * caminho, duração, dimensões, faixas, miniaturas e, desde a v0.10, os picos de
 * áudio): faltava só a UI. É o que separa "app que corta vídeo" de editor.
 *
 * Três gestos, e cada um respondendo a uma pergunta diferente:
 * - **arrastar pra régua** — reusar (posição = onde soltou; trilha = a que soltou);
 * - **soltar arquivo NO PAINEL** — importar sem inserir (ver `App.tsx`);
 * - **×** — tirar do projeto (com confirmação se houver clipe usando).
 */

/** Quantos pixels o dedo anda antes de virar arrasto. Sem esta folga, um clique
 *  trêmulo no item já dispararia o fantasma e a marca na régua — ruído em cima
 *  de um gesto que nem começou. 4px é o mesmo limiar que todo NLE usa. */
const DRAG_SLOP = 4;

/**
 * O retângulo do painel, pra quem está FORA do React perguntar (o handler de
 * drop nativo do Tauri, em `App.tsx`, precisa saber se o arquivo caiu aqui ou na
 * timeline — e ele só recebe uma coordenada de tela, não um alvo de DOM).
 *
 * Módulo e não `ref` compartilhado porque o consumidor é um listener registrado
 * UMA vez, fora da árvore: um ref passado por prop estaria sempre um render
 * atrasado, e o painel recolhido/expandido muda de tamanho.
 */
let poolEl: HTMLElement | null = null;
export function poolRectAt(clientX: number, clientY: number): boolean {
  if (!poolEl) return false;
  const r = poolEl.getBoundingClientRect();
  return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
}

export default function MediaPool({ osDropping }: { osDropping: boolean }) {
  const media = useEditor((s) => s.media);
  const thumbs = useEditor((s) => s.thumbs);
  const missing = useEditor((s) => s.missing);
  const timeline = useEditor((s) => s.history.present);
  const doInsertMedia = useEditor((s) => s.doInsertMedia);
  const doRemoveMedia = useEditor((s) => s.doRemoveMedia);
  const poolOpen = useUi((s) => s.poolOpen);
  const setPoolOpen = useUi((s) => s.setPoolOpen);
  const poolDragPath = useUi((s) => s.poolDragPath);
  const setPoolDragPath = useUi((s) => s.setPoolDragPath);
  const setConfirmOpen = useUi((s) => s.setConfirmOpen);

  /** O arquivo que o usuário mandou remover e que AINDA tem clipe na timeline:
   *  a confirmação. `null` = não há nada pra confirmar. */
  const [kill, setKill] = useState<{ path: string; n: number } | null>(null);
  /** Menu de contexto de um item do pool (`null` = fechado). O painel era o
   *  único canto do app onde o botão direito não fazia nada — e "arrastar" era
   *  o ÚNICO jeito de usar um arquivo, o que ninguém descobre sem a dica. */
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  /** Onde o ponteiro está e onde o clipe cairia — só existe durante o arrasto. */
  const [ghost, setGhost] = useState<{ x: number; y: number; drop: LaneDrop | null } | null>(null);

  /** O gesto em curso, fora do React: um `useState` aqui perderia o começo do
   *  arrasto (o primeiro `pointermove` chega antes do re-render). */
  const pressRef = useRef<{ path: string; x0: number; y0: number; armed: boolean } | null>(null);

  const paths = Object.keys(media).sort((a, b) =>
    baseName(a).localeCompare(baseName(b), undefined, { numeric: true, sensitivity: "base" }),
  );

  /* ---------------- o arrasto pool → régua ---------------- */

  // Um dono só pro gesto inteiro (ver o cabeçalho de `state/lanedrop.ts`): este
  // efeito escuta o ponteiro, pergunta à régua onde cairia, desenha a marca e —
  // no `pointerup` — insere. A `Timeline` não escuta nada, só responde.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const p = pressRef.current;
      if (!p) return;
      if (!p.armed) {
        if (Math.abs(e.clientX - p.x0) < DRAG_SLOP && Math.abs(e.clientY - p.y0) < DRAG_SLOP) return;
        p.armed = true;
        setPoolDragPath(p.path);
      }
      setGhost({ x: e.clientX, y: e.clientY, drop: resolveLaneDrop(e.clientX, e.clientY) });
    };
    const onUp = (e: PointerEvent) => {
      const p = pressRef.current;
      pressRef.current = null;
      if (!p) return;
      // Não armou: foi um clique, não um arrasto. Nada a fazer (e nada a
      // desfazer) — soltar o estado do gesto basta.
      if (p.armed) {
        const drop = resolveLaneDrop(e.clientX, e.clientY);
        // Soltar FORA de qualquer lane é o cancelar natural do gesto: some o
        // fantasma e nada entra na timeline. Sem isso, largar o arrasto no meio
        // do inspetor criaria um clipe onde a pessoa não estava olhando.
        if (drop) doInsertMedia(p.path, drop.trackId, drop.startMs);
      }
      setPoolDragPath(null);
      setGhost(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    // `pointercancel` também: um gesto interrompido pelo sistema (toque virando
    // rolagem, janela perdendo o foco) nunca manda `pointerup`, e sem isto o
    // fantasma ficaria colado na tela pro resto da sessão.
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [doInsertMedia, setPoolDragPath]);

  const beginDrag = (e: React.PointerEvent, path: string) => {
    // Só botão principal: com o direito o gesto seria um menu de contexto que
    // nasceria arrastando um clipe junto.
    if (e.button !== 0) return;
    pressRef.current = { path, x0: e.clientX, y0: e.clientY, armed: false };
    // Capturar é BÔNUS (quem escuta de verdade é a window, acima): serve pra o
    // gesto sobreviver ao ponteiro saindo do item. E é try/catch obrigatório —
    // com um pointer que já não está ativo, `setPointerCapture` lança
    // `NotFoundError` e mata o handler CALADO. É o gotcha que já mordeu cinco
    // apps da suíte; aqui ele levaria junto o arrasto inteiro.
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* pointer não-ativo: o gesto segue pelos listeners da window */
    }
  };

  /* ---------------- remover do pool ---------------- */

  const closeKill = () => {
    setKill(null);
    setConfirmOpen(false);
  };

  const askRemove = (path: string) => {
    const n = mediaUsageCount(timeline, path);
    // Sem clipe usando, sai na hora: não há trabalho pra perder, e uma
    // confirmação por clique treina o usuário a clicar "sim" sem ler — que é
    // exatamente o que estraga a confirmação que IMPORTA (a de baixo).
    if (n === 0) {
      doRemoveMedia(path);
      return;
    }
    setConfirmOpen(true);
    setKill({ path, n });
  };

  /** As ações do botão direito num item. Inserir usa a MESMA porta do arrasto
   *  (`doInsertMedia`) — só muda quem decide a posição: o fim da trilha base ou
   *  o playhead, em vez do dedo. Arquivo sumido não insere (não há duração). */
  const poolMenuItems = (path: string): MenuItem[] => {
    const gone = missing.includes(path);
    const insertAt = (startMs: number) => {
      const base = baseVideoTrack(useEditor.getState().history.present);
      if (base) doInsertMedia(path, base.id, Math.max(0, Math.round(startMs)));
    };
    return [
      {
        label: t("pool.ctxInsertEnd"),
        onClick: () => {
          const base = baseVideoTrack(useEditor.getState().history.present);
          if (base) insertAt(trackEnd(base));
        },
        disabled: gone,
      },
      {
        label: t("pool.ctxInsertPlayhead"),
        onClick: () => insertAt(useEditor.getState().playhead),
        disabled: gone,
      },
      {
        // Mesmo padrão do ExportModal: reveal nativo (arquivo selecionado no
        // explorador) e, se ele faltar, ao menos abrir a pasta.
        label: t("exp.revealFile"),
        onClick: () => {
          void revealItemInDir(path).catch(() => {
            void openPath(dirName(path)).catch(() => {});
          });
        },
        divider: true,
      },
      { label: t("pool.remove"), onClick: () => askRemove(path), danger: true, divider: true },
    ];
  };

  /* ---------------- render ---------------- */

  // Recolhido: sobra uma faixa fina com o botão de reabrir. Some por completo
  // seria pior — o painel viraria um recurso que o usuário fechou uma vez e
  // nunca mais achou.
  if (!poolOpen) {
    return (
      <div className="pool collapsed" ref={(el) => void (poolEl = el)}>
        <button
          className="pool-toggle"
          onClick={() => setPoolOpen(true)}
          title={t("pool.expand")}
          aria-expanded={false}
        >
          ›
        </button>
        <span className="pool-rail-label" aria-hidden>
          {t("pool.title")}
        </span>
        <span className="pool-rail-count tabnum">{paths.length}</span>
      </div>
    );
  }

  return (
    <div
      className={`pool card ${osDropping ? "dropping" : ""}`}
      ref={(el) => void (poolEl = el)}
    >
      <div className="card-head pool-head">
        <strong>{t("pool.title")}</strong>
        <span className="muted small tabnum">{t("pool.count", { n: paths.length })}</span>
        <button
          className="pool-toggle"
          onClick={() => setPoolOpen(false)}
          title={t("pool.collapse")}
          aria-expanded
        >
          ‹
        </button>
      </div>

      {/* Rola SÓ esta lista — nunca o workspace (a regra que a F1 estabeleceu e
          que é a causa nº1 do "tá estranho" quando quebrada: rolar as opções
          levava a prévia pra fora da tela). */}
      <div className="pool-list">
        {paths.length === 0 ? (
          <p className="muted small pool-empty">{t("pool.empty")}</p>
        ) : (
          paths.map((path) => {
            const info = media[path];
            const uses = mediaUsageCount(timeline, path);
            const gone = missing.includes(path);
            const thumb = thumbs[path]?.urls[0];
            return (
              <div
                key={path}
                className={`pool-item ${gone ? "gone" : ""} ${poolDragPath === path ? "dragging" : ""}`}
                onPointerDown={(e) => beginDrag(e, path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, path });
                }}
                title={`${path}\n${t("pool.dragHint")}`}
              >
                <div className="pool-thumb" aria-hidden>
                  {thumb ? <img src={thumb} alt="" draggable={false} /> : <Icon name="addVideo" />}
                </div>
                <div className="pool-meta">
                  <span className="pool-name">{baseName(path)}</span>
                  <span className="muted small pool-sub">
                    <b className="tabnum">{formatDuration(info.durationMs)}</b>
                    {info.width > 0 ? (
                      <span className="tabnum">
                        {" · "}
                        {info.width}×{info.height}
                      </span>
                    ) : null}
                    {/* "em uso: N" é o que responde à pergunta que o botão de
                        remover levanta ("posso tirar isto?") ANTES do clique. */}
                    {uses > 0 ? <span> · {t("pool.uses", { n: uses })}</span> : null}
                    {gone ? <span className="pool-gone"> · {t("pool.gone")}</span> : null}
                  </span>
                </div>
                <button
                  className="mini pool-x"
                  // O × não pode virar arrasto: sem parar o `pointerdown` aqui,
                  // clicar pra remover armaria o gesto do item inteiro.
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    askRemove(path);
                  }}
                  title={t("pool.remove")}
                >
                  ×
                </button>
              </div>
            );
          })
        )}
      </div>

      <p className="muted small pool-foot">{t("pool.foot")}</p>

      {/* O fantasma do arrasto e a marca de "cai aqui". `fixed` porque o gesto
          atravessa painéis com rolagens próprias — em coordenadas de qualquer
          um dos containers, o fantasma ficaria preso atrás do `overflow`. */}
      {ghost && poolDragPath ? (
        <>
          <div className="pool-ghost" style={{ left: ghost.x + 12, top: ghost.y + 12 }}>
            {baseName(poolDragPath)}
          </div>
          {ghost.drop ? (
            <div
              className="pool-dropmark"
              style={{ left: ghost.drop.left, top: ghost.drop.top, height: ghost.drop.height }}
            />
          ) : null}
        </>
      ) : null}

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={poolMenuItems(menu.path)}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {kill ? (
        <div className="modal-backdrop" onClick={closeKill}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{t("pool.removeTitle", { name: baseName(kill.path) })}</h2>
            {/* O que a confirmação PRECISA dizer: os clipes NÃO saem junto (é a
                diferença entre isto e remover uma trilha) — some do painel e a
                timeline continua tocando o arquivo. Sem essa frase, o usuário
                supõe o pior e nunca usa o botão. */}
            <p className="muted">{t("pool.removeBody", { n: kill.n })}</p>
            <div className="modal-actions">
              <button onClick={closeKill}>{t("dlg.cancel")}</button>
              <button
                className="danger"
                onClick={() => {
                  doRemoveMedia(kill.path);
                  closeKill();
                }}
              >
                {t("pool.remove")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
