//! Importar mídia: sondar o arquivo (ffprobe) e extrair miniaturas pra régua.
//!
//! Regra da casa: o Rust resolve o binário e move bytes. Quem decide **onde**
//! amostrar as miniaturas é o front (`thumbTimes()` em `src/lib/probe.ts`, com
//! teste) — aqui a gente só recebe a lista de instantes e executa. Idem pro fps:
//! devolvemos a fração crua do ffprobe (`30000/1001`) e a conversão é do front.

use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::Manager;

use crate::ffmpeg::{no_window, resolve_bin, FFMPEG_BIN, FFPROBE_BIN};

/// O que a UI precisa saber de um arquivo importado.
///
/// `frameRate`/`avgFrameRate` vão CRUS de propósito: o ffprobe devolve fração
/// (`30000/1001` = 29,97 do NTSC). Converter aqui esconderia o dado real do
/// front, que precisa da fração exata pra grade de quadros do timeline.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub path: String,
    /// Duração do CONTAINER em ms (`format.duration`), que é o que a timeline usa.
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    /// Fração crua do ffprobe, ex.: "30000/1001". Converta com `parseFrameRate`.
    pub frame_rate: String,
    pub avg_frame_rate: String,
    pub video_codec: String,
    /// Codec da PRIMEIRA faixa de áudio. Mantido pra não quebrar quem já lê isto;
    /// a lista completa é `audio_tracks`.
    pub audio_codec: Option<String>,
    pub has_audio: bool,
    /// TODAS as faixas de áudio, em ordem. Uma gravação do LocalRecord com faixas
    /// separadas traz duas aqui (microfone + áudio do sistema) — antes o app via
    /// só a primeira e a segunda sumia na importação sem aviso.
    pub audio_tracks: Vec<AudioStreamInfo>,
    /// Total de streams do container (vídeo + áudio + legenda + dados).
    pub stream_count: usize,
    pub size_bytes: u64,
}

/// Uma faixa de áudio dentro do arquivo.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStreamInfo {
    /// Índice do stream NO ARQUIVO (o `a:N` do ffmpeg), não a posição na lista —
    /// é ele que vai pro `-map`/`filter_complex`, então tem que ser o real.
    pub index: u32,
    pub codec: String,
    pub channels: u32,
    /// O `title` da metadata, quando existe. O LocalRecord grava "Microfone" e
    /// "Áudio do sistema"; é o que deixa o usuário saber qual faixa é qual.
    pub title: Option<String>,
    pub language: Option<String>,
}

