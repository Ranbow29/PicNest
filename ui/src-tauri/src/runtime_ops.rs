use crate::commands::{extract_video_poster, fnv1a_hash, is_video_ext, open_read_conn, AppState};
use serde_json::{json, Value};
use std::path::Path;
use tauri::State;

const EAGLE_UNSUPPORTED: &str =
    "当前版本暂不支持导入 Eagle 库 (.library)，请选择普通图片文件夹";

fn path_is_file(path: &Path) -> Result<bool, String> {
    match std::fs::metadata(path) {
        Ok(metadata) => Ok(metadata.is_file()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("无法读取 Eagle 库结构 {}: {error}", path.display())),
    }
}

fn path_is_dir(path: &Path) -> Result<bool, String> {
    match std::fs::metadata(path) {
        Ok(metadata) => Ok(metadata.is_dir()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("无法读取 Eagle 库结构 {}: {error}", path.display())),
    }
}

fn eagle_inspect_path(path: &Path) -> Result<Value, String> {
    let mut candidate = path.to_path_buf();
    if candidate
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.eq_ignore_ascii_case("images"))
        .unwrap_or(false)
        && candidate
            .parent()
            .map(|parent| path_is_file(&parent.join("metadata.json")))
            .transpose()?
            .unwrap_or(false)
    {
        candidate = candidate
            .parent()
            .unwrap_or(&candidate)
            .to_path_buf();
    }

    let by_suffix = candidate
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("library"))
        .unwrap_or(false);
    let by_structure = path_is_file(&candidate.join("metadata.json"))?
        && path_is_dir(&candidate.join("images"))?;
    if by_suffix || by_structure {
        Ok(json!({ "eagle": true, "ok": false, "error": EAGLE_UNSUPPORTED }))
    } else {
        Ok(json!({ "eagle": false, "ok": true }))
    }
}

#[tauri::command]
pub fn eagle_inspect(path: String) -> Result<Value, String> {
    eagle_inspect_path(Path::new(&path))
}

fn video_preview_at(file_path: &str, thumbs_dir: &Path) -> Value {
    let source = Path::new(file_path);
    if !source.is_file() {
        return json!({ "ok": false, "error": "视频文件不存在" });
    }
    let ext = source
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !is_video_ext(&ext) {
        return json!({ "ok": false, "error": "不是视频文件" });
    }

    let hash = format!("{:x}", fnv1a_hash(file_path.as_bytes()));
    let poster = thumbs_dir.join(format!("{hash}-q80.jpg"));
    if poster
        .metadata()
        .map(|meta| meta.is_file() && meta.len() > 0)
        .unwrap_or(false)
    {
        return json!({
            "ok": true,
            "path": poster.to_string_lossy(),
            "size": poster.metadata().map(|meta| meta.len()).unwrap_or(0)
        });
    }

    if let Err(error) = std::fs::create_dir_all(thumbs_dir) {
        return json!({ "ok": false, "error": format!("创建预览缓存目录失败: {error}") });
    }
    if extract_video_poster(source, &poster) {
        return json!({
            "ok": true,
            "path": poster.to_string_lossy(),
            "size": poster.metadata().map(|meta| meta.len()).unwrap_or(0)
        });
    }
    json!({ "ok": false, "error": "无法提取视频首帧，请确认 ffmpeg 可用且视频可以解码" })
}

#[tauri::command]
pub async fn video_preview(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let thumbs_dir = state.data_dir.join("cache").join("thumbs");
    tauri::async_runtime::spawn_blocking(move || video_preview_at(&file_path, &thumbs_dir))
        .await
        .map_err(|error| error.to_string())
}

