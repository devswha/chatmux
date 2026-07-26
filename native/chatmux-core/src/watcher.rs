use std::ffi::OsStr;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, TrySendError};
use std::thread;
use std::time::Duration;

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

const READY_FRAME: &[u8] = b"{\"protocolVersion\":1,\"kind\":\"ready\"}\n";
const WATCH_ERROR: &[u8] = b"chatmux-core: watcher failed\n";
const MAX_FRAME_BYTES: usize = 64 * 1024;
const EVENT_CHANNEL_CAPACITY: usize = 256;

// inotify has no kernel-side recursion: every watched directory costs one
// entry in the per-user watch table (fs.inotify.max_user_watches, 65536 by
// default). gjc/omp transcripts live at most three levels below a root
// (<root>/<project>/[<internal>/]<session>.jsonl), so watching directories
// two levels deep observes every transcript event while skipping the tens of
// thousands of cache directories agents dump under the same roots (e.g.
// resident-cache trees), which previously exhausted the watch table for the
// whole user and starved other watchers on the machine.
const MAX_WATCH_DIR_DEPTH: usize = 2;

#[derive(Clone, Copy)]
enum OutputEvent {
    Add,
    Change,
}

impl OutputEvent {
    fn name(self) -> &'static str {
        match self {
            Self::Add => "add",
            Self::Change => "change",
        }
    }
}

/// Runs a parent-owned depth-bounded watcher until stdin reaches EOF.
pub fn run(roots: Vec<PathBuf>) -> bool {
    let (events_tx, events_rx) = mpsc::sync_channel(EVENT_CHANNEL_CAPACITY);
    let failed = Arc::new(AtomicBool::new(false));
    let callback_failed = Arc::clone(&failed);
    let mut watcher = match RecommendedWatcher::new(
        move |result: notify::Result<Event>| match events_tx.try_send(result.map_err(|_| ())) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                callback_failed.store(true, Ordering::Release);
            }
        },
        Config::default(),
    ) {
        Ok(watcher) => watcher,
        Err(_) => return fail(),
    };

    let mut stdout = io::stdout().lock();
    for root in &roots {
        if watcher.watch(root, RecursiveMode::NonRecursive).is_err() {
            return fail();
        }
        // Pre-existing transcripts are indexed by the host's own scans; the
        // initial walk only claims directory watches, without emitting frames.
        if !watch_directory_tree(&mut watcher, &mut stdout, &roots, root, 0, false) {
            return fail();
        }
    }

    if stdout.write_all(READY_FRAME).is_err() || stdout.flush().is_err() {
        return fail();
    }

    let (shutdown_tx, shutdown_rx) = mpsc::sync_channel(1);
    if thread::Builder::new()
        .name("chatmux-core-watch-stdin".into())
        .spawn(move || {
            let _ = shutdown_tx.send(wait_for_stdin_eof());
        })
        .is_err()
    {
        return fail();
    }

    loop {
        if failed.load(Ordering::Acquire) {
            return fail();
        }
        match shutdown_rx.try_recv() {
            Ok(true) => return true,
            Ok(false) => return fail(),
            Err(mpsc::TryRecvError::Disconnected) => return fail(),
            Err(mpsc::TryRecvError::Empty) => {}
        }

        match events_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(event)) => {
                if !watch_created_directories(&mut stdout, &mut watcher, &roots, &event) {
                    return fail();
                }
                if !write_event_frames(&mut stdout, &roots, event) {
                    return fail();
                }
            }
            Ok(Err(())) | Err(RecvTimeoutError::Disconnected) => return fail(),
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

fn wait_for_stdin_eof() -> bool {
    let stdin = io::stdin();
    let mut stdin = stdin.lock();
    let mut buffer = [0_u8; 4096];
    loop {
        match stdin.read(&mut buffer) {
            Ok(0) => return true,
            Ok(_) => {}
            Err(_) => return false,
        }
    }
}