fn get_str(v: &serde_json::Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// Número que o ffprobe manda como string ("12.345678") ou como número.
fn get_f64(v: &serde_json::Value, k: &str) -> Option<f64> {
    match v.get(k) {
        Some(serde_json::Value::String(s)) => s.parse::<f64>().ok(),
        Some(serde_json::Value::Number(n)) => n.as_f64(),
        _ => None,
    }
}

/// Traduz o JSON do ffprobe pro nosso `MediaInfo`. Função PURA — é aqui que
/// mora o risco (o formato do ffprobe é cheio de campo opcional), então é ela
/// que os testes do cargo exercitam, sem precisar de ffmpeg de verdade.
///
/// Os erros são CÓDIGOS curtos ("no-video"), não frases: quem fala com o
/// usuário é a UI, no idioma dela. Frase em pt vinda do Rust vazaria pt na tela
/// de um usuário em espanhol — e stderr do ffmpeg, jamais.
pub fn info_from_probe_json(path: &str, json: &str) -> Result<MediaInfo, String> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|_| "bad-json".to_string())?;

    let empty = Vec::new();
    let streams = v.get("streams").and_then(|s| s.as_array()).unwrap_or(&empty);
    let format = v.get("format").cloned().unwrap_or(serde_json::Value::Null);

    let video = streams
        .iter()
        .find(|s| get_str(s, "codec_type") == "video")
        .ok_or_else(|| "no-video".to_string())?;
    let audio = streams.iter().find(|s| get_str(s, "codec_type") == "audio");

    // TODAS as faixas de áudio, com o índice REAL do stream (não a posição na
    // lista de áudios): num arquivo `vídeo, áudio, áudio` o segundo áudio é o
    // stream 2, e é 2 que o ffmpeg quer no `-map`.
    let audio_tracks: Vec<AudioStreamInfo> = streams
        .iter()
        .enumerate()
        .filter(|(_, s)| get_str(s, "codec_type") == "audio")
        .map(|(idx, s)| {
            let tags = s.get("tags");
            let tag = |k: &str| {
                tags.and_then(|t| t.get(k))
                    .and_then(|x| x.as_str())
                    .map(|x| x.to_string())
                    .filter(|x| !x.is_empty())
            };
            AudioStreamInfo {
                index: idx as u32,
                codec: get_str(s, "codec_name"),
                channels: s.get("channels").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
                title: tag("title"),
                language: tag("language"),
            }
        })
        .collect();

    // Duração: o container manda; se faltar (alguns MKV), cai pro stream de vídeo.
    let dur_s = get_f64(&format, "duration")
        .or_else(|| get_f64(video, "duration"))
        .unwrap_or(0.0);

    Ok(MediaInfo {
        path: path.to_string(),
        duration_ms: (dur_s.max(0.0) * 1000.0).round() as u64,
        width: video.get("width").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
        height: video.get("height").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
        frame_rate: get_str(video, "r_frame_rate"),
        avg_frame_rate: get_str(video, "avg_frame_rate"),
        video_codec: get_str(video, "codec_name"),
        audio_codec: audio.map(|a| get_str(a, "codec_name")),
        has_audio: audio.is_some(),
        audio_tracks,
        stream_count: streams.len(),
        size_bytes: get_f64(&format, "size").unwrap_or(0.0).max(0.0) as u64,
    })
}

/// Sonda um arquivo de mídia. Erros voltam como código curto (ver acima).
#[tauri::command(async)]
pub fn probe(app: tauri::AppHandle, path: String) -> Result<MediaInfo, String> {
    let bin = resolve_bin(&app, FFPROBE_BIN).map_err(|_| "no-runtime".to_string())?;
    let mut cmd = Command::new(&bin);
    cmd.args([
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        &path,
    ])
    .stdin(Stdio::null());
    no_window(&mut cmd);

    let out = cmd.output().map_err(|_| "probe-failed".to_string())?;
    if !out.status.success() {
        return Err("probe-failed".into());
    }
    info_from_probe_json(&path, &String::from_utf8_lossy(&out.stdout))
}

