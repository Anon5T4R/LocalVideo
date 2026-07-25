//! LocalVideo — editor de vídeo (NLE) 100% offline da suíte Local.
//!
//! Faz par com o LocalRecord: Record = ponta de captura, Video = ponta de edição.
//!
//! ONDA 1 (esta): infra do ffmpeg embarcado + importar (sonda e miniaturas) +
//! o modelo da timeline com cortes (que é TS puro, no front) + `.tvproj`.
//! ONDA 2: exportar (`-c copy` via concat demuxer quando os cortes caem em
//! keyframe, `filter_complex` quando não) e o preview quadro a quadro por
//! WebCodecs. Decisão de motor: ffmpeg pra render, WebCodecs pro preview — o
//! MLT foi descartado no spike da fase 0 (volta só se o filter_complex azedar).
//!
//! Divisão de trabalho da suíte (gotcha #7): os ARGUMENTOS de cada job do
//! ffmpeg se montam no front (TS puro, unit-testado); o Rust só resolve o
//! binário e move bytes.

mod ffmpeg;
// `pub` pro `examples/smoke_probe.rs` alcançar o `info_from_probe_json` e
// sondar vídeo de verdade — os testes do cargo são puros de propósito (não
// baixam binário), então a prova empírica mora no example.
pub mod media;
mod project;

use tauri::Manager;

use ffmpeg::FfState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Linux: o webkit2gtk pinta a janela INTEIRA de branco em várias combinações
    // de driver/compositor — o app sobe, o processo vive, e não há erro pra ler.
    // (Visto num Arch com GNOME/Wayland; o LocalAI já tinha pago o mesmo pedágio.)
    // Como o WebView é o mesmo em toda a suíte, este bloco é IDÊNTICO nos 31 apps.
    // Desliga o renderer DMABUF (suspeito nº 1), o compositing (reforço) e, em
    // Wayland, força XWayland — em AppImage o branco costuma sobreviver aos dois
    // primeiros. Custa aceleração no WebView, e branco é pior que lento.
    // Variável já setada MANDA (inclusive `=0`): quem depurou o próprio sistema
    // não pode ser sobrescrito por nós. Tem que vir ANTES do GTK subir — o
    // webkitgtk lê estas variáveis uma vez só, no arranque.
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
        if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
        let on_wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
            || std::env::var("XDG_SESSION_TYPE")
                .map(|t| t.eq_ignore_ascii_case("wayland"))
                .unwrap_or(false);
        if on_wayland && std::env::var_os("GDK_BACKEND").is_none() {
            std::env::set_var("GDK_BACKEND", "x11");
        }
    }

    let mut builder = tauri::Builder::default();

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        // "Abrir vídeo" / "Mostrar na pasta" no fim do export (ver capability).
        .plugin(tauri_plugin_opener::init())
        .manage(FfState::default())
        .setup(|app| {
            // O `assetProtocol.scope` do config nasce VAZIO de propósito (ver o
            // porquê em `media::allow_media`). Quem entra no escopo é só: a nossa
            // pasta de miniaturas (aqui) e cada vídeo que o usuário escolher
            // (`allow_media`, no import/abertura de projeto).
            if let Err(e) = media::allow_thumbs_dir(app.handle()) {
                // Sem isto a régua fica sem miniatura — chato, não fatal. O app
                // sobe e edita do mesmo jeito, então não se derruba a janela.
                eprintln!("miniaturas fora do escopo do asset: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ffmpeg::ffmpeg_ok,
            ffmpeg::ff_cancel,
            ffmpeg::ff_run,
            ffmpeg::font_path,
            ffmpeg::unique_path,
            ffmpeg::write_tmp_text,
            ffmpeg::cleanup_tmp,
            ffmpeg::dev_log,
            media::probe,
            media::probe_keyframes,
            media::thumbs,
            media::audio_peaks,
            media::allow_media,
            media::extract_text,
            project::project_save,
            project::project_open,
            project::paths_exist
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // Nada de ffmpeg órfão sobrando depois que a janela fecha.
                ffmpeg::kill_all(&app.state::<FfState>());
            }
        });
}
