//! Infra do ffmpeg embarcado (binaries/ffmpeg) — peças compartilhadas.
//!
//! Portado do LocalRecord (que herdou do LocalMedia). Onda 1 traz só o que é
//! agnóstico de job: achar o binário, não piscar console no Windows, ler o
//! progresso ESTRUTURADO (`-progress pipe:1`) e o registro de processos vivos
//! (pra cancelar e pra não deixar ffmpeg órfão na saída).
//!
//! A onda 2 (export) é quem vai encher o `FfState`: hoje só a sonda e as
//! miniaturas usam o ffmpeg, e ambas são curtas e bloqueantes. O registro já
//! nasce aqui pra que o export não precise mexer nesta camada.
//!
//! Divisão de trabalho da suíte: os ARGUMENTOS de cada job se montam no front
//! (TS puro, unit-testado); o Rust só resolve o binário e move bytes.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager, State};

/// Processos do ffmpeg vivos, por id (export…).
#[derive(Default)]
pub struct FfState {
    pub jobs: Mutex<HashMap<String, Child>>,
    /// Jobs que o USUÁRIO mandou parar.
    ///
    /// Existe porque, do lado de fora, cancelar e quebrar são a mesma coisa: nos
    /// dois casos o ffmpeg morre com status de erro. Sem esta lista o app diria
    /// "a exportação falhou" pra quem acabou de clicar em "cancelar" — e aí o
    /// usuário fica achando que quebrou alguma coisa.
    pub canceled: Mutex<HashSet<String>>,
}

pub const FFMPEG_BIN: &str = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
pub const FFPROBE_BIN: &str = if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" };

/// Localiza um binário embarcado. Dev: cwd/binaries/ffmpeg. Prod: resource dir.
pub fn resolve_bin(app: &tauri::AppHandle, bin: &str) -> Result<PathBuf, String> {
    let rel = format!("binaries/ffmpeg/{}", bin);
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join(&rel));
    }
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join(&rel));
        candidates.push(res.join(format!("ffmpeg/{}", bin)));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(&rel));
            candidates.push(dir.join(format!("ffmpeg/{}", bin)));
        }
    }
    for c in candidates {
        if c.exists() {
            return Ok(c);
        }
    }
    Err(format!("{} não encontrado (runtime de mídia ausente)", bin))
}

pub fn no_window(cmd: &mut Command) {
    // Não abre janela de console no Windows (CREATE_NO_WINDOW). Sem isso, um
    // console preto pisca a cada chamada — e a régua de miniaturas chama muito.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let _ = cmd; // no Linux não há o que fazer
}

/// O runtime está presente? (a UI avisa se não estiver)
#[tauri::command(async)]
pub fn ffmpeg_ok(app: tauri::AppHandle) -> bool {
    resolve_bin(&app, FFMPEG_BIN).is_ok() && resolve_bin(&app, FFPROBE_BIN).is_ok()
}

/// Interpreta uma linha do `-progress pipe:1`. Atenção histórica do ffmpeg:
/// `out_time_ms` vem em MICROSSEGUNDOS (nome mantido por compatibilidade) —
/// quem consome divide por 1000.
///
/// Quem consome é o laço de progresso do `ff_run`, logo abaixo.
pub fn parse_progress_line(line: &str) -> Option<(&str, String)> {
    let (k, v) = line.split_once('=')?;
    match k.trim() {
        "out_time_ms" | "out_time_us" => Some(("t", v.trim().to_string())),
        "fps" => Some(("fps", v.trim().to_string())),
        "speed" => Some(("speed", v.trim().to_string())),
        "total_size" => Some(("size", v.trim().to_string())),
        "progress" => Some(("progress", v.trim().to_string())),
        _ => None,
    }
}

