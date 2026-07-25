//! Importar mídia: sondar o arquivo (ffprobe) e extrair miniaturas pra régua.
//!
//! Regra da casa: o Rust resolve o binário e move bytes. Quem decide **onde**
//! amostrar as miniaturas é o front (`thumbTimes()` em `src/lib/probe.ts`, com
//! teste) — aqui a gente só recebe a lista de instantes e executa. Idem pro fps:
//! devolvemos a fração crua do ffprobe (`30000/1001`) e a conversão é do front.

use std::io::Read;
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
    /// Faixas de LEGENDA embutidas no container (srt no MKV, mov_text no MP4).
    /// Antes o app só importava legenda de arquivo externo — a embutida existia
    /// no probe (`stream_count`) e sumia calada. A UI oferece extrair cada uma.
    pub subtitle_tracks: Vec<SubtitleStreamInfo>,
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

/// Uma faixa de legenda dentro do arquivo.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleStreamInfo {
    /// Índice ORDINAL entre as legendas (o `s:N` do `-map 0:s:N`), não o índice
    /// absoluto do stream — a extração mapeia por ordinal, então é ele que serve.
    pub index: u32,
    pub codec: String,
    pub title: Option<String>,
    pub language: Option<String>,
}

fn get_str(v: &serde_json::Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// Uma tag de metadata do stream ("title", "language"), se existir e não for vazia.
fn stream_tag(s: &serde_json::Value, k: &str) -> Option<String> {
    s.get("tags")
        .and_then(|t| t.get(k))
        .and_then(|x| x.as_str())
        .map(|x| x.to_string())
        .filter(|x| !x.is_empty())
}

/// O nome de exibição de uma faixa: `tags.title`, com fallback pro
/// `handler_name` quando ele não é o genérico do muxer.
///
/// O porquê (medido com o ffmpeg embarcado, não suposto): **o muxer MP4 descarta
/// o `title` por stream** — um take do LocalRecord remuxado MKV→MP4 chega aqui
/// sem os nomes "Microfone"/"Áudio do sistema", mesmo que o MKV os tivesse. O
/// jeito que SOBREVIVE no MP4 é o `handler_name` (o handler do QuickTime), que
/// players e o próprio ffprobe devolvem — só que por padrão ele vem preenchido
/// com lixo genérico ("SoundHandler"). Então: title primeiro; handler_name só
/// quando alguém o setou de propósito (não termina em "Handler").
fn stream_title(s: &serde_json::Value) -> Option<String> {
    stream_tag(s, "title")
        .or_else(|| stream_tag(s, "handler_name").filter(|h| !h.ends_with("Handler")))
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

    let audio = streams.iter().find(|s| get_str(s, "codec_type") == "audio");
    // Vídeo é OPCIONAL desde a v0.15 — antes daqui saía `Err("no-video")` e um
    // mp3/wav era rejeitado na porta, com a UI dizendo "não consegui abrir".
    // Isso tornava impossível montar um vídeo a partir de um áudio (foto +
    // música, podcast com capa), embora o compilador de export já soubesse
    // mixar trilha de áudio. Arquivo sem vídeo NEM áudio segue sendo erro: aí
    // não há mídia nenhuma pra colocar na timeline.
    let video = streams.iter().find(|s| get_str(s, "codec_type") == "video");
    if video.is_none() && audio.is_none() {
        return Err("no-video".into());
    }
    // Campos de vídeo num arquivo só-áudio: 0/"" (o front já trata `fps` 0 com o
    // `FALLBACK_FPS`, e largura/altura zeradas não entram no `targetFormat`,
    // que só olha clipe de trilha de VÍDEO).
    let vget = |k: &str| video.and_then(|v| v.get(k)).and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    let vstr = |k: &str| video.map(|v| get_str(v, k)).unwrap_or_default();

    // TODAS as faixas de áudio, com o índice REAL do stream (não a posição na
    // lista de áudios): num arquivo `vídeo, áudio, áudio` o segundo áudio é o
    // stream 2.
    //
    // ATENÇÃO ao ler este campo no front: **`index` NÃO é o que o compilador
    // usa.** O `lib/args.ts` endereça o áudio pela forma ORDINAL (`[0:a:N]`),
    // onde N conta só entre os áudios — as mesmas duas faixas acima são a 0 e a
    // 1, não a 1 e a 2. O `Clip.audioStreamIndex` guarda esse ORDINAL. A UI já
    // misturou os dois espaços uma vez (v0.7.0): o seletor de faixa do inspetor
    // listava as opções por `index`, nenhuma casava com o valor do clipe, e os
    // dois clipes de um take de faixas separadas ficavam indistinguíveis. Quem
    // converte ordinal → faixa é o `audioTrackAt` de `src/lib/probe.ts`.
    let audio_tracks: Vec<AudioStreamInfo> = streams
        .iter()
        .enumerate()
        .filter(|(_, s)| get_str(s, "codec_type") == "audio")
        .map(|(idx, s)| AudioStreamInfo {
            index: idx as u32,
            codec: get_str(s, "codec_name"),
            channels: s.get("channels").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
            title: stream_title(s),
            language: stream_tag(s, "language"),
        })
        .collect();

    // Legendas embutidas, indexadas pelo ORDINAL (`s:N`): é assim que o
    // `-map 0:s:N` da extração as endereça.
    let subtitle_tracks: Vec<SubtitleStreamInfo> = streams
        .iter()
        .filter(|s| get_str(s, "codec_type") == "subtitle")
        .enumerate()
        .map(|(ord, s)| SubtitleStreamInfo {
            index: ord as u32,
            codec: get_str(s, "codec_name"),
            title: stream_title(s),
            language: stream_tag(s, "language"),
        })
        .collect();

    // Duração: o container manda; se faltar (alguns MKV), cai pro stream de
    // vídeo — e, num arquivo só-áudio, pro stream de áudio.
    let dur_s = get_f64(&format, "duration")
        .or_else(|| video.and_then(|v| get_f64(v, "duration")))
        .or_else(|| audio.and_then(|a| get_f64(a, "duration")))
        .unwrap_or(0.0);

    Ok(MediaInfo {
        path: path.to_string(),
        duration_ms: (dur_s.max(0.0) * 1000.0).round() as u64,
        width: vget("width"),
        height: vget("height"),
        frame_rate: vstr("r_frame_rate"),
        avg_frame_rate: vstr("avg_frame_rate"),
        video_codec: vstr("codec_name"),
        audio_codec: audio.map(|a| get_str(a, "codec_name")),
        has_audio: audio.is_some(),
        audio_tracks,
        subtitle_tracks,
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

/// Roda o ffmpeg e devolve o STDOUT como texto — é a extração de legenda
/// embutida (`-map 0:s:N -f srt -`), que sai pelo stdout de propósito: sem
/// arquivo temporário pra criar, escopar e limpar.
///
/// Os args vêm do front (`subtitleExtractArgs` em `src/lib/subtitles.ts`,
/// testado contra o binário real) — regra da casa: o Rust move bytes.
#[tauri::command(async)]
pub fn extract_text(app: tauri::AppHandle, args: Vec<String>) -> Result<String, String> {
    let bin = resolve_bin(&app, FFMPEG_BIN).map_err(|_| "no-runtime".to_string())?;
    let mut cmd = Command::new(&bin);
    cmd.args(["-hide_banner", "-nostdin", "-loglevel", "error"])
        .args(&args)
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    no_window(&mut cmd);

    let out = cmd.output().map_err(|_| "extract-failed".to_string())?;
    if !out.status.success() {
        return Err("extract-failed".into());
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

/// Tamanho do pedaço lido do stdout do ffmpeg, em bytes.
///
/// **É ele que define a memória desta extração** — e é o número que faz a
/// diferença entre isto e a versão ingênua. 1 h de áudio 48 kHz estéreo 16 bits
/// são ~660 MB de PCM cru; carregar isso pra "olhar as amostras" derrubaria o
/// app. Aqui nada disso existe ao mesmo tempo na memória: o ffmpeg já entrega
/// mono downsampleado (ver `audioPeaksArgs`), a gente lê 64 KiB por vez e o que
/// SOBRA é só o vetor de baldes (2000 bytes). Memória constante, arquivo de
/// qualquer tamanho.
const PEAK_CHUNK: usize = 64 * 1024;

/// Teto de baldes: o `buckets` vem do front e vira alocação aqui.
const PEAK_MAX_BUCKETS: usize = 8000;

/// O acumulador de picos: recebe amostra por amostra e guarda só o MÁXIMO de
/// cada balde.
///
/// Separado do processo de propósito — assim os testes do cargo exercitam a
/// conta (que é onde mora o risco de errar por um: balde fora do fim, fluxo mais
/// curto/mais longo que o esperado) sem precisar de ffmpeg de verdade.
struct Peaks {
    /// Pico de cada balde, 0..=255 (o front divide por 255).
    ///
    /// `u8` e não `f32`: a onda vira pixel: 255 níveis já são mais do que a
    /// altura de qualquer clipe na régua, e o JSON que atravessa a ponte fica 4×
    /// menor (2 KB por faixa em vez de 8+).
    buckets: Vec<u8>,
    /// Quantas amostras cabem em cada balde (≥ 1).
    per_bucket: u64,
    /// Índice da amostra atual no fluxo.
    at: u64,
}

impl Peaks {
    /// `expected` é o total de amostras que o probe faz esperar (ver
    /// `expectedSamples` no front). Vale como ESTIMATIVA: um fluxo mais curto
    /// deixa os últimos baldes em zero (silêncio no fim, honesto) e um mais
    /// longo entope o último — nos dois casos a onda continua alinhada ao tempo,
    /// que é o que serve pra achar a fala.
    fn new(buckets: usize, expected: u64) -> Self {
        let n = buckets.clamp(1, PEAK_MAX_BUCKETS);
        Peaks {
            buckets: vec![0u8; n],
            per_bucket: (expected.max(1) as f64 / n as f64).ceil().max(1.0) as u64,
            at: 0,
        }
    }

    fn push(&mut self, sample: i16) {
        let i = (self.at / self.per_bucket) as usize;
        self.at += 1;
        // Passou do último balde (fluxo maior que o esperado): tudo cai no
        // último, em vez de crescer o vetor ou entrar em pânico.
        let i = i.min(self.buckets.len() - 1);
        // `unsigned_abs` e não `abs`: `i16::MIN.abs()` estoura (overflow) — é o
        // caso real de uma amostra no fundo da escala, não uma hipótese.
        // Divide por `i16::MAX` (32767) e não por 32768: com 32768 o pico
        // POSITIVO máximo dá 254 e o negativo dá 255 — a mesma onda mostraria
        // altura diferente conforme o lado em que a amostra bateu. O `.min` é
        // quem segura o único que passa de 255 (o `i16::MIN`).
        let v = (sample.unsigned_abs() as u32 * 255 / 32767).min(255) as u8;
        if v > self.buckets[i] {
            self.buckets[i] = v;
        }
    }

    /// Consome um pedaço de PCM `s16le`. Devolve quantos bytes NÃO foram usados
    /// (0 ou 1: um pedaço pode cortar uma amostra no meio) pra quem chama levar
    /// o byte solto pro pedaço seguinte.
    fn push_bytes(&mut self, buf: &[u8]) -> usize {
        let pairs = buf.len() / 2;
        for p in 0..pairs {
            self.push(i16::from_le_bytes([buf[p * 2], buf[p * 2 + 1]]));
        }
        buf.len() - pairs * 2
    }
}

/// Extrai a forma de onda de UMA faixa de áudio: o ffmpeg decodifica e reduz, o
/// Rust lê o fluxo em pedaços e devolve `buckets` picos (0..=255).
///
/// Os args vêm do front (`audioPeaksArgs` em `src/lib/peaks.ts`, com teste) —
/// regra da casa: o Rust resolve o binário e move bytes.
///
/// O stdout é lido em pedaços de propósito, e não com `output()`: o `output()`
/// junta o fluxo INTEIRO num `Vec<u8>` antes de devolver, que é justamente o
/// pico de memória que esta fatia existe pra não ter. E o stderr vai pro
/// `null` porque a mensagem de erro do ffmpeg não fala com o usuário — quem
/// fala é a UI, no idioma dela (aqui a onda só não aparece, e a régua edita
/// igual).
#[tauri::command(async)]
pub fn audio_peaks(
    app: tauri::AppHandle,
    args: Vec<String>,
    buckets: usize,
    expected_samples: u64,
) -> Result<Vec<u8>, String> {
    let ffmpeg = resolve_bin(&app, FFMPEG_BIN).map_err(|_| "no-runtime".to_string())?;
    peaks_with_bin(&ffmpeg, &args, buckets, expected_samples)
}

/// O miolo do `audio_peaks`, sem o Tauri no caminho — o comando só resolve o
/// binário e delega pra cá.
///
/// Separado pra que a prova EMPÍRICA (tempo, memória e forma da onda contra um
/// arquivo de verdade) possa rodar de fora do app, no
/// `examples/smoke_peaks.rs`: os testes do cargo são puros de propósito (o CI não
/// baixa 100 MB de ffmpeg por push), então quem exercita o binário é o example —
/// mesmo padrão do `smoke_probe.rs`.
pub fn peaks_with_bin(
    ffmpeg: &std::path::Path,
    args: &[String],
    buckets: usize,
    expected_samples: u64,
) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-nostdin", "-loglevel", "error"])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    no_window(&mut cmd);

    let mut child = cmd.spawn().map_err(|_| "peaks-failed".to_string())?;
    let mut out = child.stdout.take().ok_or("peaks-failed")?;

    let mut peaks = Peaks::new(buckets, expected_samples);
    let mut buf = vec![0u8; PEAK_CHUNK];
    // O byte ímpar que sobrou do pedaço anterior. Sem isto, um pedaço que corta
    // uma amostra no meio faria TODAS as amostras seguintes serem lidas com os
    // bytes trocados — a onda viraria ruído, e só às vezes (depende de onde o
    // pipe cortou), que é o tipo de bug que não se reproduz.
    let mut carry: Option<u8> = None;
    loop {
        let n = match out.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        let rest = match carry.take() {
            Some(b) => {
                let mut joined = Vec::with_capacity(n + 1);
                joined.push(b);
                joined.extend_from_slice(&buf[..n]);
                peaks.push_bytes(&joined)
            }
            None => peaks.push_bytes(&buf[..n]),
        };
        if rest == 1 {
            carry = Some(buf[n - 1]);
        }
    }

    // Drenar o pipe ANTES do wait (feito acima, no laço até o EOF) e só então
    // esperar: na ordem inversa o ffmpeg travaria escrevendo num buffer cheio.
    let status = child.wait().map_err(|_| "peaks-failed".to_string())?;
    if !status.success() && peaks.at == 0 {
        return Err("peaks-failed".into());
    }
    // Faixa que existe mas é 100% silêncio devolve tudo zero — e isso é um
    // RESULTADO (a linha reta no meio do clipe diz "não tem sinal aqui", que é
    // informação de verdade pra quem grava em duas faixas), não um erro.
    Ok(peaks.buckets)
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

    /// Um take remuxado pra MP4: o muxer descartou os `title` (comportamento
    /// medido do mov muxer), mas o `handler_name` setado de propósito sobrevive
    /// — e o genérico "SoundHandler" NÃO pode virar nome de faixa na UI.
    const MP4_HANDLER: &str = r#"{
      "format": { "duration": "50.0" },
      "streams": [
        { "codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080,
          "r_frame_rate": "30/1", "avg_frame_rate": "30/1",
          "tags": { "handler_name": "VideoHandler" } },
        { "codec_type": "audio", "codec_name": "aac", "channels": 2,
          "tags": { "handler_name": "Microfone" } },
        { "codec_type": "audio", "codec_name": "aac", "channels": 2,
          "tags": { "handler_name": "SoundHandler" } }
      ]
    }"#;

    #[test]
    fn handler_name_e_fallback_de_titulo_menos_o_generico() {
        let i = info_from_probe_json("C:/take.mp4", MP4_HANDLER).unwrap();
        assert_eq!(i.audio_tracks[0].title.as_deref(), Some("Microfone"));
        // "SoundHandler" é o lixo padrão do muxer, não um nome: fica None e a
        // UI mostra "Faixa 2" em vez de mentir um título.
        assert_eq!(i.audio_tracks[1].title, None);
    }

    /// Legendas embutidas: o índice é o ORDINAL entre legendas (o `s:N` do
    /// `-map`), não o índice absoluto do stream — num arquivo
    /// `vídeo, áudio, legenda, legenda` a segunda legenda é `s:1`, stream 3.
    const COM_LEGENDAS: &str = r#"{
      "format": { "duration": "10.0" },
      "streams": [
        { "codec_type": "video", "codec_name": "h264", "width": 640, "height": 480,
          "r_frame_rate": "30/1", "avg_frame_rate": "30/1" },
        { "codec_type": "audio", "codec_name": "aac", "channels": 2 },
        { "codec_type": "subtitle", "codec_name": "subrip",
          "tags": { "title": "Português", "language": "por" } },
        { "codec_type": "subtitle", "codec_name": "mov_text",
          "tags": { "language": "eng" } }
      ]
    }"#;

    #[test]
    fn le_as_faixas_de_legenda_com_indice_ordinal() {
        let i = info_from_probe_json("C:/v.mkv", COM_LEGENDAS).unwrap();
        assert_eq!(i.subtitle_tracks.len(), 2);
        assert_eq!(i.subtitle_tracks[0].index, 0);
        assert_eq!(i.subtitle_tracks[1].index, 1);
        assert_eq!(i.subtitle_tracks[0].title.as_deref(), Some("Português"));
        assert_eq!(i.subtitle_tracks[0].language.as_deref(), Some("por"));
        assert_eq!(i.subtitle_tracks[1].title, None);
        assert_eq!(i.subtitle_tracks[1].codec, "mov_text");
        // E o resto não muda: 4 streams, 1 áudio.
        assert_eq!(i.stream_count, 4);
        assert_eq!(i.audio_tracks.len(), 1);
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

    /// Arquivo SÓ-ÁUDIO abre (v0.15) — antes o probe devolvia `no-video` e o
    /// mp3 era rejeitado na porta, o que tornava impossível montar um vídeo a
    /// partir de um áudio. O que ele NÃO pode fazer é inventar vídeo: largura,
    /// altura, fps e codec de vídeo saem zerados/vazios, e é disso que o front
    /// depende pra não deixar um mp3 definir a resolução do filme.
    #[test]
    fn arquivo_so_de_audio_abre_sem_inventar_video() {
        let json = r#"{"streams":[{"codec_type":"audio","codec_name":"mp3","channels":2,
          "duration":"183.5"}],"format":{"duration":"183.5","size":"2937600"}}"#;
        let i = info_from_probe_json("a.mp3", json).unwrap();
        assert_eq!(i.duration_ms, 183_500);
        assert_eq!((i.width, i.height), (0, 0));
        assert_eq!(i.frame_rate, "");
        assert_eq!(i.avg_frame_rate, "");
        assert_eq!(i.video_codec, "");
        assert!(i.has_audio);
        assert_eq!(i.audio_codec.as_deref(), Some("mp3"));
        assert_eq!(i.audio_tracks.len(), 1);
    }

    /// Só-áudio SEM `format.duration` (comum em mp3 com VBR mal tageado): a
    /// duração tem que cair pro stream de ÁUDIO. Antes a cascata parava no
    /// stream de vídeo, que aqui não existe — e o clipe nasceria com 0 ms, isto
    /// é, invisível na timeline e sem jeito de aparar.
    #[test]
    fn duracao_de_so_audio_cai_pro_stream_de_audio() {
        let json = r#"{"streams":[{"codec_type":"audio","codec_name":"flac","duration":"12.25"}],
          "format":{}}"#;
        assert_eq!(info_from_probe_json("a.flac", json).unwrap().duration_ms, 12_250);
    }

    #[test]
    fn erros_sao_codigo_pra_ui_traduzir() {
        // Arquivo sem vídeo E sem áudio não é mídia: erro como CÓDIGO, nunca
        // como frase em pt (que vazaria na tela de quem usa em espanhol).
        let json = r#"{"streams":[{"codec_type":"subtitle","codec_name":"srt"}],"format":{}}"#;
        assert_eq!(info_from_probe_json("a.srt", json).unwrap_err(), "no-video");
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

    /// Um pico por balde, e o pico é o MÁXIMO do trecho (nunca a média): é o
    /// requisito visual da onda — uma sílaba curta no meio de um trecho quieto
    /// tem que aparecer, senão a onda não serve pra achar onde a fala começa.
    #[test]
    fn picos_sao_o_maximo_de_cada_balde() {
        let mut p = Peaks::new(4, 8); // 2 amostras por balde
        for s in [100i16, 32767, 0, 0, -32768, 1, 3000, 6000] {
            p.push(s);
        }
        // balde 0: max(100, 32767) → cheio; balde 1: silêncio; balde 2: o -32768
        // (módulo) → cheio; balde 3: max(3000, 6000) → ~18% da altura.
        assert_eq!(p.buckets[0], 255);
        assert_eq!(p.buckets[1], 0);
        assert_eq!(p.buckets[2], 255);
        assert_eq!(p.buckets[3], 46);
        // E o piso de quantização é conhecido: abaixo de ~129 (0,4% da escala) a
        // amostra vira 0. É silêncio audível de qualquer jeito — o que importa é
        // que a onda não tem degrau invisível na faixa que a pessoa enxerga.
        let mut fraco = Peaks::new(1, 1);
        fraco.push(60);
        assert_eq!(fraco.buckets[0], 0);
    }

    /// `i16::MIN.abs()` estoura em Rust — e é uma amostra REAL (o fundo da
    /// escala), não um caso de laboratório. Tem que virar pico cheio, não pânico.
    #[test]
    fn amostra_no_fundo_da_escala_nao_estoura() {
        let mut p = Peaks::new(1, 1);
        p.push(i16::MIN);
        assert_eq!(p.buckets[0], 255);
    }

    /// O fluxo real nunca casa com a estimativa do container: mais curto deixa
    /// zero no fim (silêncio honesto) e mais longo cai todo no último balde —
    /// nenhum dos dois pode crescer o vetor nem sair do índice.
    #[test]
    fn fluxo_mais_curto_ou_mais_longo_que_o_esperado_nao_sai_do_vetor() {
        let mut curto = Peaks::new(4, 100);
        curto.push(32767);
        assert_eq!(curto.buckets.len(), 4);
        assert_eq!(curto.buckets[0], 255);
        assert_eq!(&curto.buckets[1..], &[0, 0, 0]); // o resto é silêncio

        let mut longo = Peaks::new(2, 2); // espera 2 amostras, recebe 10
        for _ in 0..10 {
            longo.push(1000);
        }
        assert_eq!(longo.buckets.len(), 2);
        assert!(longo.buckets[1] > 0);
    }

    /// O pedaço do pipe corta uma amostra no meio: o byte solto tem que
    /// atravessar pro pedaço seguinte. Sem isso todas as amostras dali em diante
    /// saem com os bytes trocados — a onda vira ruído, e só às vezes.
    #[test]
    fn byte_impar_atravessa_o_pedaco() {
        let mut p = Peaks::new(1, 2);
        // 0x0000 e 0x7FFF (32767) em little-endian, partidos em 3 + 1 bytes.
        let rest = p.push_bytes(&[0x00, 0x00, 0xFF]);
        assert_eq!(rest, 1);
        assert_eq!(p.buckets[0], 0); // só a amostra 0 entrou até aqui
        let joined = [0xFFu8, 0x7F];
        assert_eq!(p.push_bytes(&joined), 0);
        assert_eq!(p.buckets[0], 255);
    }

    #[test]
    fn buckets_sao_grampeados() {
        assert_eq!(Peaks::new(0, 10).buckets.len(), 1);
        assert_eq!(Peaks::new(999_999, 10).buckets.len(), PEAK_MAX_BUCKETS);
        // Balde nunca é de zero amostra (divisão por zero no `push`).
        assert!(Peaks::new(100, 0).per_bucket >= 1);
    }
}