/// Os instantes de quadro-chave do arquivo, como CSV cru do ffprobe.
///
/// É a sonda que decide o caminho do export: corte que cai em quadro-chave sai
/// com `-c copy` (instantâneo, sem perda); o resto recodifica. Ver o porquê em
/// `src/lib/args.ts`.
///
/// Devolve o TEXTO CRU e o parse mora no front (`parseKeyframesCsv`, testado
/// contra a saída literal deste binário — o ffprobe cospe `frame,0.000000,`,
/// com vírgula sobrando, no primeiro quadro). Regra da casa: o Rust move bytes.
///
/// Os args vêm do front (`keyframeProbeArgs`) pelo mesmo motivo dos args do
/// ffmpeg: assim eles têm teste. O `-skip_frame nokey` que mora lá é o que faz
/// isto custar um piscar em vez de um play do filme inteiro.
#[tauri::command(async)]
pub fn probe_keyframes(app: tauri::AppHandle, args: Vec<String>) -> Result<String, String> {
    let bin = resolve_bin(&app, FFPROBE_BIN).map_err(|_| "no-runtime".to_string())?;
    let mut cmd = Command::new(&bin);
    cmd.args(&args).stdin(Stdio::null()).stderr(Stdio::null());
    no_window(&mut cmd);

    let out = cmd.output().map_err(|_| "probe-failed".to_string())?;
    if !out.status.success() {
        return Err("probe-failed".into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Libera no escopo do protocolo de asset **exatamente os arquivos que o usuário
/// escolheu** — e nada mais.
///
/// ─── O bloqueador que isto resolve ──────────────────────────────────────────
///
/// O `assetProtocol.scope` do `tauri.conf.json` é ESTÁTICO: uma lista de globs
/// fixada no build. Ele cobria `$HOME/**`, `$VIDEO/**` etc. — ou seja, **vídeo
/// em `D:\` não dava prévia nenhuma**: o protocolo respondia 403, o `<video>`
/// ficava preto e o `fetch()` do demuxer estourava. Um editor que não abre o
/// vídeo do usuário não é produto, e "o vídeo tem que morar no C:" não é
/// resposta que se dê a alguém.
///
/// ─── Por que ASSIM, e não alargando o escopo estático ───────────────────────
///
/// A saída óbvia seria pôr `**` (ou `C:/**`, `D:/**`, …) no `tauri.conf.json`.
/// Isso resolveria — e transformaria o app em "leia meu disco inteiro": QUALQUER
/// coisa rodando no webview passaria a ler qualquer arquivo da máquina via
/// `asset://`, pra sempre, tenha o usuário escolhido aquele arquivo ou não. É
/// escopo largo demais pro problema, e permanente.
///
/// O escopo de runtime é a versão estreita do mesmo poder, e casa com o gesto do
/// usuário: ele escolheu ESTE arquivo no diálogo (ou o arrastou pra janela, ou
/// abriu um `.tvproj` que o cita) → o app pode mostrar ESTE arquivo. Um caminho
/// literal por vez, sem glob de pasta, sem `**`, e **não persistido**: o escopo
/// vive na memória do processo e some quando o app fecha. Na abertura seguinte,
/// só volta o que o projeto reaberto citar. Nada de disco aberto.
///
/// (O `allow_file` do Tauri já cuida do `\\?\` do Windows: o `push_pattern` dele
/// insere o caminho como veio E a forma canonicalizada, que é contra a qual o
/// `is_allowed` compara. Sem isso nada casaria no Windows.)
#[tauri::command]
pub fn allow_media(app: tauri::AppHandle, paths: Vec<String>) {
    let scope = app.asset_protocol_scope();
    for p in paths.iter().take(500) {
        // Um caminho que não entra (glob quebrado) não derruba os outros: o pior
        // caso é a prévia daquele arquivo degradar, e a UI já sabe fazer isso.
        let _ = scope.allow_file(p);
    }
}

/// Só letras/números/-/_ — o `id` vem do front e vira NOME DE PASTA. Sem isto,
/// um caminho com `..` escreveria fora do app_data.
pub fn safe_id(id: &str) -> String {
    let s: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    if s.is_empty() {
        "sem-id".into()
    } else {
        s.chars().take(64).collect()
    }
}

/// Extrai uma miniatura por instante pedido (ms). Devolve os caminhos gerados,
/// na ordem — o front converte com `convertFileSrc` e pendura na régua.
///
/// Quem escolhe os instantes é o front (miolo de cada fatia, nunca as bordas:
/// borda pega tela preta e créditos). Falha de um instante não derruba o resto:
/// régua com buraco é melhor que régua nenhuma.
/// A pasta das miniaturas (cache NOSSO, dentro do app_data).
pub fn thumbs_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| "thumbs-failed".to_string())?
        .join("thumbs"))
}

/// Libera a pasta de miniaturas no escopo do asset — as `<img>` da régua saem
/// daqui. Chamado uma vez, na subida do app.
///
/// Isto é o que sobrou do antigo `$APPDATA/**` do `tauri.conf.json`, e é
/// bem menos: `$APPDATA/**` dava ao webview o app_data de TODOS os apps da
/// máquina (dado de outros programas, incluindo o resto da suíte Local). Aqui é
/// só a nossa própria pasta de cache, que só tem jpg que nós mesmos escrevemos.
pub fn allow_thumbs_dir(app: &tauri::AppHandle) -> Result<(), String> {
    let dir = thumbs_root(app)?;
    // Criar antes de liberar: o `allow_directory` canonicaliza o que existe, e
    // uma pasta que ainda não nasceu entraria no escopo pela forma não
    // canônica — que é justamente a que o `is_allowed` não compara no Windows.
    std::fs::create_dir_all(&dir).map_err(|_| "thumbs-failed".to_string())?;
    app.asset_protocol_scope()
        .allow_directory(&dir, true)
        .map_err(|_| "thumbs-failed".to_string())
}