/// Cancela um job em andamento (mata o ffmpeg dele).
#[tauri::command(async)]
pub fn ff_cancel(state: State<'_, FfState>, job_id: String) {
    // Marca ANTES de matar: se marcasse depois, o `ff_run` podia ver o processo
    // morto e concluir "quebrou" na janelinha entre as duas linhas.
    if let Ok(mut c) = state.canceled.lock() {
        c.insert(job_id.clone());
    }
    if let Ok(mut jobs) = state.jobs.lock() {
        if let Some(child) = jobs.get_mut(&job_id) {
            let _ = child.kill();
        }
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct JobProgress {
    job_id: String,
    /// Já em MILISSEGUNDOS: a conversão do µs do ffmpeg morre aqui, e o front
    /// recebe a unidade que ele usa no resto do app.
    out_time_ms: u64,
    speed: String,
}

/// Roda um job do ffmpeg com progresso estruturado e cancelamento.
///
/// `args` chega PRONTO do front (`src/lib/args.ts`, testado); aqui a gente só
/// injeta o que é sempre igual e move bytes.
///
/// Os erros saem como CÓDIGO curto ("export-failed", "canceled"), nunca como o
/// stderr do ffmpeg: quem fala com o usuário é a UI, no idioma dela. O stderr
/// vai pro console de dev, que é onde ele serve pra alguma coisa.
#[tauri::command(async)]
pub fn ff_run(
    app: tauri::AppHandle,
    state: State<'_, FfState>,
    job_id: String,
    args: Vec<String>,
) -> Result<(), String> {
    let ffmpeg = resolve_bin(&app, FFMPEG_BIN).map_err(|_| "no-runtime".to_string())?;

    // Sai da lista de cancelados: o mesmo id pode ser reusado numa nova tentativa
    // (o export do caminho copy roda vários jobs em sequência).
    if let Ok(mut c) = state.canceled.lock() {
        c.remove(&job_id);
    }

    let mut cmd = Command::new(&ffmpeg);
    cmd.args(["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-loglevel", "error"])
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_window(&mut cmd);

    let mut child = cmd.spawn().map_err(|_| "export-failed".to_string())?;
    let stdout = child.stdout.take().ok_or("export-failed")?;
    let stderr = child.stderr.take().ok_or("export-failed")?;

    // stderr numa thread à parte, num ANEL de 30 linhas.
    //
    // Ler UM pipe só e deixar o outro encher é o jeito clássico de travar: o
    // ffmpeg bloqueia escrevendo num buffer cheio, para de produzir progresso, e
    // o app fica esperando pra sempre uma linha que nunca vem. Os dois pipes têm
    // que ser drenados ao mesmo tempo — daí a thread.
    let err_tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let err_clone = err_tail.clone();
    let err_thread = std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Ok(mut v) = err_clone.lock() {
                v.push(line);
                let len = v.len();
                if len > 30 {
                    v.drain(0..len - 30);
                }
            }
        }
    });

    state.jobs.lock().map_err(|_| "export-failed")?.insert(job_id.clone(), child);

    let mut out_time_ms: u64 = 0;
    let mut speed = String::new();
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        match parse_progress_line(&line) {
            Some(("t", v)) => {
                // µs → ms. O `out_time_ms` do ffmpeg mente no nome: vem em
                // MICROssegundos. Quem esquece mostra uma barra 1000× adiantada.
                out_time_ms = v.parse::<i64>().unwrap_or(0).max(0) as u64 / 1000;
            }
            Some(("speed", v)) => speed = v,
            Some(("progress", _)) => {
                let _ = app.emit(
                    "ffjob-progress",
                    JobProgress { job_id: job_id.clone(), out_time_ms, speed: speed.clone() },
                );
            }
            _ => {}
        }
    }

    let mut child = state
        .jobs
        .lock()
        .map_err(|_| "export-failed")?
        .remove(&job_id)
        .ok_or("export-failed")?;
    let status = child.wait().map_err(|_| "export-failed".to_string())?;
    let _ = err_thread.join();

    let was_canceled = state.canceled.lock().map(|c| c.contains(&job_id)).unwrap_or(false);
    if was_canceled {
        return Err("canceled".into());
    }
    if !status.success() {
        // O stderr vai pro console de DEV, não pra cara do usuário.
        let tail = err_tail.lock().map(|v| v.join("\n")).unwrap_or_default();
        eprintln!("[ff_run {}] ffmpeg falhou: {}", job_id, tail.trim());
        return Err("export-failed".into());
    }
    Ok(())
}

/// Caminho livre: acrescenta " (n)" antes da extensão até não colidir.
/// Nunca sobrescrever calado o vídeo de alguém.
#[tauri::command(async)]
pub fn unique_path(path: String) -> String {
    unique_path_impl(&path, |p| std::path::Path::new(p).exists())
}

fn unique_path_impl(path: &str, exists: impl Fn(&str) -> bool) -> String {
    if !exists(path) {
        return path.to_string();
    }
    let p = std::path::Path::new(path);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("saida");
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
    let dir = p.parent().map(|d| d.to_path_buf()).unwrap_or_default();
    for n in 1..1000 {
        let name = if ext.is_empty() {
            format!("{} ({})", stem, n)
        } else {
            format!("{} ({}).{}", stem, n, ext)
        };
        let candidate = dir.join(name);
        let s = candidate.to_string_lossy().to_string();
        if !exists(&s) {
            return s;
        }
    }
    path.to_string()
}

