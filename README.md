# LocalVideo

Editor de vídeo (NLE) **100% offline** da suíte Local. Faz par com o
[LocalRecord](https://github.com/Anon5T4R/LocalRecord): Record é a ponta da
captura, Video é a ponta da edição.

Importe um vídeo, corte, apare, reordene — e exporte. Cortar **não mexe no
arquivo original** (um clipe é só uma janela sobre ele) e nada sobe pra lugar
nenhum: o ffmpeg roda aqui, na sua máquina.

## Estado

**v0.6.0.** Importar (ffprobe), timeline **multi-trilha** com miniaturas,
cortar/aparar/reordenar/remover com snap a quadro-chave e ripple, undo/redo,
projeto `.tvproj`, **exportar pelos dois caminhos**, **prévia quadro a quadro
(WebCodecs)**, importação de marcadores, **PiP/camadas com keyframes de
posição/escala/opacidade**, **transições** (crossfade/wipe/slide), **mix de
áudio por clipe**, **separar áudio do vídeo** (uma trilha por faixa do
arquivo — takes do LocalRecord com mic + áudio do sistema viram duas trilhas
editáveis), **legendas** (importa SRT/VTT como clipes de título editáveis,
queimadas no export), títulos com drawtext, e **menu de contexto** nos clipes.

### Exportar: os dois caminhos

O app escolhe sozinho e **conta qual pegou e por quê**:

- **`-c copy`** (concat demuxer com `inpoint`/`outpoint`) quando **todo corte cai
  num quadro-chave** — quase instantâneo e sem perda. Medido num clipe de 9 s:
  **74 ms**, contra **343 ms** do re-encode; a distância cresce com a duração.
  O preço honesto: a saída fica ~0,1 s mais longa que o pedido (o vídeo sai em
  pacotes inteiros e o áudio vem em blocos de ~21 ms que não se cortam ao meio
  sem recodificar).
- **`filter_complex`** quando algum corte **não** cai em quadro-chave, quando os
  clipes têm formatos/tamanhos diferentes, ou quando não deu pra ler os
  quadros-chave. Mais lento, com corte no quadro exato.

Opcional, e desligado por padrão: **encostar os cortes no quadro-chave mais
perto** pra ganhar o caminho rápido. Ele só aparece quando realmente muda o
caminho, e mostra o desvio — mexer no corte de alguém é troca que a pessoa
escolhe.

### Prévia quadro a quadro

O `<video>` toca (áudio e ritmo de graça); parado, o quadro exato é decodificado
com **WebCodecs** (`VideoDecoder` + demuxer mp4box) e pintado num canvas. Onde
não dá — sem `VideoDecoder`, ou num container que o demuxer não abre
(MKV/WebM/AVI) —, **o app degrada e diz que a prévia é aproximada**, em vez de
fingir uma precisão que não tem.

### Marcadores (ponte com o LocalRecord)

O LocalVideo lê um JSON de marcadores e **corta a timeline neles**:

```json
{
  "app": "LocalRecord",
  "version": 1,
  "source": "C:\\gravacoes\\aula.mp4",
  "markers": [{ "tMs": 1500, "label": "intro" }, { "tMs": 42000 }]
}
```

`tMs` é **milissegundo** (o nome diz a unidade de propósito) e é tempo **dentro
do arquivo gravado**, não da timeline. `source` é opcional — sem ele, só funciona
se houver um vídeo só na timeline (adivinhar qual vídeo cortar seria pior que
recusar). Também aceita um array pelado: `[1500, 42000]`.

> **O LocalRecord v0.1.2 ainda NÃO exporta marcadores** — conferido no código
> dele: não há conceito de marcador, e ele nem tem permissão de escrever arquivo
> (o que ele chama de "anotação" é desenho a caneta, sem eixo de tempo). O
> formato acima é **nosso**, e está aqui pra que a ponte exista de um lado
> enquanto o outro não chega. Nada foi inventado em nome do Record.

## Rodar

```bash
npm install
bash scripts/fetch-ffmpeg.sh      # ou: powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1
npm run tauri dev
```

O ffmpeg (build GPL, embarcado em `src-tauri/binaries/ffmpeg`) **não é
versionado** — os scripts acima baixam, e o instalador do release já vai com ele
dentro.

## Testes

```bash
npx tsc --noEmit && npm test && npm run build
cd src-tauri && cargo test --locked
```

Os portões acima são **puros**: não baixam nem chamam o ffmpeg.

**Exportar de verdade** (roda o ffmpeg, prova os dois caminhos com `ffprobe` no
resultado — porque arquivo existir não é prova):

```bash
bash scripts/fetch-ffmpeg.sh
LOCALVIDEO_FFMPEG_TESTS=1 npx vitest run export.real
```

**Provar o WebCodecs dentro do app** (num HTML solto o contexto é `origin: null`,
o `VideoDecoder` some e o teste dá **falso negativo**):

```bash
VITE_SELFTEST='C:\caminho\pro\video.mp4' npm run tauri dev
# o veredito sai no stderr: [selftest] APROVADO: quadro decodificado 640x480 …
```

## Atalhos

| tecla | ação |
|---|---|
| Espaço | reproduzir / pausar |
| J / K / L | ré · pausa · frente (repetir J ou L acelera até 8×) |
| ← → | um quadro pra trás / pra frente (Shift = 1 s) |
| S | cortar no playhead |
| Del | remover o clipe selecionado |
| Ctrl+Z / Ctrl+Y | desfazer / refazer |
| Ctrl+I / Ctrl+O / Ctrl+S | importar / abrir projeto / salvar |
| Ctrl+E | exportar |

## Licença

MIT.