#[tauri::command(async)]
pub fn thumbs(
    app: tauri::AppHandle,
    id: String,
    path: String,
    times_ms: Vec<u64>,
) -> Result<Vec<String>, String> {
    let ffmpeg = resolve_bin(&app, FFMPEG_BIN).map_err(|_| "no-runtime".to_string())?;
    let dir = thumbs_root(&app)?.join(safe_id(&id));
    std::fs::create_dir_all(&dir).map_err(|_| "thumbs-failed".to_string())?;

    let mut out_paths = Vec::with_capacity(times_ms.len());
    for (i, t_ms) in times_ms.iter().take(400).enumerate() {
        let out = dir.join(format!("{}.jpg", i));
        let mut cmd = Command::new(&ffmpeg);
        cmd.args([
            "-hide_banner",
            "-loglevel",
            "error",
            // `-ss` ANTES do `-i` = seek rápido (pula pelo índice em vez de
            // decodificar desde o começo). Numa régua de 20 miniaturas isso é a
            // diferença entre instantâneo e café.
            "-ss",
            &format!("{}.{:03}", t_ms / 1000, t_ms % 1000),
            "-i",
            &path,
            "-frames:v",
            "1",
            "-vf",
            "scale=160:-2",
            "-q:v",
            "5",
            "-y",
            &out.to_string_lossy(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
        no_window(&mut cmd);
        let status = cmd.status().map_err(|_| "thumbs-failed".to_string())?;
        if status.success() && out.exists() {
            out_paths.push(out.to_string_lossy().to_string());
        }
    }
    if out_paths.is_empty() {
        return Err("thumbs-failed".into());
    }
    Ok(out_paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Retrato real de um `ffprobe -print_format json` (recortado nos campos que
    // usamos), com o NTSC de 29,97 na fração — o caso que engana quem faz parse
    // com `as_f64`.
    const NTSC: &str = r#"{
      "streams": [
        {"codec_type":"video","codec_name":"h264","width":1920,"height":1080,
         "r_frame_rate":"30000/1001","avg_frame_rate":"30000/1001","duration":"10.010000"},
        {"codec_type":"audio","codec_name":"aac","duration":"10.031000"}
      ],
      "format": {"duration":"10.048000","size":"1048576"}
    }"#;

    #[test]
    fn le_o_retrato_do_ffprobe() {
        let i = info_from_probe_json("C:\\v.mp4", NTSC).unwrap();
        assert_eq!(i.duration_ms, 10048);
        assert_eq!((i.width, i.height), (1920, 1080));
        // A fração vai CRUA — quem converte é o front (parseFrameRate, testado lá).
        assert_eq!(i.frame_rate, "30000/1001");
        assert_eq!(i.video_codec, "h264");
        assert_eq!(i.audio_codec.as_deref(), Some("aac"));
        assert!(i.has_audio);
        assert_eq!(i.stream_count, 2);
        assert_eq!(i.size_bytes, 1048576);
    }

    /// Uma gravação do LocalRecord com faixas separadas: vídeo + DOIS áudios
    /// com `title`. Antes o app via só a primeira e a segunda sumia sem aviso.
    const DUAS_FAIXAS: &str = r#"{
      "format": { "duration": "50.0", "size": "2000000" },
      "streams": [
        { "codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080,
          "r_frame_rate": "30/1", "avg_frame_rate": "30/1" },
        { "codec_type": "audio", "codec_name": "aac", "channels": 2,
          "tags": { "title": "Microfone" } },
        { "codec_type": "audio", "codec_name": "aac", "channels": 2,
          "tags": { "title": "Áudio do sistema" } }
      ]
    }"#;

    #[test]
    fn le_todas_as_faixas_de_audio_com_indice_real() {
        let i = info_from_probe_json("C:/v.mp4", DUAS_FAIXAS).unwrap();
        assert_eq!(i.audio_tracks.len(), 2);
        // O índice é o do STREAM no arquivo (vídeo=0), não a posição na lista:
        // o mic é o stream 1 e o áudio do sistema é o 2 — e é isso que vai pro
        // `-map`. Trocar por 0 e 1 mandaria o ffmpeg mapear o vídeo como áudio.
        assert_eq!(i.audio_tracks[0].index, 1);
        assert_eq!(i.audio_tracks[1].index, 2);
        assert_eq!(i.audio_tracks[0].title.as_deref(), Some("Microfone"));
        assert_eq!(i.audio_tracks[1].title.as_deref(), Some("Áudio do sistema"));
        assert_eq!(i.audio_tracks[0].channels, 2);
        // `audio_codec` (o campo antigo) segue apontando pra primeira faixa.
        assert_eq!(i.audio_codec.as_deref(), Some("aac"));
    }

    #[test]
    fn video_mudo_tem_lista_de_audio_vazia() {
        // Sem faixa nenhuma: lista vazia, não um item fantasma.
        let json = r#"{ "format": { "duration": "5" }, "streams": [
          { "codec_type": "video", "codec_name": "h264", "width": 640, "height": 480,
            "r_frame_rate": "30/1", "avg_frame_rate": "30/1" } ] }"#;
        let i = info_from_probe_json("C:/v.mp4", json).unwrap();
        assert!(i.audio_tracks.is_empty());
        assert!(!i.has_audio);
    }

    #[test]
    fn video_mudo_nao_e_erro() {
        let json = r#"{"streams":[{"codec_type":"video","codec_name":"vp9","width":640,
          "height":480,"r_frame_rate":"25/1","avg_frame_rate":"25/1"}],
          "format":{"duration":"4.0","size":"100"}}"#;
        let i = info_from_probe_json("/tmp/v.webm", json).unwrap();
        assert!(!i.has_audio);
        assert_eq!(i.audio_codec, None);
        assert_eq!(i.duration_ms, 4000);
    }

    #[test]
    fn duracao_cai_pro_stream_quando_o_container_nao_diz() {
        // MKV costuma não trazer `format.duration` numérico.
        let json = r#"{"streams":[{"codec_type":"video","codec_name":"h264","width":10,
          "height":10,"r_frame_rate":"30/1","avg_frame_rate":"30/1","duration":"7.5"}],
          "format":{}}"#;
        assert_eq!(info_from_probe_json("a.mkv", json).unwrap().duration_ms, 7500);
    }

    #[test]
    fn erros_sao_codigo_pra_ui_traduzir() {
        // Um MP3 não é material de timeline de vídeo — e o erro sai como CÓDIGO,
        // nunca como frase em pt (que vazaria na tela de quem usa em espanhol).
        let json = r#"{"streams":[{"codec_type":"audio","codec_name":"mp3"}],"format":{}}"#;
        assert_eq!(info_from_probe_json("a.mp3", json).unwrap_err(), "no-video");
        // E JSON quebrado não pode dar panic.
        assert_eq!(info_from_probe_json("x", "{isso não é json").unwrap_err(), "bad-json");
    }

    #[test]
    fn id_de_pasta_nao_escapa_do_app_data() {
        // Cada `.` e cada `/` viram `_`: nada de subir de pasta.
        assert_eq!(safe_id("../../etc/passwd"), "______etc_passwd");
        assert!(!safe_id("..\\..\\Windows").contains('\\'));
        assert_eq!(safe_id("clip-1_a"), "clip-1_a");
        assert_eq!(safe_id(""), "sem-id");
        assert_eq!(safe_id(&"x".repeat(200)).len(), 64);
    }
}
