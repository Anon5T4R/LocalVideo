import { useEffect } from "react";

import { t } from "../lib/i18n";
import { useUi } from "../state/ui";

/**
 * A folha de atalhos (tecla `?`).
 *
 * ─── Por que ela existe ──────────────────────────────────────────────────────
 *
 * O app tem uns vinte atalhos — J/K/L com aceleração, setas na taxa do clipe,
 * S/T/Del, Ctrl+roda pra zoom ancorado, Alt invertendo o encaixe — e a única
 * lista deles vivia na TELA VAZIA. Ou seja: sumia exatamente quando começava a
 * ser útil, porque com projeto aberto não havia onde consultar. Quem não decorou
 * o J/K/L simplesmente nunca descobria que ele existe.
 *
 * A lista mora AQUI e não num `.md`: um atalho que muda no código e não muda no
 * documento vira mentira, e ninguém abre documento no meio de uma edição.
 *
 * O `helpOpen` no `ui` cala os atalhos do editor enquanto isto está aberto (o
 * mesmo cuidado do menu da topbar): senão o "S" de quem lê a folha cortaria a
 * timeline por trás dela.
 */
export default function HelpModal() {
  const open = useUi((s) => s.helpOpen);
  const setOpen = useUi((s) => s.setHelpOpen);

  // Esc fecha. Registrado só quando ABERTO, e na fase de captura pra chegar
  // antes do handler global do App (que está calado por causa do `helpOpen`,
  // mas depender dessa ordem seria frágil).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setOpen]);

  if (!open) return null;

  /** Os grupos, na ordem em que a mão os aprende: tocar, editar, régua, arquivo. */
  const groups: { title: string; rows: [string, string][] }[] = [
    {
      title: t("help.groupPlay"),
      rows: [
        [t("sc.spaceKey"), t("sc.play")],
        ["J / K / L", t("sc.jklWhat")],
        [t("sc.arrowsKey"), t("sc.step")],
        [`Shift + ${t("sc.arrowsKey")}`, t("sc.stepSecond")],
        ["Home / End", t("sc.homeEnd")],
      ],
    },
    {
      title: t("help.groupEdit"),
      rows: [
        ["S", t("sc.split")],
        ["T", t("sc.addTitle")],
        ["Ctrl + D", t("sc.duplicate")],
        ["Del", t("sc.remove")],
        ["Ctrl + Z / Ctrl + Y", `${t("sc.undo")} / ${t("sc.redo")}`],
      ],
    },
    {
      title: t("help.groupRuler"),
      rows: [
        [t("sc.dragRulerKey"), t("sc.scrub")],
        [`Ctrl + ${t("sc.wheelKey")}`, t("sc.zoomWheel")],
        [t("sc.wheelKey"), t("sc.panWheel")],
        [`Shift + ${t("sc.wheelKey")}`, t("sc.panVertical")],
        ["Alt", t("sc.altSnap")],
      ],
    },
    {
      title: t("help.groupFile"),
      rows: [
        ["Ctrl + I", t("sc.import")],
        ["Ctrl + O", t("sc.openProject")],
        ["Ctrl + S / Ctrl + Shift + S", t("sc.saveProject")],
        ["Ctrl + E", t("sc.export")],
        ["?", t("help.title")],
      ],
    },
  ];

  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div className="modal help-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t("help.title")}</h2>
        <div className="help-grid">
          {groups.map((g) => (
            <div key={g.title} className="help-group">
              <h3>{g.title}</h3>
              <ul>
                {g.rows.map(([keys, what]) => (
                  <li key={keys}>
                    <kbd>{keys}</kbd>
                    <span className="muted">{what}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <span className="muted small toolbar-fill">{t("help.hint")}</span>
          <button className="primary" onClick={() => setOpen(false)}>
            {t("dlg.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
