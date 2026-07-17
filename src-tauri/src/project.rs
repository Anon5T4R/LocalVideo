//! `.tvproj` — o projeto do LocalVideo. Rust só move bytes: o formato (JSON) é
//! montado e lido no front (`src/lib/project.ts`, com teste). Aqui não tem
//! `serde` do documento de propósito — assim o formato pode evoluir na v0.2 sem
//! recompilar o Rust, e um projeto de versão futura não vira erro de FFI.

use std::path::Path;

/// Grava o projeto. Escreve num temporário e RENOMEIA por cima: se faltar
/// energia no meio, o usuário perde o save novo, não o projeto que já tinha.
/// (Nunca perder trabalho é requisito, não enfeite.)
#[tauri::command(async)]
pub fn project_save(path: String, json: String) -> Result<(), String> {
    let dest = Path::new(&path);
    let tmp = dest.with_extension("tvproj.tmp");
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| format!("escrever: {}", e))?;
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("finalizar: {}", e)
    })
}

#[tauri::command(async)]
pub fn project_open(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("ler: {}", e))
}

/// Os arquivos de mídia ainda estão onde o projeto diz? Um `.tvproj` guarda
/// CAMINHOS, não vídeo — abrir um projeto cuja mídia foi movida tem que dizer
/// isso na cara, não mostrar timeline vazia fingindo que está tudo bem.
#[tauri::command(async)]
pub fn paths_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| Path::new(p).is_file()).collect()
}
