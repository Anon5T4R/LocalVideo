/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Caminho de um vídeo pro autoteste do WebCodecs (só em dev — ver
   * `lib/selftest.ts`). Vazio = não roda.
   */
  readonly VITE_SELFTEST: string;
  /**
   * Caminho de um vídeo que o autoteste **não** libera, pra provar que o escopo
   * do asset segue fechado pra quem o usuário não escolheu. Opcional.
   */
  readonly VITE_SELFTEST_DENIED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
