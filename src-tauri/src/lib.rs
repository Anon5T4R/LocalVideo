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
    // ── Contorno da tela branca do webkit: REMOVIDO, e o porquê importa ──────
    //
    // Este bloco desligava o renderer DMABUF, desligava o compositing e forçava
    // XWayland, porque o webkit2gtk pintava a janela inteira de branco em
    // Arch/GNOME. Era mitigação às cegas — o comentário dizia "branco é pior que
    // lento" — e custava a aceleração do WebView.
    //
    // A CAUSA foi encontrada em 26/07/2026 e é de EMPACOTAMENTO, não de código:
    // o AppDir do AppImage levava `libwayland-*` do Ubuntu do CI, que brigavam
    // com o Mesa do host e derrubavam o EGL (`EGL_BAD_PARAMETER`). Corrigido em
    // `Anon5T4R/linux-packaging`: as libs que falam com driver/compositor agora
    // vêm do host, e o pacote nativo (pacman/apt) usa o webkit do sistema.
    // Tratar o sintoma deixou de fazer sentido.
    //
    // Remover o forçamento NÃO tira a saída de emergência: estas variáveis são
    // lidas pelo próprio webkitgtk, não por este código. Se a tela branca voltar
    // em alguma combinação de driver, rodar com
    // `WEBKIT_DISABLE_DMABUF_RENDERER=1` continua funcionando — e aí é sinal de
    // que sobrou lib de host em algum AppDir, que é onde se deve olhar.

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
        // Titlebar limpa no GNOME/Wayland (tao <= 0.35) — ver lib.rs do LocalImage.
        #[cfg(target_os = "linux")]
        if let Some(w) = app.get_webview_window("main") {
            instalar_csd_limpa(&w);
        }
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

/// Contorna a titlebar quebrada do tao <= 0.35 no GNOME/Wayland (CSD propia
/// com regiao de input morta — causa e fix em tao#1218, so via tauri 2.12):
/// troca por uma HeaderBar comum com layout forcado min/max/fechar, ANTES do
/// primeiro map. Sai junto com o upgrade ao tao 0.36 (wry 0.56).
#[cfg(target_os = "linux")]
fn instalar_csd_limpa(w: &tauri::WebviewWindow) {
    use gtk::prelude::*;
    let Ok(gw) = w.gtk_window() else { return };
    let header = gtk::HeaderBar::new();
    header.set_show_close_button(true);
    header.set_decoration_layout(Some("menu:minimize,maximize,close"));
    header.set_title(Some("LocalVideo"));
    header.show();
    gw.set_titlebar(Some(&header));
}