/// Claims one non-recursive watch on `dir` and walks its subdirectories up to
/// `MAX_WATCH_DIR_DEPTH`. With `emit_existing`, transcripts already present
/// are reported as synthetic add frames: a directory created moments before
/// its watch lands may already contain the session file the event was for.
/// Vanished directories are not failures; only stdout write errors are fatal.
fn watch_directory_tree(
    watcher: &mut RecommendedWatcher,
    stdout: &mut impl Write,
    roots: &[PathBuf],
    dir: &Path,
    depth: usize,
    emit_existing: bool,
) -> bool {
    let _ = watcher.watch(dir, RecursiveMode::NonRecursive);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return true;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            if depth + 1 <= MAX_WATCH_DIR_DEPTH
                && !watch_directory_tree(watcher, stdout, roots, &entry.path(), depth + 1, emit_existing)
            {
                return false;
            }
        } else if emit_existing {
            if let Some(frame) = frame_for_path(OutputEvent::Add, &entry.path(), roots) {
                if stdout.write_all(&frame).is_err() || stdout.flush().is_err() {
                    return false;
                }
            }
        }
    }
    true
}

/// Extends the watch set when a directory appears inside a root at an
/// observable depth, whether freshly created or moved in.
fn watch_created_directories(
    stdout: &mut impl Write,
    watcher: &mut RecommendedWatcher,
    roots: &[PathBuf],
    event: &Event,
) -> bool {
    let relevant = matches!(
        event.kind,
        EventKind::Create(_)
            | EventKind::Modify(notify::event::ModifyKind::Name(
                notify::event::RenameMode::Both | notify::event::RenameMode::To
            ))
    );
    if !relevant {
        return true;
    }

    for path in &event.paths {
        let Ok(resolved) = std::fs::canonicalize(path) else {
            continue;
        };
        if !resolved.is_dir() {
            continue;
        }
        let Some(depth) = directory_depth(&resolved, roots) else {
            continue;
        };
        if depth == 0 || depth > MAX_WATCH_DIR_DEPTH {
            continue;
        }
        if !watch_directory_tree(watcher, stdout, roots, &resolved, depth, true) {
            return false;
        }
    }
    true
}

/// Depth of `path` below the closest containing root (the root itself is 0).
fn directory_depth(path: &Path, roots: &[PathBuf]) -> Option<usize> {
    roots
        .iter()
        .filter_map(|root| {
            let relative = path.strip_prefix(root).ok()?;
            if relative
                .components()
                .any(|component| matches!(component, Component::ParentDir))
            {
                return None;
            }
            Some(relative.components().count())
        })
        .min()
}

fn write_event_frames(stdout: &mut impl Write, roots: &[PathBuf], event: Event) -> bool {
    let Some((kind, destination_only)) = output_event(event.kind) else {
        return true;
    };

    let paths: &[PathBuf] = if destination_only {
        event.paths.last().map_or(&[], std::slice::from_ref)
    } else {
        &event.paths
    };
    for path in paths {
        if let Some(frame) = frame_for_path(kind, path, roots) {
            if stdout.write_all(&frame).is_err() || stdout.flush().is_err() {
                return false;
            }
        }
    }
    true
}

fn output_event(kind: EventKind) -> Option<(OutputEvent, bool)> {
    match kind {
        EventKind::Create(_) => Some((OutputEvent::Add, false)),
        EventKind::Modify(notify::event::ModifyKind::Name(notify::event::RenameMode::From)) => None,
        EventKind::Modify(notify::event::ModifyKind::Name(notify::event::RenameMode::Both)) => {
            Some((OutputEvent::Change, true))
        }
        EventKind::Modify(_) => Some((OutputEvent::Change, false)),
        _ => None,
    }
}

fn frame_for_path(kind: OutputEvent, path: &Path, roots: &[PathBuf]) -> Option<Vec<u8>> {
    let resolved = std::fs::canonicalize(path).ok()?;
    frame_for_resolved_path(kind, &resolved, roots)
}

