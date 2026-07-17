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

  "top.export": "Exportar",

  "err.noRuntime": "o runtime de mídia (ffmpeg) não está instalado",
  "err.noVideo": "este arquivo não tem trilha de vídeo",
  "err.probeFailed": "não deu pra abrir este arquivo (formato não suportado ou arquivo danificado)",
  "err.thumbsFailed": "não deu pra gerar as miniaturas",
  "err.generic": "não deu pra abrir este arquivo",

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

  "top.export": "Export",

  "err.noRuntime": "the media runtime (ffmpeg) isn't installed",
  "err.noVideo": "this file has no video track",
  "err.probeFailed": "couldn't open this file (unsupported format or damaged file)",
  "err.thumbsFailed": "couldn't build the thumbnails",
  "err.generic": "couldn't open this file",

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

  "top.export": "Exportar",

  "err.noRuntime": "el runtime de medios (ffmpeg) no está instalado",
  "err.noVideo": "este archivo no tiene pista de vídeo",
  "err.probeFailed": "no se pudo abrir este archivo (formato no compatible o archivo dañado)",
  "err.thumbsFailed": "no se pudieron generar las miniaturas",
  "err.generic": "no se pudo abrir este archivo",

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
