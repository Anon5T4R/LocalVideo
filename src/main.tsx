import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";
import { useLocale } from "./lib/i18n";
import { applyTheme, useUi } from "./state/ui";

// Aplica o tema salvo antes do 1º render (evita flash) e segue a mídia do SO
// enquanto o usuário estiver em "system".
applyTheme(useUi.getState().theme);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (useUi.getState().theme === "system") applyTheme("system");
});

// Autoteste do WebCodecs: só em dev, e só quando pedido pela variável de
// ambiente. É a única forma de provar o `VideoDecoder` DENTRO do app servido —
// testar num HTML solto dá falso negativo (origin null ⇒ o VideoDecoder some).
// Em produção o `import.meta.env.DEV` é false e o bundler apaga este bloco.
if (import.meta.env.DEV && import.meta.env.VITE_SELFTEST) {
  void import("./lib/selftest").then((m) =>
    m.runWebCodecsSelfTest(import.meta.env.VITE_SELFTEST, import.meta.env.VITE_SELFTEST_DENIED),
  );
}

// Ponte de automação — SÓ EM DEV. Expõe as stores no `window` pra dirigir a
// prévia WYSIWYG por CDP sem passar pelo diálogo nativo de arquivo (montar uma
// timeline com PiP/título/crossfade e olhar o canvas). Em produção o
// `import.meta.env.DEV` é false e o bundler apaga este bloco — não vai um byte
// pro instalador.
if (import.meta.env.DEV) {
  void Promise.all([import("./state/editor"), import("./state/export")]).then(([ed, ex]) => {
    (window as unknown as Record<string, unknown>).__lv = { editor: ed.useEditor, export: ex.useExport };
  });
}

// Remonta a árvore ao trocar de idioma (todo t() é reavaliado no novo locale).
function Root() {
  const locale = useLocale();
  return <App key={locale} />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