fn dir_memory_get_value(
    conn: &rusqlite::Connection,
    key: Option<&str>,
) -> Result<Value, String> {
    let Some(key) = key.filter(|key| !key.trim().is_empty()) else {
        let mut stmt = conn
            .prepare("SELECT root_id, rel, patch FROM picnest_dir_memory ORDER BY root_id, rel")
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        let mut result = serde_json::Map::new();
        for row in rows {
            let (root_id, rel, patch) = row.map_err(|error| error.to_string())?;
            let patch = serde_json::from_str(&patch).map_err(|error| error.to_string())?;
            result.insert(format!("{root_id}|{rel}"), patch);
        }
        return Ok(Value::Object(result));
    };

    let Some((root_id, rel)) = key.split_once('|') else {
        return Ok(Value::Null);
    };
    let Ok(root_id) = root_id.parse::<i64>() else {
        return Ok(Value::Null);
    };
    let patch = match conn.query_row(
        "SELECT patch FROM picnest_dir_memory WHERE root_id = ?1 AND rel = ?2",
        rusqlite::params![root_id, rel],
        |row| row.get::<_, String>(0),
    ) {
        Ok(patch) => patch,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(Value::Null),
        Err(error) => return Err(error.to_string()),
    };
    serde_json::from_str(&patch).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn dir_memory_get(
    key: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_read_conn(&db_path)?;
        dir_memory_get_value(&conn, key.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn is_text_ext(ext: &str) -> bool {
    matches!(
        ext,
        "txt" | "md" | "markdown" | "log" | "json" | "jsonc" | "csv" | "tsv" | "ini" | "cfg"
            | "conf" | "yaml" | "yml"
    )
}

fn count_missing_thumbs(
    conn: &rusqlite::Connection,
    folder_id: i64,
) -> Result<usize, String> {
    let mut stmt = conn
        .prepare(
            "SELECT file_path, thumbnail_path FROM images
             WHERE folder_id = ?1 AND deleted_at IS NULL",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([folder_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|error| error.to_string())?;
    let mut missing = 0usize;
    for row in rows {
        let (file_path, thumbnail_path) = row.map_err(|error| error.to_string())?;
        let source = Path::new(&file_path);
        let ext = source
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if is_text_ext(&ext) || !source.is_file() {
            continue;
        }
        if thumbnail_path
            .as_deref()
            .filter(|path| !path.is_empty() && *path != "SKIP")
            .map(|path| Path::is_file(Path::new(path)))
            .unwrap_or(false)
        {
            continue;
        }
        missing += 1;
    }
    Ok(missing)
}

#[tauri::command]
pub async fn thumbs_missing(
    folder_id: i64,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let db_path = state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_read_conn(&db_path)?;
        let count = count_missing_thumbs(&conn, folder_id)?;
        Ok(json!({ "ok": true, "count": count }))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn eagle_inspect_recognizes_suffix_and_structure() {
        let tmp = TempDir::new("picnest_eagle_inspect");
        let by_suffix = tmp.join("Art.library");
        std::fs::create_dir_all(&by_suffix).unwrap();
        assert_eq!(eagle_inspect_path(&by_suffix).unwrap()["eagle"], json!(true));
        assert_eq!(eagle_inspect_path(&by_suffix).unwrap()["ok"], json!(false));
        assert_eq!(eagle_inspect_path(&by_suffix).unwrap()["error"], json!(EAGLE_UNSUPPORTED));

        let by_structure = tmp.join("structured");
        std::fs::create_dir_all(by_structure.join("images")).unwrap();
        std::fs::write(by_structure.join("metadata.json"), b"{}").unwrap();
        assert_eq!(eagle_inspect_path(&by_structure).unwrap()["eagle"], json!(true));
        assert_eq!(eagle_inspect_path(&by_structure.join("images")).unwrap()["eagle"], json!(true));
    }

    #[test]
    fn eagle_inspect_allows_regular_directories() {
        let tmp = TempDir::new("picnest_eagle_regular");
        assert_eq!(eagle_inspect_path(tmp.path()).unwrap(), json!({ "eagle": false, "ok": true }));
        std::fs::write(tmp.join("metadata.json"), b"{}").unwrap();
        assert_eq!(eagle_inspect_path(tmp.path()).unwrap(), json!({ "eagle": false, "ok": true }));
    }

    #[test]
    fn video_preview_reuses_cached_poster_without_ffmpeg() {
        let tmp = TempDir::new("picnest_video_preview");
        let source = tmp.join("clip.mp4");
        let thumbs = tmp.join("thumbs");
        std::fs::write(&source, b"synthetic video").unwrap();
        std::fs::create_dir_all(&thumbs).unwrap();
        let hash = format!("{:x}", fnv1a_hash(source.to_string_lossy().as_bytes()));
        let poster = thumbs.join(format!("{hash}-q80.jpg"));
        std::fs::write(&poster, b"cached poster").unwrap();
        let result = video_preview_at(source.to_string_lossy().as_ref(), &thumbs);
        assert_eq!(result["ok"], json!(true));
        assert_eq!(result["path"], json!(poster.to_string_lossy()));
        assert_eq!(result["size"], json!(13));
    }

    #[test]
    fn video_preview_rejects_missing_and_non_video_files() {
        let tmp = TempDir::new("picnest_video_preview_invalid");
        let thumbs = tmp.join("thumbs");
        assert_eq!(video_preview_at("missing.mp4", &thumbs)["ok"], json!(false));
        let image = tmp.join("image.png");
        std::fs::write(&image, b"not a video").unwrap();
        assert_eq!(video_preview_at(image.to_string_lossy().as_ref(), &thumbs)["ok"], json!(false));
    }

    #[test]
    fn dir_memory_get_supports_composite_keys_and_full_map() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE picnest_dir_memory (root_id INTEGER, rel TEXT, patch TEXT, PRIMARY KEY(root_id, rel));
             INSERT INTO picnest_dir_memory VALUES (7, '', '{\"sort\":\"name\"}');
             INSERT INTO picnest_dir_memory VALUES (7, 'sub', '{\"expanded\":true}');",
        )
        .unwrap();
        assert_eq!(
            dir_memory_get_value(&conn, Some("7|sub")).unwrap(),
            json!({ "expanded": true })
        );
        assert_eq!(dir_memory_get_value(&conn, Some("7|missing")).unwrap(), Value::Null);
        assert_eq!(dir_memory_get_value(&conn, Some("invalid")).unwrap(), Value::Null);
        assert_eq!(
            dir_memory_get_value(&conn, None).unwrap(),
            json!({
                "7|": { "sort": "name" },
                "7|sub": { "expanded": true }
            })
        );
    }

    #[test]
    fn thumbs_missing_counts_only_live_non_text_files_without_usable_cache() {
        let tmp = TempDir::new("picnest_thumbs_missing");
        let root = tmp.join("library");
        std::fs::create_dir_all(&root).unwrap();
        let missing = root.join("missing.png");
        let cached = root.join("cached.png");
        let stale = root.join("stale.png");
        let text = root.join("notes.txt");
        let absent = root.join("absent.png");
        for path in [&missing, &cached, &stale, &text] {
            std::fs::write(path, b"x").unwrap();
        }
        let cached_thumb = tmp.join("cached.jpg");
        std::fs::write(&cached_thumb, b"thumb").unwrap();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE images (folder_id INTEGER, file_path TEXT, thumbnail_path TEXT, deleted_at INTEGER);",
        )
        .unwrap();
        for (path, thumb, deleted) in [
            (missing.to_string_lossy().to_string(), None, None),
            (cached.to_string_lossy().to_string(), Some(cached_thumb.to_string_lossy().to_string()), None),
            (stale.to_string_lossy().to_string(), Some(tmp.join("lost.jpg").to_string_lossy().to_string()), None),
            (text.to_string_lossy().to_string(), None, None),
            (absent.to_string_lossy().to_string(), None, None),
            (missing.to_string_lossy().to_string(), None, Some(1)),
        ] {
            conn.execute(
                "INSERT INTO images (folder_id, file_path, thumbnail_path, deleted_at) VALUES (1, ?1, ?2, ?3)",
                rusqlite::params![path, thumb, deleted],
            )
            .unwrap();
        }
        assert_eq!(count_missing_thumbs(&conn, 1).unwrap(), 2);
        assert_eq!(count_missing_thumbs(&conn, 99).unwrap(), 0);
    }
}
