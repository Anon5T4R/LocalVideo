//! Prova empírica da forma de onda, com ffmpeg DE VERDADE.
//!
//! Os testes do cargo exercitam a CONTA dos baldes (puros, sem binário); o que
//! só um arquivo real prova é o resto: quanto tempo a extração leva, quanta
//! memória ela segura, e se a onda que sai tem a cara do áudio que entrou.
//! Mesmo padrão do `smoke_probe.rs`.
//!
//! O número que mais importa aqui é a MEMÓRIA: a versão ingênua desta fatia
//! (decodificar o PCM e olhar as amostras) custaria ~660 MB numa gravação de 1 h.
//! Este example imprime o pico de memória do processo pra mostrar que a versão
//! que ficou não cresce com a duração do arquivo.
//!
//! Uso:
//!   cargo run --example smoke_peaks -- <ffmpeg> <video> [ordinal]

use std::time::Instant;

use localvideo_lib::media::peaks_with_bin;

/// Espelha o `audioPeaksArgs` de `src/lib/peaks.ts` (a implementação de verdade
/// é o TS, testada lá — aqui é só pra o example poder rodar sozinho).
fn args_for(path: &str, ordinal: u32, rate: u32) -> Vec<String> {
    [
        "-i", path,
        "-map", &format!("0:a:{}", ordinal),
        "-vn",
        "-ac", "1",
        "-filter:a", &format!("aresample={}", rate),
        "-f", "s16le",
        "-acodec", "pcm_s16le",
        "-",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Pico de memória do processo (Windows), em MiB. Em outros sistemas devolve
/// `None` — o número serve pra provar o ponto na máquina do desenvolvedor, não
/// pra virar asserção de CI.
#[cfg(windows)]
fn peak_mem_mib() -> Option<f64> {
    // Sem dependência nova: o `tasklist` do próprio Windows sabe responder.
    let pid = std::process::id();
    let out = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"])
        .output()
        .ok()?;
    let line = String::from_utf8_lossy(&out.stdout).to_string();
    // "nome","pid","sessão","nº","12.345 K"
    let mem = line.rsplit(',').next()?.trim().trim_matches('"').to_string();
    let digits: String = mem.chars().filter(|c| c.is_ascii_digit()).collect();
    digits.parse::<f64>().ok().map(|kb| kb / 1024.0)
}

#[cfg(not(windows))]
fn peak_mem_mib() -> Option<f64> {
    None
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        eprintln!("uso: smoke_peaks <ffmpeg> <video> [ordinal]");
        std::process::exit(2);
    }
    let ffmpeg = std::path::PathBuf::from(&args[0]);
    let path = &args[1];
    let ordinal: u32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);

    const BUCKETS: usize = 2000;
    const RATE: u32 = 8000;

    let antes = peak_mem_mib();
    let t0 = Instant::now();
    let peaks = peaks_with_bin(&ffmpeg, &args_for(path, ordinal, RATE), BUCKETS, u64::MAX)
        .expect("extrair picos");
    let dt = t0.elapsed();
    let depois = peak_mem_mib();

    // NOTA: passar `u64::MAX` como `expected_samples` faria TUDO cair no balde 0
    // (o balde é `amostra / per_bucket`). Pra o example ser útil sem repetir a
    // sonda, roda-se de novo com o total REAL de amostras, agora conhecido.
    let _ = peaks;
    let total_amostras = contar_amostras(&ffmpeg, path, ordinal, RATE);
    let t1 = Instant::now();
    let peaks = peaks_with_bin(&ffmpeg, &args_for(path, ordinal, RATE), BUCKETS, total_amostras)
        .expect("extrair picos");
    let dt2 = t1.elapsed();

    let cheios = peaks.iter().filter(|v| **v > 0).count();
    let maximo = peaks.iter().copied().max().unwrap_or(0);
    let media = peaks.iter().map(|v| *v as u32).sum::<u32>() as f64 / peaks.len() as f64;

    println!("=== {} (faixa a:{})", path, ordinal);
    println!("  baldes          : {}", peaks.len());
    println!("  amostras (8 kHz): {} (~{:.1} s de áudio)", total_amostras, total_amostras as f64 / RATE as f64);
    println!("  tempo 1ª passada: {:.2} s", dt.as_secs_f64());
    println!("  tempo 2ª passada: {:.2} s", dt2.as_secs_f64());
    println!("  baldes com sinal: {} de {}", cheios, peaks.len());
    println!("  pico máximo     : {}/255", maximo);
    println!("  pico médio      : {:.1}/255", media);
    if let (Some(a), Some(b)) = (antes, depois) {
        println!("  memória         : {:.1} MiB → {:.1} MiB (o PCM NUNCA entra aqui)", a, b);
    }
    // Um desenho tosco da onda no terminal: é o que deixa olhar pra saída e ver
    // que o silêncio está onde tem silêncio.
    let cols = 72;
    let mut linha = String::new();
    for k in 0..cols {
        let i0 = k * peaks.len() / cols;
        let i1 = ((k + 1) * peaks.len() / cols).max(i0 + 1).min(peaks.len());
        let m = peaks[i0..i1].iter().copied().max().unwrap_or(0);
        linha.push(match m {
            0 => '_',
            1..=63 => '.',
            64..=127 => '-',
            128..=191 => '=',
            _ => '#',
        });
    }
    println!("  onda            : {}", linha);
}

/// Quantas amostras a faixa tem de verdade, na taxa de pico: roda o mesmo
/// pipeline e conta os bytes. Só o example precisa disso — no app o número vem
/// da duração que o probe já leu, de graça.
fn contar_amostras(ffmpeg: &std::path::Path, path: &str, ordinal: u32, rate: u32) -> u64 {
    use std::io::Read;
    let mut child = std::process::Command::new(ffmpeg)
        .args(["-hide_banner", "-nostdin", "-loglevel", "error"])
        .args(args_for(path, ordinal, rate))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("rodar ffmpeg");
    let mut out = child.stdout.take().unwrap();
    let mut buf = vec![0u8; 64 * 1024];
    let mut bytes: u64 = 0;
    while let Ok(n) = out.read(&mut buf) {
        if n == 0 {
            break;
        }
        bytes += n as u64;
    }
    let _ = child.wait();
    bytes / 2
}