/// Grava um texto num tmp do app e devolve o caminho (hoje: a lista do concat
/// demuxer). O CONTEÚDO vem pronto do front — inclusive o escape das aspas, que
/// é regra do ffmpeg e por isso mora junto dos outros args, testada
/// (`concatListBody` em `src/lib/args.ts`). Aqui a gente só move bytes.
#[tauri::command(async)]
pub fn write_tmp_text(app: tauri::AppHandle, name: String, body: String) -> Result<String, String> {
    let dir = tmp_dir(&app)?;
    // Sem separador no nome: o que vem do front sempre cai DENTRO da tmp do app.
    let safe: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' { c } else { '_' })
        .collect();
    let path = dir.join(if safe.is_empty() { "tmp.txt".into() } else { safe });
    std::fs::write(&path, body).map_err(|_| "export-failed".to_string())?;
    Ok(path.to_string_lossy().to_string())
}

fn tmp_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "export-failed".to_string())?
        .join("tmp");
    std::fs::create_dir_all(&dir).map_err(|_| "export-failed".to_string())?;
    Ok(dir)
}

/// Apaga os intermediários do export. Best-effort de propósito: falhar em apagar
/// um tmp não pode transformar um export que DEU CERTO em erro na tela.
#[tauri::command(async)]
pub fn cleanup_tmp(paths: Vec<String>) {
    for p in paths {
        let _ = std::fs::remove_file(&p);
    }
}

/// Ponte do autoteste do WebCodecs pro terminal (ver `src/lib/selftest.ts`).
///
/// Existe porque a prova do `VideoDecoder` tem que acontecer DENTRO do app
/// servido — num HTML solto o contexto é `origin: null` e o `VideoDecoder`
/// simplesmente não existe, dando um falso negativo. O veredito precisa então
/// sair da webview e chegar em algum lugar legível sem dirigir a janela na mão:
/// o stderr do `tauri dev`.
///
/// Em release o corpo some (`debug_assertions`) e isto vira um no-op: o
/// autoteste que chama daqui também não existe no bundle de produção, mas um
/// comando que despeja no log o que o front mandar não tem por que ficar
/// funcionando na mão do usuário.
#[tauri::command(async)]
pub fn dev_log(msg: String) {
    #[cfg(debug_assertions)]
    eprintln!("{}", msg);
    #[cfg(not(debug_assertions))]
    let _ = msg;
}

/// Mata qualquer ffmpeg vivo (chamado no `RunEvent::Exit` — não deixar órfão).
pub fn kill_all(state: &FfState) {
    if let Ok(mut jobs) = state.jobs.lock() {
        for (_, child) in jobs.iter_mut() {
            let _ = child.kill();
        }
        jobs.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progresso_estruturado() {
        assert_eq!(
            parse_progress_line("out_time_ms=1500000"),
            Some(("t", "1500000".to_string()))
        );
        assert_eq!(parse_progress_line("out_time_us=250000"), Some(("t", "250000".to_string())));
        assert_eq!(parse_progress_line("speed=2.31x"), Some(("speed", "2.31x".to_string())));
        assert_eq!(parse_progress_line("fps=30.02"), Some(("fps", "30.02".to_string())));
        assert_eq!(parse_progress_line("total_size=4096"), Some(("size", "4096".to_string())));
        assert_eq!(
            parse_progress_line("progress=continue"),
            Some(("progress", "continue".to_string()))
        );
        // Chave que não interessa e linha sem `=` são ignoradas (não explodem).
        assert_eq!(parse_progress_line("frame=123"), None);
        assert_eq!(parse_progress_line("sem igual"), None);
    }

    #[test]
    fn out_time_ms_e_microssegundos() {
        // O gotcha #1 da suíte, cravado em teste: 1.500.000 µs = 1500 ms.
        let (_, v) = parse_progress_line("out_time_ms=1500000").unwrap();
        assert_eq!(v.parse::<i64>().unwrap() / 1000, 1500);
    }

    #[test]
    fn unique_path_nunca_sobrescreve_calado() {
        let taken = ["C:/v/a.mp4", "C:/v/a (1).mp4"];
        let got = unique_path_impl("C:/v/a.mp4", |p| taken.contains(&p.replace('\\', "/").as_str()));
        assert_eq!(got.replace('\\', "/"), "C:/v/a (2).mp4");
        // Caminho livre passa intocado — nada de " (1)" em arquivo novo.
        assert_eq!(unique_path_impl("C:/v/b.mp4", |_| false), "C:/v/b.mp4");
        // Sem extensão o sufixo vai no fim, não no meio de coisa nenhuma.
        assert_eq!(
            unique_path_impl("C:/v/saida", |p| p.replace('\\', "/") == "C:/v/saida").replace('\\', "/"),
            "C:/v/saida (1)"
        );
    }

}
