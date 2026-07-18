import { useSyncExternalStore } from "react";

/** i18n leve da UI (padrão da suíte, ver docs/planos/padrao-apps.md). */

export type Locale = "pt" | "en" | "es";

export const LOCALE_LABELS: Record<Locale, string> = {
  pt: "Português",
  en: "English",
  es: "Español",
};

const LOCALE_KEY = "localvideo.locale";

const pt = {
  "top.tagline": "Editor de vídeo",
  "top.new": "Novo",
  "top.import": "Importar vídeo",
  "top.importing": "Importando…",
  "top.open": "Abrir projeto",
  "top.save": "Salvar",
  "top.saveAs": "Salvar como…",
  "top.undo": "Desfazer",
  "top.redo": "Refazer",
  "top.settingsTitle": "Configurações",
  "top.untitled": "Projeto sem título",
  "top.unsavedMark": "Alterações não salvas",

  "warn.noFfmpeg":
    "Runtime de mídia ausente — sem o ffmpeg o LocalVideo não abre vídeo. Rode scripts/fetch-ffmpeg (o instalador já traz).",
  "warn.missing": "{n} arquivo(s) deste projeto não estão mais onde foram salvos.",
  "warn.missingHint": "O projeto guarda o caminho do vídeo, não uma cópia dele.",

  "empty.title": "Sua timeline está vazia",
  "empty.hint":
    "Arraste um vídeo aqui — ou use o botão abaixo. O arquivo entra inteiro na timeline; cortar é o passo seguinte.",
  "empty.import": "Importar vídeo",
  "empty.tip": "Nada do que você abrir sai desta máquina.",
  "empty.dropNow": "Solte o vídeo pra importar",

  "preview.title": "Prévia",
  "preview.empty": "Importe um vídeo pra ver a prévia aqui.",
  "preview.play": "Reproduzir",
  "preview.pause": "Pausar",
  "preview.gone": "Este arquivo não está mais no lugar.",
  "preview.gap": "Vazio entre clipes",
  "preview.mix": "♪ mixando trilhas",
  "preview.mixHint":
    "A prévia agora toca as trilhas de áudio de fundo junto com a base. Amplificar acima de 100% só vale no export.",
  "preview.exact": "Prévia exata, quadro a quadro.",
  "preview.roughNoCodecs":
    "Prévia aproximada: este sistema não tem o decodificador de quadro a quadro.",
  "preview.roughContainer":
    "Prévia aproximada: o pulo exato quadro a quadro só funciona em MP4/MOV.",

  "exp.title": "Exportar vídeo",
  "exp.probing": "Analisando os quadros-chave dos seus vídeos…",
  "exp.dest": "Salvar em",
  "exp.change": "Alterar…",
  "exp.neverOverwrite": "Se já existir um arquivo com esse nome, o novo entra como “(1)”.",
  "exp.go": "Exportar {dur}",
  "exp.cancel": "Cancelar exportação",
  "exp.canceled": "Exportação cancelada. Nenhum arquivo ficou pela metade.",
  "exp.failed": "Não deu pra exportar. Confira se a pasta existe e tem espaço.",

  "exp.planCopy": "Vai sair na hora, sem recodificar",
  "exp.planEncode": "Vai recodificar",
  "exp.whyCopyExact":
    "Todos os seus cortes caíram em quadro-chave, então dá pra copiar os trechos direto: é quase instantâneo e não perde nada de qualidade.",
  "exp.whyCopySnapped":
    "Encostando os cortes no quadro-chave mais perto (o maior ajuste é de {ms} ms), dá pra copiar direto: quase instantâneo e sem perder qualidade.",
  "exp.whyOffKeyframe":
    "O corte em {at} (em {name}) não cai num quadro-chave — o mais perto está em {near}. Pra cortar exatamente aí, o vídeo precisa ser recodificado.",
  "exp.whyMixed":
    "Seus clipes têm formatos ou tamanhos diferentes. Pra virarem um vídeo só, precisam ser recodificados no mesmo formato.",
  "exp.whyNoKeyframes":
    "Não deu pra ler os quadros-chave de {name}. Sem saber onde eles estão, recodificar é o caminho seguro.",
  "exp.snap": "Encostar os cortes no quadro-chave mais perto",
  "exp.snapHint":
    "Ganha a exportação instantânea, mas move cada corte alguns milissegundos. A prévia não muda.",

  "exp.phase.cutting": "Recortando os trechos…",
  "exp.phase.joining": "Juntando tudo…",
  "exp.phase.encoding": "Recodificando…",
  "exp.eta": "faltam {time}",

  "exp.doneTitle": "Pronto!",
  "exp.doneCopy": "Exportado sem recodificar — os cortes caíram em quadro-chave.",
  "exp.doneEncode": "Recodificado pra cortar exatamente onde você pediu.",
  "exp.doneTime": "Levou {time}.",
  "exp.openFile": "Abrir vídeo",
  "exp.revealFile": "Mostrar na pasta",
  "exp.openFailed": "Não consegui abrir. O arquivo pode ter sido movido.",

  "mk.import": "Importar marcadores…",
  "mk.dlgMarkers": "Marcadores (JSON)",
  "mk.corrupt": "Esse arquivo de marcadores não deu pra ler.",
  "mk.empty": "Esse arquivo não tem nenhum marcador válido.",
  "mk.whichSource":
    "Há mais de um vídeo na timeline e o arquivo não diz a qual deles os marcadores pertencem.",
  "mk.sourceNotHere": "Os marcadores são de {name}, que não está nesta timeline.",
  "mk.noneApplied": "Nenhum marcador virou corte: eles caem fora do que sobrou na timeline.",
  "mk.applied": "{n} corte(s) feito(s) a partir dos marcadores.",
  "mk.appliedSome": "{n} corte(s) feito(s). {skipped} marcador(es) caíram fora da timeline.",

  "tl.title": "Timeline",
  "tl.zoomIn": "Aproximar",
  "tl.zoomOut": "Afastar",
  "tl.zoomFit": "Caber na tela",
  "tl.stats": "{n} clipe(s) · {dur}",
  "tl.split": "Cortar no playhead",
  "tl.remove": "Remover clipe",
  "tl.ripple": "Ripple",
  "tl.rippleOn": "Ripple LIGADO — aparar puxa os clipes seguintes (sem buraco). Clique pra desligar.",
  "tl.rippleOff": "Ripple desligado — aparar deixa buraco. Clique pra ligar (os vizinhos acompanham).",
  "tl.dragHint": "Arraste pra reordenar · arraste as bordas pra aparar",
  "tl.dropHere": "Solte aqui",
  "tl.noThumbs": "sem miniaturas",

  "clip.title": "Clipe selecionado",
  "clip.none": "Nenhum clipe selecionado. Clique num clipe da timeline.",
  "clip.file": "Arquivo",
  "clip.window": "Trecho usado",
  "clip.duration": "Duração",
  "clip.res": "Resolução",
  "clip.fps": "Quadros por segundo",
  "clip.codec": "Codec",
  "clip.audio": "Áudio",
  "clip.noAudio": "sem áudio",
  "clip.streams": "Streams",
  "clip.size": "Tamanho do arquivo",
  "clip.trimIn": "Aparar início aqui",
  "clip.trimOut": "Aparar fim aqui",
  "clip.trimHint": "Apara no playhead (ou arraste a borda do clipe).",
  "clip.reset": "Usar o vídeo inteiro",

  "sc.title": "Atalhos",
  "sc.play": "Reproduzir / pausar",
  "sc.step": "Um quadro pra trás / pra frente",
  "sc.split": "Cortar no playhead",
  "sc.remove": "Remover o clipe selecionado",
  "sc.undo": "Desfazer",
  "sc.redo": "Refazer",
  "sc.spaceKey": "Espaço",
  "sc.arrowsKey": "← →",
  "sc.jkl": "J/K/L — ré, pausa, frente (aperte de novo pra acelerar)",
  "sc.export": "Exportar",
  "sc.addTitle": "Adicionar título no playhead",

  "top.export": "Exportar",

  "preview.multitrack":
    "Prévia da trilha base. A composição completa (trilhas, transições, títulos) aparece na exportação.",

  "exp.doneCompile": "Exportado com a composição da timeline (trilhas, transições, títulos e áudio).",
  "exp.whyMultitrack":
    "Sua timeline usa mais de uma trilha, transição, título ou ajuste de áudio. Isso não é uma cópia simples — o LocalVideo compõe tudo num vídeo só (recodificando).",

  "tl.addVideo": "Nova trilha de vídeo",
  "tl.addAudio": "Nova trilha de áudio",
  "tl.dragHint2":
    "Arraste pra mover (no tempo e entre trilhas) · bordas pra aparar · a alça da emenda faz a transição",

  "title.defaultText": "Título",
  "title.add": "Adicionar título",
  "title.text": "Texto",
  "title.size": "Tamanho",
  "title.color": "Cor",
  "title.position": "Posição",
  "title.top": "Em cima",
  "title.center": "No meio",
  "title.bottom": "Embaixo",
  "title.duration": "Duração (s)",

  "clip.titleClip": "Título selecionado",
  "clip.mute": "Silenciar este clipe",
  "clip.volume": "Volume",
  "clip.fadeIn": "Fade de entrada (s)",
  "clip.fadeOut": "Fade de saída (s)",
  "clip.opacity": "Opacidade",
  "clip.transition": "Arraste pra criar a transição (crossfade) com o próximo",
  "clip.noAudioHint": "Este clipe não tem áudio.",
  "clip.dragHint": "Arraste o clipe pra mover no tempo ou entre trilhas · playhead em {at}",

  "clip.secVideo": "Vídeo",
  "clip.secColor": "Cor",
  "clip.secMotion": "Movimento",
  "clip.speed": "Velocidade",
  "clip.speedHint": "Muda a duração na timeline e reposiciona os clipes seguintes.",
  "clip.crop": "Recorte",
  "clip.cropX": "Esq.",
  "clip.cropY": "Topo",
  "clip.cropW": "Largura",
  "clip.cropH": "Altura",
  "clip.pip": "Picture-in-picture (posição e tamanho)",
  "clip.pipOn": "Encolher e posicionar (PiP)",
  "clip.pipX": "Horizontal",
  "clip.pipY": "Vertical",
  "clip.pipSize": "Tamanho",
  "clip.pipCanvasHint": "Ou arraste a caixa direto na prévia (puxe um canto pra redimensionar).",
  "pip.dragHint": "Arraste pra mover · puxe um canto pra redimensionar",
  "clip.brightness": "Brilho",
  "clip.contrast": "Contraste",
  "clip.saturation": "Saturação",
  "clip.resetFilter": "Restaurar",
  "clip.kfOpacity": "Animar opacidade (keyframes)",
  "clip.kfVolume": "Animar volume (keyframes)",
  "clip.kfHint": "Pontos ao longo do clipe: tempo (%) → valor (%). O export interpola.",
  "clip.kfAdd": "＋ ponto",
  "clip.kfTime": "t",
  "clip.kfValue": "v",

  "preview.approx":
    "Prévia aproximada: o ajuste de cor é uma aproximação; o export é fiel.",
  "preview.wysiwyg": "Prévia da composição (o que você vê é o que exporta).",
  "preview.playApprox":
    "Durante a reprodução a prévia mostra a trilha base; pause pra ver a composição.",

  "exp.presetLabel": "Formato de saída",
  "exp.preset.source": "Original (sem mexer no formato)",
  "exp.preset.youtube1080": "YouTube 1080p",
  "exp.preset.vertical": "Vertical 9:16 (Reels/Shorts)",
  "exp.preset.whatsapp": "WhatsApp (arquivo menor)",
  "exp.preset.quality": "Máxima qualidade (quase sem perda)",
  "exp.presetHint.source": "Mantém resolução, fps e codec do vídeo — pode até sair sem recodificar.",
  "exp.presetHint.youtube1080": "1920×1080, H.264, áudio 192 kbps. O padrão pra YouTube.",
  "exp.presetHint.vertical": "1080×1920 (retrato). O vídeo entra com barra se não for vertical.",
  "exp.presetHint.whatsapp": "Mesma resolução, mais compressão e áudio menor: arquivo mais leve.",
  "exp.presetHint.quality": "Mantém resolução e fps, compressão mínima. Arquivo grande.",
  "exp.whyPreset":
    "Você escolheu “{preset}”. Isso crava resolução/qualidade da saída, então o vídeo é recodificado (não é uma cópia simples).",

  "err.noRuntime": "o runtime de mídia (ffmpeg) não está instalado",
  "err.noVideo": "este arquivo não tem trilha de vídeo",
  "err.probeFailed": "não deu pra abrir este arquivo (formato não suportado ou arquivo danificado)",
  "err.thumbsFailed": "não deu pra gerar as miniaturas",
  "err.generic": "não deu pra abrir este arquivo",
  "err.batchFailed":
    "{n} arquivos não entraram na timeline: {names}. Podem estar danificados ou num formato que o LocalVideo não abre — o resto foi importado.",
  "err.andMore": "{names} e mais {n}",

  "proj.saved": "Projeto salvo em {name}",
  "proj.saveFailed": "Não deu pra salvar o projeto. Confira se a pasta existe e tem espaço.",
  "proj.openFailed": "Não deu pra ler esse arquivo.",
  "proj.corrupt": "Este .tvproj está danificado — não deu pra abrir.",
  "proj.notOurs": "Este arquivo não é um projeto do LocalVideo.",
  "proj.newer": "Este projeto foi salvo numa versão mais nova do LocalVideo.",
  "proj.missingMedia": "{n} arquivo(s) deste projeto não foram encontrados.",
  "proj.dlgVideo": "Vídeo",
  "proj.dlgProject": "Projeto do LocalVideo",

  "unsaved.title": "Salvar as alterações?",
  "unsaved.body": "Você tem cortes que ainda não foram salvos. Se continuar, eles se perdem.",
  "unsaved.save": "Salvar",
  "unsaved.discard": "Descartar",

  "close.dirty": "Você tem alterações não salvas. Fechar mesmo assim? O que não foi salvo se perde.",
  "close.exporting":
    "Uma exportação está em andamento. Fechar agora cancela e descarta o arquivo pela metade.",
  "close.leave": "Fechar",

  "dlg.ok": "OK",
  "dlg.cancel": "Cancelar",

  "settings.title": "Configurações",
  "settings.theme": "Tema",
  "settings.themeSystem": "Sistema",
  "settings.themeLight": "Claro",
  "settings.themeDark": "Escuro",
  "settings.themeNature": "Natureza",
  "settings.themeDarkBlue": "Azul escuro",
  "settings.themeCalmGreen": "Verde calmo",
  "settings.themePastelPink": "Rosa pastel",
  "settings.themePunkPrincess": "PunkPrincess",
  "settings.language": "Idioma",
  "settings.about":
    " — editor de vídeo 100% offline: importe, corte, reordene e exporte. Cortar não mexe no arquivo original, e nada sobe pra lugar nenhum. Faz par com o LocalRecord na suíte Local.",
} as const;