fn frame_for_resolved_path(kind: OutputEvent, path: &Path, roots: &[PathBuf]) -> Option<Vec<u8>> {
    if path.extension() != Some(OsStr::new("jsonl"))
        || !roots.iter().any(|root| is_inside_root(path, root))
    {
        return None;
    }
    let path = path.to_str()?;
    let mut frame = String::with_capacity(path.len() + 64);
    frame.push_str("{\"protocolVersion\":1,\"kind\":\"event\",\"event\":\"");
    frame.push_str(kind.name());
    frame.push_str("\",\"path\":\"");
    push_json_string(&mut frame, path);
    frame.push_str("\"}\n");

    (frame.len() <= MAX_FRAME_BYTES).then_some(frame.into_bytes())
}
fn is_inside_root(path: &Path, root: &Path) -> bool {
    path.strip_prefix(root).is_ok_and(|relative| {
        !relative
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    })
}

fn push_json_string(output: &mut String, value: &str) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\u{08}' => output.push_str("\\b"),
            '\u{0C}' => output.push_str("\\f"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            control if control <= '\u{1F}' => {
                let code = control as usize;
                output.push_str("\\u00");
                output.push(HEX[code >> 4] as char);
                output.push(HEX[code & 0x0f] as char);
            }
            other => output.push(other),
        }
    }
}

fn fail() -> bool {
    let _ = io::stderr().write_all(WATCH_ERROR);
    false
}

#[cfg(test)]
mod tests {
    use super::{OutputEvent, directory_depth, frame_for_path, frame_for_resolved_path};
    use std::fs;
    use std::path::{Path, PathBuf};

    #[test]
    fn directory_depth_is_relative_to_the_closest_containing_root() {
        let roots = vec![PathBuf::from("/a"), PathBuf::from("/a/b")];
        assert_eq!(directory_depth(Path::new("/a"), &roots), Some(0));
        assert_eq!(directory_depth(Path::new("/a/x"), &roots), Some(1));
        assert_eq!(directory_depth(Path::new("/a/b/c"), &roots), Some(1));
        assert_eq!(directory_depth(Path::new("/a/b/c/d/e"), &roots), Some(3));
        assert_eq!(directory_depth(Path::new("/z"), &roots), None);
    }

    #[test]
    fn frames_only_canonical_jsonl_paths_inside_roots() {
        let container = std::env::temp_dir().join(format!(
            "chatmux-core-watch-frame-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let root = container.join("root");
        let transcripts = root.join("transcripts");
        fs::create_dir_all(&transcripts).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let session = transcripts.join("session.jsonl");
        let ignored = transcripts.join("session.txt");
        fs::write(&session, b"{}\n").unwrap();
        fs::write(&ignored, b"ignored").unwrap();

        assert!(frame_for_path(OutputEvent::Add, &session, std::slice::from_ref(&root),).is_some());
        assert_eq!(
            frame_for_path(OutputEvent::Change, &ignored, std::slice::from_ref(&root),),
            None
        );

        let outside = container.join("outside.jsonl");
        fs::write(&outside, b"{}\n").unwrap();
        assert_eq!(
            frame_for_path(OutputEvent::Change, &outside, std::slice::from_ref(&root),),
            None
        );

        #[cfg(unix)]
        {
            let linked = transcripts.join("linked.jsonl");
            std::os::unix::fs::symlink(&outside, &linked).unwrap();
            assert_eq!(
                frame_for_path(OutputEvent::Change, &linked, std::slice::from_ref(&root),),
                None
            );
        }

        fs::remove_dir_all(container).unwrap();
    }

    #[test]
    fn rejects_frames_larger_than_the_protocol_limit() {
        let root = PathBuf::from("/workspace/project");
        let oversized = root.join(format!("{}.jsonl", "a".repeat(64 * 1024)));
        assert_eq!(
            frame_for_resolved_path(OutputEvent::Add, &oversized, &[root]),
            None
        );
    }
}
