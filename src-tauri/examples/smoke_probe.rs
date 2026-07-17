//! Prova empírica da sonda, com ffprobe DE VERDADE.
//!
//! Os testes do cargo são puros de propósito (o CI não baixa 100 MB de ffmpeg
//! por push), então a prova de que o nosso parse casa com o que o ffprobe
//! realmente cospe mora aqui — mesmo padrão do `smoke_record.rs` do LocalRecord.
//!
//! Uso:
//!   cargo run --example smoke_probe -- <ffprobe> <video> [<video>...]

use std::process::{Command, Stdio};

use localvideo_lib::media::info_from_probe_json;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        eprintln!("uso: smoke_probe <ffprobe> <video> [<video>...]");
        std::process::exit(2);
    }
    let ffprobe = &args[0];

    for path in &args[1..] {
        let out = Command::new(ffprobe)
            .args(["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path])
            .stdin(Stdio::null())
            .output()
            .expect("rodar ffprobe");
        assert!(out.status.success(), "ffprobe falhou em {}", path);

        let json = String::from_utf8_lossy(&out.stdout);
        match info_from_probe_json(path, &json) {
            Ok(i) => {
                println!("=== {}", path);
                println!("  duracao_ms   : {}", i.duration_ms);
                println!("  resolucao    : {}x{}", i.width, i.height);
                println!("  frame_rate   : {} (fração crua do ffprobe)", i.frame_rate);
                println!("  avg_frame_rate: {}", i.avg_frame_rate);
                // A mesma conta do `parseFrameRate` do front, só pra mostrar aqui
                // o número que o usuário vê. A implementação de verdade é o TS.
                let fps = i
                    .frame_rate
                    .split_once('/')
                    .map(|(n, d)| n.parse::<f64>().unwrap_or(0.0) / d.parse::<f64>().unwrap_or(1.0))
                    .unwrap_or(0.0);
                println!("  fps convertido: {:.3}", fps);
                println!("  codec_video  : {}", i.video_codec);
                println!("  audio        : {:?} (tem_audio={})", i.audio_codec, i.has_audio);
                println!("  streams      : {}", i.stream_count);
                println!("  bytes        : {}", i.size_bytes);
            }
            Err(e) => println!("=== {}\n  ERRO (código pra UI traduzir): {}", path, e),
        }
    }
}