export type MessageKey = keyof typeof pt;

const en: Record<MessageKey, string> = {
  "top.tagline": "Video editor",
  "top.new": "New",
  "top.import": "Import video",
  "top.importing": "Importing…",
  "top.open": "Open project",
  "top.save": "Save",
  "top.saveAs": "Save as…",
  "top.undo": "Undo",
  "top.redo": "Redo",
  "top.settingsTitle": "Settings",
  "top.untitled": "Untitled project",
  "top.unsavedMark": "Unsaved changes",

  "warn.noFfmpeg":
    "Media runtime missing — without ffmpeg, LocalVideo can't open video. Run scripts/fetch-ffmpeg (the installer ships with it).",
  "warn.missing": "{n} file(s) from this project are no longer where they were saved.",
  "warn.missingHint": "A project stores the path to your video, not a copy of it.",

  "empty.title": "Your timeline is empty",
  "empty.hint":
    "Drag a video here — or use the button below. The whole file lands on the timeline; cutting is the next step.",
  "empty.import": "Import video",
  "empty.tip": "Nothing you open ever leaves this machine.",
  "empty.dropNow": "Drop the video to import it",

  "preview.title": "Preview",
  "preview.empty": "Import a video to see the preview here.",
  "preview.play": "Play",
  "preview.pause": "Pause",
  "preview.gone": "This file isn't where it used to be.",
  "preview.gap": "Empty space between clips",
  "preview.mix": "♪ mixing tracks",
  "preview.mixHint":
    "The preview now plays the background audio tracks together with the base. Boosting above 100% only lands in the export.",
  "preview.exact": "Exact preview, frame by frame.",
  "preview.roughNoCodecs": "Approximate preview: this system has no frame-by-frame decoder.",
  "preview.roughContainer":
    "Approximate preview: exact frame-by-frame stepping only works on MP4/MOV.",

  "exp.title": "Export video",
  "exp.probing": "Checking the keyframes in your videos…",
  "exp.dest": "Save to",
  "exp.change": "Change…",
  "exp.neverOverwrite": "If a file with that name already exists, the new one lands as “(1)”.",
  "exp.go": "Export {dur}",
  "exp.cancel": "Cancel export",
  "exp.canceled": "Export canceled. No half-finished file was left behind.",
  "exp.failed": "Couldn't export. Check that the folder exists and has room.",

  "exp.planCopy": "This will be instant — no re-encoding",
  "exp.planEncode": "This will re-encode",
  "exp.whyCopyExact":
    "Every one of your cuts landed on a keyframe, so the parts can be copied straight across: near-instant, with no quality lost.",
  "exp.whyCopySnapped":
    "Nudging your cuts to the nearest keyframe (the biggest shift is {ms} ms) allows copying straight across: near-instant, with no quality lost.",
  "exp.whyOffKeyframe":
    "The cut at {at} (in {name}) doesn't land on a keyframe — the nearest one is at {near}. To cut exactly there, the video has to be re-encoded.",
  "exp.whyMixed":
    "Your clips have different formats or sizes. To become a single video, they have to be re-encoded into one format.",
  "exp.whyNoKeyframes":
    "Couldn't read the keyframes in {name}. Without knowing where they are, re-encoding is the safe route.",
  "exp.snap": "Nudge cuts to the nearest keyframe",
  "exp.snapHint":
    "Buys you the instant export, but moves each cut by a few milliseconds. The preview doesn't change.",

  "exp.phase.cutting": "Cutting the parts…",
  "exp.phase.joining": "Joining it all…",
  "exp.phase.encoding": "Re-encoding…",
  "exp.eta": "{time} left",

  "exp.doneTitle": "Done!",
  "exp.doneCopy": "Exported without re-encoding — your cuts landed on keyframes.",
  "exp.doneEncode": "Re-encoded so the cuts land exactly where you asked.",
  "exp.doneTime": "Took {time}.",
  "exp.openFile": "Open video",
  "exp.revealFile": "Show in folder",
  "exp.openFailed": "Couldn't open it. The file may have been moved.",

  "mk.import": "Import markers…",
  "mk.dlgMarkers": "Markers (JSON)",
  "mk.corrupt": "Couldn't read that markers file.",
  "mk.empty": "That file has no valid markers in it.",
  "mk.whichSource":
    "There's more than one video on the timeline, and the file doesn't say which one the markers belong to.",
  "mk.sourceNotHere": "These markers are from {name}, which isn't on this timeline.",
  "mk.noneApplied": "No marker became a cut: they all fall outside what's left on the timeline.",
  "mk.applied": "{n} cut(s) made from the markers.",
  "mk.appliedSome": "{n} cut(s) made. {skipped} marker(s) fell outside the timeline.",

  "tl.title": "Timeline",
  "tl.zoomIn": "Zoom in",
  "tl.zoomOut": "Zoom out",
  "tl.zoomFit": "Fit to window",
  "tl.stats": "{n} clip(s) · {dur}",
  "tl.split": "Split at the playhead",
  "tl.remove": "Remove clip",
  "tl.ripple": "Ripple",
  "tl.rippleOn": "Ripple ON — trimming pulls the following clips (no gap). Click to turn off.",
  "tl.rippleOff": "Ripple off — trimming leaves a gap. Click to turn on (neighbors follow).",
  "tl.dragHint": "Drag to reorder · drag the edges to trim",
  "tl.dropHere": "Drop here",
  "tl.noThumbs": "no thumbnails",

  "clip.title": "Selected clip",
  "clip.none": "No clip selected. Click a clip on the timeline.",
  "clip.file": "File",
  "clip.window": "Range used",
  "clip.duration": "Duration",
  "clip.res": "Resolution",
  "clip.fps": "Frames per second",
  "clip.codec": "Codec",
  "clip.audio": "Audio",
  "clip.noAudio": "no audio",
  "clip.streams": "Streams",
  "clip.size": "File size",
  "clip.trimIn": "Trim start here",
  "clip.trimOut": "Trim end here",
  "clip.trimHint": "Trims at the playhead (or drag the clip's edge).",
  "clip.reset": "Use the whole video",

  "sc.title": "Shortcuts",
  "sc.play": "Play / pause",
  "sc.step": "One frame back / forward",
  "sc.split": "Split at the playhead",
  "sc.remove": "Remove the selected clip",
  "sc.undo": "Undo",
  "sc.redo": "Redo",
  "sc.spaceKey": "Space",
  "sc.arrowsKey": "← →",
  "sc.jkl": "J/K/L — back, pause, forward (press again to speed up)",
  "sc.export": "Export",
  "sc.addTitle": "Add a title at the playhead",

  "top.export": "Export",

  "preview.multitrack":
    "Preview of the base track. The full composition (tracks, transitions, titles) shows up in the export.",

  "exp.doneCompile": "Exported with the full timeline composition (tracks, transitions, titles and audio).",
  "exp.whyMultitrack":
    "Your timeline uses more than one track, a transition, a title or an audio tweak. That's not a plain copy — LocalVideo composes it all into a single video (re-encoding).",

  "tl.addVideo": "New video track",
  "tl.addAudio": "New audio track",
  "tl.dragHint2":
    "Drag to move (in time and between tracks) · edges to trim · the seam handle makes the transition",

  "title.defaultText": "Title",
  "title.add": "Add title",
  "title.text": "Text",
  "title.size": "Size",
  "title.color": "Color",
  "title.position": "Position",
  "title.top": "Top",
  "title.center": "Center",
  "title.bottom": "Bottom",
  "title.duration": "Duration (s)",

  "clip.titleClip": "Selected title",
  "clip.mute": "Mute this clip",
  "clip.volume": "Volume",
  "clip.fadeIn": "Fade in (s)",
  "clip.fadeOut": "Fade out (s)",
  "clip.opacity": "Opacity",
  "clip.transition": "Drag to create the transition (crossfade) with the next clip",
  "clip.noAudioHint": "This clip has no audio.",
  "clip.dragHint": "Drag the clip to move it in time or between tracks · playhead at {at}",

  "clip.secVideo": "Video",
  "clip.secColor": "Color",
  "clip.secMotion": "Motion",
  "clip.speed": "Speed",
  "clip.speedHint": "Changes the timeline duration and shifts the following clips.",
  "clip.crop": "Crop",
  "clip.cropX": "Left",
  "clip.cropY": "Top",
  "clip.cropW": "Width",
  "clip.cropH": "Height",
  "clip.pip": "Picture-in-picture (position and size)",
  "clip.pipOn": "Shrink and position (PiP)",
  "clip.pipX": "Horizontal",
  "clip.pipY": "Vertical",
  "clip.pipSize": "Size",
  "clip.pipCanvasHint": "Or drag the box right on the preview (pull a corner to resize).",
  "pip.dragHint": "Drag to move · pull a corner to resize",
  "clip.brightness": "Brightness",
  "clip.contrast": "Contrast",
  "clip.saturation": "Saturation",
  "clip.resetFilter": "Reset",
  "clip.kfOpacity": "Animate opacity (keyframes)",
  "clip.kfVolume": "Animate volume (keyframes)",
  "clip.kfHint": "Points along the clip: time (%) → value (%). The export interpolates.",
  "clip.kfAdd": "＋ point",
  "clip.kfTime": "t",
  "clip.kfValue": "v",

  "preview.approx": "Approximate preview: the color tweak is an approximation; the export is faithful.",
  "preview.wysiwyg": "Composition preview (what you see is what you export).",
  "preview.playApprox":
    "During playback the preview shows the base track; pause to see the composition.",

  "exp.presetLabel": "Output format",
  "exp.preset.source": "Original (leave the format alone)",
  "exp.preset.youtube1080": "YouTube 1080p",
  "exp.preset.vertical": "Vertical 9:16 (Reels/Shorts)",
  "exp.preset.whatsapp": "WhatsApp (smaller file)",
  "exp.preset.quality": "Top quality (near-lossless)",
  "exp.presetHint.source": "Keeps the video's resolution, fps and codec — may even export without re-encoding.",
  "exp.presetHint.youtube1080": "1920×1080, H.264, 192 kbps audio. The YouTube default.",
  "exp.presetHint.vertical": "1080×1920 (portrait). Non-vertical video comes in letterboxed.",
  "exp.presetHint.whatsapp": "Same resolution, more compression and smaller audio: a lighter file.",
  "exp.presetHint.quality": "Keeps resolution and fps, minimal compression. Large file.",
  "exp.whyPreset":
    "You picked “{preset}”. That pins the output resolution/quality, so the video is re-encoded (not a plain copy).",

  "err.noRuntime": "the media runtime (ffmpeg) isn't installed",
  "err.noVideo": "this file has no video track",
  "err.probeFailed": "couldn't open this file (unsupported format or damaged file)",
  "err.thumbsFailed": "couldn't build the thumbnails",
  "err.generic": "couldn't open this file",
  "err.batchFailed":
    "{n} files didn't make it into the timeline: {names}. They may be damaged or in a format LocalVideo can't open — the rest were imported.",
  "err.andMore": "{names} and {n} more",

  "proj.saved": "Project saved to {name}",
  "proj.saveFailed": "Couldn't save the project. Check that the folder exists and has room.",
  "proj.openFailed": "Couldn't read that file.",
  "proj.corrupt": "This .tvproj is damaged — couldn't open it.",
  "proj.notOurs": "This file isn't a LocalVideo project.",
  "proj.newer": "This project was saved by a newer version of LocalVideo.",
  "proj.missingMedia": "{n} file(s) from this project couldn't be found.",
  "proj.dlgVideo": "Video",
  "proj.dlgProject": "LocalVideo project",

  "unsaved.title": "Save your changes?",
  "unsaved.body": "You have cuts that haven't been saved yet. If you go on, they're gone.",
  "unsaved.save": "Save",
  "unsaved.discard": "Discard",

  "close.dirty": "You have unsaved changes. Close anyway? Anything unsaved will be lost.",
  "close.exporting":
    "An export is in progress. Closing now cancels it and discards the half-finished file.",
  "close.leave": "Close",

  "dlg.ok": "OK",
  "dlg.cancel": "Cancel",

  "settings.title": "Settings",
  "settings.theme": "Theme",
  "settings.themeSystem": "System",
  "settings.themeLight": "Light",
  "settings.themeDark": "Dark",
  "settings.themeNature": "Nature",
  "settings.themeDarkBlue": "Dark blue",
  "settings.themeCalmGreen": "Calm green",
  "settings.themePastelPink": "Pastel pink",
  "settings.themePunkPrincess": "PunkPrincess",
  "settings.language": "Language",
  "settings.about":
    " — 100% offline video editor: import, cut, reorder and export. Cutting never touches your original file, and nothing is uploaded anywhere. Pairs with LocalRecord in the Local suite.",
};

const es: Record<MessageKey, string> = {
  "top.tagline": "Editor de vídeo",
  "top.new": "Nuevo",
  "top.import": "Importar vídeo",
  "top.importing": "Importando…",
  "top.open": "Abrir proyecto",
  "top.save": "Guardar",
  "top.saveAs": "Guardar como…",
  "top.undo": "Deshacer",
  "top.redo": "Rehacer",
  "top.settingsTitle": "Configuración",
  "top.untitled": "Proyecto sin título",
  "top.unsavedMark": "Cambios sin guardar",

  "warn.noFfmpeg":
    "Falta el runtime de medios — sin ffmpeg, LocalVideo no abre vídeo. Ejecuta scripts/fetch-ffmpeg (el instalador ya lo incluye).",
  "warn.missing": "{n} archivo(s) de este proyecto ya no están donde se guardaron.",
  "warn.missingHint": "El proyecto guarda la ruta del vídeo, no una copia de él.",

  "empty.title": "Tu línea de tiempo está vacía",
  "empty.hint":
    "Arrastra un vídeo aquí — o usa el botón de abajo. El archivo entra entero en la línea de tiempo; cortar es el paso siguiente.",
  "empty.import": "Importar vídeo",
  "empty.tip": "Nada de lo que abras sale de esta máquina.",
  "empty.dropNow": "Suelta el vídeo para importarlo",

  "preview.title": "Vista previa",
  "preview.empty": "Importa un vídeo para ver la vista previa aquí.",
  "preview.play": "Reproducir",
  "preview.pause": "Pausar",
  "preview.gone": "Este archivo ya no está donde estaba.",
  "preview.gap": "Espacio vacío entre clips",
  "preview.mix": "♪ mezclando pistas",
  "preview.mixHint":
    "La vista previa ahora reproduce las pistas de audio de fondo junto con la base. Amplificar por encima del 100% solo se aplica en la exportación.",
  "preview.exact": "Vista previa exacta, fotograma a fotograma.",
  "preview.roughNoCodecs":
    "Vista previa aproximada: este sistema no tiene el decodificador fotograma a fotograma.",
  "preview.roughContainer":
    "Vista previa aproximada: el salto exacto fotograma a fotograma solo funciona en MP4/MOV.",

  "exp.title": "Exportar vídeo",
  "exp.probing": "Analizando los fotogramas clave de tus vídeos…",
  "exp.dest": "Guardar en",
  "exp.change": "Cambiar…",
  "exp.neverOverwrite": "Si ya existe un archivo con ese nombre, el nuevo entra como «(1)».",
  "exp.go": "Exportar {dur}",
  "exp.cancel": "Cancelar exportación",
  "exp.canceled": "Exportación cancelada. No quedó ningún archivo a medias.",
  "exp.failed": "No se pudo exportar. Comprueba que la carpeta existe y tiene espacio.",

  "exp.planCopy": "Saldrá al instante, sin recodificar",
  "exp.planEncode": "Se va a recodificar",
  "exp.whyCopyExact":
    "Todos tus cortes cayeron en un fotograma clave, así que se pueden copiar los fragmentos directamente: casi instantáneo y sin perder calidad.",
  "exp.whyCopySnapped":
    "Ajustando los cortes al fotograma clave más cercano (el mayor ajuste es de {ms} ms) se pueden copiar directamente: casi instantáneo y sin perder calidad.",
  "exp.whyOffKeyframe":
    "El corte en {at} (en {name}) no cae en un fotograma clave — el más cercano está en {near}. Para cortar exactamente ahí, el vídeo tiene que recodificarse.",
  "exp.whyMixed":
    "Tus clips tienen formatos o tamaños distintos. Para convertirse en un solo vídeo, hay que recodificarlos al mismo formato.",
  "exp.whyNoKeyframes":
    "No se pudieron leer los fotogramas clave de {name}. Sin saber dónde están, recodificar es el camino seguro.",
  "exp.snap": "Ajustar los cortes al fotograma clave más cercano",
  "exp.snapHint":
    "Consigue la exportación instantánea, pero mueve cada corte unos milisegundos. La vista previa no cambia.",

  "exp.phase.cutting": "Recortando los fragmentos…",
  "exp.phase.joining": "Uniéndolo todo…",
  "exp.phase.encoding": "Recodificando…",
  "exp.eta": "quedan {time}",

  "exp.doneTitle": "¡Listo!",
  "exp.doneCopy": "Exportado sin recodificar — los cortes cayeron en fotogramas clave.",
  "exp.doneEncode": "Recodificado para cortar exactamente donde lo pediste.",
  "exp.doneTime": "Tardó {time}.",
  "exp.openFile": "Abrir video",
  "exp.revealFile": "Mostrar en la carpeta",
  "exp.openFailed": "No se pudo abrir. Puede que el archivo se haya movido.",

  "mk.import": "Importar marcadores…",
  "mk.dlgMarkers": "Marcadores (JSON)",
  "mk.corrupt": "No se pudo leer ese archivo de marcadores.",
  "mk.empty": "Ese archivo no tiene ningún marcador válido.",
  "mk.whichSource":
    "Hay más de un vídeo en la línea de tiempo y el archivo no dice a cuál pertenecen los marcadores.",
  "mk.sourceNotHere": "Los marcadores son de {name}, que no está en esta línea de tiempo.",
  "mk.noneApplied":
    "Ningún marcador se convirtió en corte: caen fuera de lo que queda en la línea de tiempo.",
  "mk.applied": "{n} corte(s) hecho(s) a partir de los marcadores.",
  "mk.appliedSome":
    "{n} corte(s) hecho(s). {skipped} marcador(es) cayeron fuera de la línea de tiempo.",

  "tl.title": "Línea de tiempo",
  "tl.zoomIn": "Acercar",
  "tl.zoomOut": "Alejar",
  "tl.zoomFit": "Ajustar a la ventana",
  "tl.stats": "{n} clip(s) · {dur}",
  "tl.split": "Cortar en el cabezal",
  "tl.remove": "Quitar clip",
  "tl.ripple": "Ripple",
  "tl.rippleOn": "Ripple ACTIVADO — recortar arrastra los clips siguientes (sin hueco). Clic para desactivar.",
  "tl.rippleOff": "Ripple desactivado — recortar deja hueco. Clic para activar (los vecinos acompañan).",
  "tl.dragHint": "Arrastra para reordenar · arrastra los bordes para recortar",
  "tl.dropHere": "Suelta aquí",
  "tl.noThumbs": "sin miniaturas",

  "clip.title": "Clip seleccionado",
  "clip.none": "Ningún clip seleccionado. Haz clic en un clip de la línea de tiempo.",
  "clip.file": "Archivo",
  "clip.window": "Fragmento usado",
  "clip.duration": "Duración",
  "clip.res": "Resolución",
  "clip.fps": "Fotogramas por segundo",
  "clip.codec": "Códec",
  "clip.audio": "Audio",
  "clip.noAudio": "sin audio",
  "clip.streams": "Streams",
  "clip.size": "Tamaño del archivo",
  "clip.trimIn": "Recortar el inicio aquí",
  "clip.trimOut": "Recortar el final aquí",
  "clip.trimHint": "Recorta en el cabezal (o arrastra el borde del clip).",
  "clip.reset": "Usar el vídeo entero",

  "sc.title": "Atajos",
  "sc.play": "Reproducir / pausar",
  "sc.step": "Un fotograma atrás / adelante",
  "sc.split": "Cortar en el cabezal",
  "sc.remove": "Quitar el clip seleccionado",
  "sc.undo": "Deshacer",
  "sc.redo": "Rehacer",
  "sc.spaceKey": "Espacio",
  "sc.arrowsKey": "← →",
  "sc.jkl": "J/K/L — atrás, pausa, adelante (púlsalo otra vez para acelerar)",
  "sc.export": "Exportar",
  "sc.addTitle": "Añadir un título en el cabezal",

  "top.export": "Exportar",

  "preview.multitrack":
    "Vista previa de la pista base. La composición completa (pistas, transiciones, títulos) aparece en la exportación.",

  "exp.doneCompile": "Exportado con la composición de la línea de tiempo (pistas, transiciones, títulos y audio).",
  "exp.whyMultitrack":
    "Tu línea de tiempo usa más de una pista, una transición, un título o un ajuste de audio. Eso no es una copia simple — LocalVideo lo compone todo en un solo vídeo (recodificando).",

  "tl.addVideo": "Nueva pista de vídeo",
  "tl.addAudio": "Nueva pista de audio",
  "tl.dragHint2":
    "Arrastra para mover (en el tiempo y entre pistas) · los bordes para recortar · el tirador de la unión hace la transición",

  "title.defaultText": "Título",
  "title.add": "Añadir título",
  "title.text": "Texto",
  "title.size": "Tamaño",
  "title.color": "Color",
  "title.position": "Posición",
  "title.top": "Arriba",
  "title.center": "Centro",
  "title.bottom": "Abajo",
  "title.duration": "Duración (s)",

  "clip.titleClip": "Título seleccionado",
  "clip.mute": "Silenciar este clip",
  "clip.volume": "Volumen",
  "clip.fadeIn": "Fundido de entrada (s)",
  "clip.fadeOut": "Fundido de salida (s)",
  "clip.opacity": "Opacidad",
  "clip.transition": "Arrastra para crear la transición (crossfade) con el siguiente clip",
  "clip.noAudioHint": "Este clip no tiene audio.",
  "clip.dragHint": "Arrastra el clip para moverlo en el tiempo o entre pistas · cabezal en {at}",

  "clip.secVideo": "Vídeo",
  "clip.secColor": "Color",
  "clip.secMotion": "Movimiento",
  "clip.speed": "Velocidad",
  "clip.speedHint": "Cambia la duración en la línea de tiempo y reposiciona los clips siguientes.",
  "clip.crop": "Recorte",
  "clip.cropX": "Izq.",
  "clip.cropY": "Arriba",
  "clip.cropW": "Ancho",
  "clip.cropH": "Alto",
  "clip.pip": "Picture-in-picture (posición y tamaño)",
  "clip.pipOn": "Encoger y posicionar (PiP)",
  "clip.pipX": "Horizontal",
  "clip.pipY": "Vertical",
  "clip.pipSize": "Tamaño",
  "clip.pipCanvasHint": "O arrastra la caja directamente en la vista previa (tira de una esquina para redimensionar).",
  "pip.dragHint": "Arrastra para mover · tira de una esquina para redimensionar",
  "clip.brightness": "Brillo",
  "clip.contrast": "Contraste",
  "clip.saturation": "Saturación",
  "clip.resetFilter": "Restablecer",
  "clip.kfOpacity": "Animar opacidad (keyframes)",
  "clip.kfVolume": "Animar volumen (keyframes)",
  "clip.kfHint": "Puntos a lo largo del clip: tiempo (%) → valor (%). La exportación interpola.",
  "clip.kfAdd": "＋ punto",
  "clip.kfTime": "t",
  "clip.kfValue": "v",

  "preview.approx": "Vista previa aproximada: el ajuste de color es una aproximación; la exportación es fiel.",
  "preview.wysiwyg": "Vista previa de la composición (lo que ves es lo que exportas).",
  "preview.playApprox":
    "Durante la reproducción la vista previa muestra la pista base; pausa para ver la composición.",

  "exp.presetLabel": "Formato de salida",
  "exp.preset.source": "Original (sin tocar el formato)",
  "exp.preset.youtube1080": "YouTube 1080p",
  "exp.preset.vertical": "Vertical 9:16 (Reels/Shorts)",
  "exp.preset.whatsapp": "WhatsApp (archivo más pequeño)",
  "exp.preset.quality": "Máxima calidad (casi sin pérdida)",
  "exp.presetHint.source": "Mantiene la resolución, fps y códec del vídeo — puede salir sin recodificar.",
  "exp.presetHint.youtube1080": "1920×1080, H.264, audio 192 kbps. El estándar para YouTube.",
  "exp.presetHint.vertical": "1080×1920 (retrato). El vídeo no vertical entra con barras.",
  "exp.presetHint.whatsapp": "Misma resolución, más compresión y audio menor: un archivo más ligero.",
  "exp.presetHint.quality": "Mantiene resolución y fps, compresión mínima. Archivo grande.",
  "exp.whyPreset":
    "Elegiste «{preset}». Eso fija la resolución/calidad de salida, así que el vídeo se recodifica (no es una copia simple).",

  "err.noRuntime": "el runtime de medios (ffmpeg) no está instalado",
  "err.noVideo": "este archivo no tiene pista de vídeo",
  "err.probeFailed": "no se pudo abrir este archivo (formato no compatible o archivo dañado)",
  "err.thumbsFailed": "no se pudieron generar las miniaturas",
  "err.generic": "no se pudo abrir este archivo",
  "err.batchFailed":
    "{n} archivos no entraron en la línea de tiempo: {names}. Pueden estar dañados o en un formato que LocalVideo no abre — el resto se importó.",
  "err.andMore": "{names} y {n} más",

  "proj.saved": "Proyecto guardado en {name}",
  "proj.saveFailed": "No se pudo guardar el proyecto. Comprueba que la carpeta existe y tiene espacio.",
  "proj.openFailed": "No se pudo leer ese archivo.",
  "proj.corrupt": "Este .tvproj está dañado — no se pudo abrir.",
  "proj.notOurs": "Este archivo no es un proyecto de LocalVideo.",
  "proj.newer": "Este proyecto se guardó con una versión más nueva de LocalVideo.",
  "proj.missingMedia": "No se encontraron {n} archivo(s) de este proyecto.",
  "proj.dlgVideo": "Vídeo",
  "proj.dlgProject": "Proyecto de LocalVideo",

  "unsaved.title": "¿Guardar los cambios?",
  "unsaved.body": "Tienes cortes que aún no se han guardado. Si continúas, se pierden.",
  "unsaved.save": "Guardar",
  "unsaved.discard": "Descartar",

  "close.dirty": "Tienes cambios sin guardar. ¿Cerrar de todas formas? Se perderá lo que no se haya guardado.",
  "close.exporting":
    "Hay una exportación en curso. Cerrar ahora la cancela y descarta el archivo a medias.",
  "close.leave": "Cerrar",

  "dlg.ok": "OK",
  "dlg.cancel": "Cancelar",

  "settings.title": "Configuración",
  "settings.theme": "Tema",
  "settings.themeSystem": "Sistema",
  "settings.themeLight": "Claro",
  "settings.themeDark": "Oscuro",
  "settings.themeNature": "Naturaleza",
  "settings.themeDarkBlue": "Azul oscuro",
  "settings.themeCalmGreen": "Verde tranquilo",
  "settings.themePastelPink": "Rosa pastel",
  "settings.themePunkPrincess": "PunkPrincess",
  "settings.language": "Idioma",
  "settings.about":
    " — editor de vídeo 100% offline: importa, corta, reordena y exporta. Cortar nunca toca el archivo original, y nada se sube a ningún lado. Hace pareja con LocalRecord en la suite Local.",
};

const DICTS: Record<Locale, Record<MessageKey, string>> = { pt, en, es };

export function detectLocale(): Locale {
  const l = (typeof navigator !== "undefined" ? navigator.language : "pt").toLowerCase();
  if (l.startsWith("en")) return "en";
  if (l.startsWith("es")) return "es";
  return "pt";
}

function loadLocale(): Locale {
  const v = typeof localStorage !== "undefined" ? localStorage.getItem(LOCALE_KEY) : null;
  return v === "pt" || v === "en" || v === "es" ? v : detectLocale();
}

let current: Locale = loadLocale();
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale) {
  if (locale === current) return;
  current = locale;
  try {
    localStorage.setItem(LOCALE_KEY, locale);
  } catch {
    /* localStorage indisponível */
  }
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale);
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  let msg: string = DICTS[current][key] ?? pt[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      msg = msg.split(`{${k}}`).join(String(v));
    }
  }
  return msg;
}
