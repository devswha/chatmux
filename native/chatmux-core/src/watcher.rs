use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::Duration;

use notify::event::{ModifyKind, RenameMode};
use notify::{Config, ErrorKind, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

const READY_FRAME: &[u8] = b"{\"protocolVersion\":1,\"kind\":\"ready\"}\n";
const RESYNC_FRAME: &[u8] = b"{\"protocolVersion\":1,\"kind\":\"resync\"}\n";
const WATCH_ERROR: &[u8] = b"chatmux-core: watcher failed\n";
const MAX_FRAME_BYTES: usize = 64 * 1024;
// Distinct paths the drain loop may fall behind by before the queue stops
// remembering individual events. Past this the host is asked to rescan instead
// of the watcher dying: a burst (a bulk checkout, a cache purge under a root)
// is a gap to reconcile, not a reason to restart and lose live tracking.
const MAX_PENDING_PATHS: usize = 4096;
const DRAIN_IDLE_WAIT: Duration = Duration::from_millis(100);

// inotify has no kernel-side recursion: every watched directory costs one
// entry in the per-user watch table (fs.inotify.max_user_watches, 65536 by
// default). gjc/omp transcripts live at most three levels below a root
// (<root>/<project>/[<internal>/]<session>.jsonl), so watching directories
// two levels deep observes every transcript event while skipping the tens of
// thousands of cache directories agents dump under the same roots (e.g.
// resident-cache trees), which previously exhausted the watch table for the
// whole user and starved other watchers on the machine.
const MAX_WATCH_DIR_DEPTH: usize = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct PendingPath {
    /// Latest event kind to report for the path; none when only the watch set
    /// may need extending.
    output: Option<OutputEvent>,
    /// The path may be a directory that appeared at an observable depth.
    may_be_directory: bool,
}

/// Path-keyed coalescing queue between the notify callback and the drain loop.
/// The callback only records; every blocking filesystem call (canonicalize,
/// read_dir, watch installation) happens on the drain side, so a slow drain
/// can never stall the notify thread or lose events to a full channel.
#[derive(Debug, Default)]
struct PendingEvents {
    order: Vec<PathBuf>,
    paths: HashMap<PathBuf, PendingPath>,
    /// More than `MAX_PENDING_PATHS` distinct paths were pending: the backlog
    /// was dropped and the host must rescan.
    overflowed: bool,
    /// The backend reported an error; the watch set can no longer be trusted.
    failed: bool,
}

impl PendingEvents {
    fn is_idle(&self) -> bool {
        self.order.is_empty() && !self.overflowed && !self.failed
    }

    fn push(&mut self, event: Event) {
        let may_be_directory = matches!(
            event.kind,
            EventKind::Create(_)
                | EventKind::Modify(ModifyKind::Name(RenameMode::Both | RenameMode::To))
        );
        let output = output_event(event.kind);
        if output.is_none() && !may_be_directory {
            return;
        }
        let destination_only = output.is_some_and(|(_, destination_only)| destination_only);
        let last = event.paths.len().saturating_sub(1);
        for (index, path) in event.paths.into_iter().enumerate() {
            let kind =
                output.and_then(|(kind, _)| (!destination_only || index == last).then_some(kind));
            self.record(path, kind, may_be_directory);
        }
    }

    fn record(&mut self, path: PathBuf, output: Option<OutputEvent>, may_be_directory: bool) {
        if self.overflowed {
            // The rescan the host performs after the resync frame covers this.
            return;
        }
        if !self.paths.contains_key(&path) {
            if self.paths.len() >= MAX_PENDING_PATHS {
                self.order.clear();
                self.paths.clear();
                self.overflowed = true;
                return;
            }
            self.order.push(path.clone());
        }
        let entry = self.paths.entry(path).or_default();
        if output.is_some() {
            entry.output = output;
        }
        entry.may_be_directory |= may_be_directory;
    }
}

#[derive(Default)]
struct EventQueue {
    pending: Mutex<PendingEvents>,
    wake: Condvar,
}

impl EventQueue {
    fn lock(&self) -> MutexGuard<'_, PendingEvents> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn record(&self, result: notify::Result<Event>) {
        let mut pending = self.lock();
        match result {
            Ok(event) => pending.push(event),
            Err(_) => pending.failed = true,
        }
        drop(pending);
        self.wake.notify_one();
    }

    /// Takes everything recorded so far, waiting briefly first when idle.
    fn take(&self) -> PendingEvents {
        let mut pending = self.lock();
        if pending.is_idle() {
            pending = self
                .wake
                .wait_timeout(pending, DRAIN_IDLE_WAIT)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        std::mem::take(&mut *pending)
    }
}

/// Runs a parent-owned depth-bounded watcher until stdin reaches EOF.
pub fn run(roots: Vec<PathBuf>) -> bool {
    let queue = Arc::new(EventQueue::default());
    let callback_queue = Arc::clone(&queue);
    let mut watcher = match RecommendedWatcher::new(
        move |result: notify::Result<Event>| callback_queue.record(result),
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
        match shutdown_rx.try_recv() {
            Ok(true) => return true,
            Ok(false) => return fail(),
            Err(mpsc::TryRecvError::Disconnected) => return fail(),
            Err(mpsc::TryRecvError::Empty) => {}
        }

        let batch = queue.take();
        if batch.failed {
            return fail();
        }
        if batch.overflowed && !resync(&mut stdout, &mut watcher, &roots) {
            return fail();
        }
        for path in &batch.order {
            let Some(entry) = batch.paths.get(path) else {
                continue;
            };
            if entry.may_be_directory
                && !watch_created_directory(&mut stdout, &mut watcher, &roots, path)
            {
                return fail();
            }
            if let Some(kind) = entry.output {
                if let Some(frame) = frame_for_path(kind, path, &roots) {
                    if stdout.write_all(&frame).is_err() || stdout.flush().is_err() {
                        return fail();
                    }
                }
            }
        }
    }
}

/// The queue dropped events. Directories created meanwhile may lack watches,
/// so re-walk the roots (claiming watches only), then tell the host to rescan:
/// it owns the transcript index and reconciles far cheaper than a restart.
fn resync<W: Watcher>(stdout: &mut impl Write, watcher: &mut W, roots: &[PathBuf]) -> bool {
    for root in roots {
        if !watch_directory_tree(watcher, stdout, roots, root, 0, false) {
            return false;
        }
    }
    stdout.write_all(RESYNC_FRAME).is_ok() && stdout.flush().is_ok()
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
/// Vanished directories are not failures; watch-install and stdout errors are.
fn watch_directory_tree<W: Watcher>(
    watcher: &mut W,
    stdout: &mut impl Write,
    roots: &[PathBuf],
    dir: &Path,
    depth: usize,
    emit_existing: bool,
) -> bool {
    match watcher.watch(dir, RecursiveMode::NonRecursive) {
        Ok(()) => {}
        Err(error) if is_vanished_directory_error(&error) => return true,
        Err(_) => return false,
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return true,
        Err(_) => return false,
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            if depth < MAX_WATCH_DIR_DEPTH
                && !watch_directory_tree(
                    watcher,
                    stdout,
                    roots,
                    &entry.path(),
                    depth + 1,
                    emit_existing,
                )
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

fn is_vanished_directory_error(error: &notify::Error) -> bool {
    match &error.kind {
        ErrorKind::PathNotFound => true,
        ErrorKind::Io(error) => error.kind() == io::ErrorKind::NotFound,
        _ => false,
    }
}

/// Extends the watch set when a directory appears inside a root at an
/// observable depth, whether freshly created or moved in.
fn watch_created_directory<W: Watcher>(
    stdout: &mut impl Write,
    watcher: &mut W,
    roots: &[PathBuf],
    path: &Path,
) -> bool {
    let Ok(resolved) = std::fs::canonicalize(path) else {
        return true;
    };
    if !resolved.is_dir() {
        return true;
    }
    let Some(depth) = directory_depth(&resolved, roots) else {
        return true;
    };
    if depth == 0 || depth > MAX_WATCH_DIR_DEPTH {
        return true;
    }
    watch_directory_tree(watcher, stdout, roots, &resolved, depth, true)
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

/// Frame kind for an event, and whether only the last (destination) path of
/// the event names the file to report.
fn output_event(kind: EventKind) -> Option<(OutputEvent, bool)> {
    match kind {
        EventKind::Create(_) => Some((OutputEvent::Add, false)),
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => None,
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => Some((OutputEvent::Change, true)),
        EventKind::Modify(_) => Some((OutputEvent::Change, false)),
        _ => None,
    }
}

fn frame_for_path(kind: OutputEvent, path: &Path, roots: &[PathBuf]) -> Option<Vec<u8>> {
    let resolved = std::fs::canonicalize(path).ok()?;
    frame_for_resolved_path(kind, &resolved, roots)
}

fn frame_for_resolved_path(kind: OutputEvent, path: &Path, roots: &[PathBuf]) -> Option<Vec<u8>> {
    let inside_root = roots.iter().any(|root| is_inside_root(path, root));
    let is_jsonl = path.extension() == Some(OsStr::new("jsonl"));
    let is_pane_receipt = path.parent().is_some_and(|parent| {
        roots.iter().any(|root| parent == root)
            && path
                .file_name()
                .and_then(OsStr::to_str)
                .is_some_and(|name| {
                    name.strip_prefix("tmux-%").is_some_and(|pane_id| {
                        !pane_id.is_empty()
                            && pane_id.chars().all(|character| character.is_ascii_digit())
                    })
                })
    });
    if !inside_root || (!is_jsonl && !is_pane_receipt) {
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
    use super::{
        EventQueue, MAX_PENDING_PATHS, OutputEvent, PendingEvents, PendingPath, directory_depth,
        frame_for_path, frame_for_resolved_path, watch_directory_tree,
    };
    use notify::event::{CreateKind, DataChange, ModifyKind, RemoveKind, RenameMode};
    use notify::{Config, Event, EventHandler, EventKind, RecursiveMode, Watcher, WatcherKind};
    use std::fs;
    use std::path::{Path, PathBuf};

    fn event(kind: EventKind, paths: &[&str]) -> Event {
        paths.iter().fold(Event::new(kind), |event, path| {
            event.add_path(PathBuf::from(path))
        })
    }

    fn change(path: &str) -> Event {
        event(
            EventKind::Modify(ModifyKind::Data(DataChange::Any)),
            &[path],
        )
    }

    #[test]
    fn coalesces_events_per_path_in_arrival_order_keeping_the_latest_kind() {
        let mut pending = PendingEvents::default();
        pending.push(event(EventKind::Create(CreateKind::File), &["/r/a.jsonl"]));
        pending.push(change("/r/b.jsonl"));
        pending.push(change("/r/a.jsonl"));
        assert_eq!(
            pending.order,
            [PathBuf::from("/r/a.jsonl"), PathBuf::from("/r/b.jsonl")]
        );
        assert_eq!(
            pending.paths[Path::new("/r/a.jsonl")],
            PendingPath {
                output: Some(OutputEvent::Change),
                may_be_directory: true,
            }
        );
        assert_eq!(
            pending.paths[Path::new("/r/b.jsonl")],
            PendingPath {
                output: Some(OutputEvent::Change),
                may_be_directory: false,
            }
        );

        // A rename reports only its destination, but either side may be a
        // directory the watch set has to follow.
        pending.push(event(
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            &["/r/old", "/r/new"],
        ));
        assert_eq!(
            pending.paths[Path::new("/r/old")],
            PendingPath {
                output: None,
                may_be_directory: true,
            }
        );
        assert_eq!(
            pending.paths[Path::new("/r/new")],
            PendingPath {
                output: Some(OutputEvent::Change),
                may_be_directory: true,
            }
        );

        // Removals and rename sources carry nothing the host acts on.
        pending.push(event(EventKind::Remove(RemoveKind::File), &["/r/gone"]));
        pending.push(event(
            EventKind::Modify(ModifyKind::Name(RenameMode::From)),
            &["/r/moved-away"],
        ));
        assert!(!pending.paths.contains_key(Path::new("/r/gone")));
        assert!(!pending.paths.contains_key(Path::new("/r/moved-away")));
        assert!(!pending.overflowed);
    }

    #[test]
    fn overflow_drops_the_backlog_and_asks_for_a_resync_instead_of_failing() {
        let mut pending = PendingEvents::default();
        for index in 0..MAX_PENDING_PATHS {
            pending.push(change(&format!("/r/{index}.jsonl")));
        }
        assert!(!pending.overflowed);
        assert_eq!(pending.paths.len(), MAX_PENDING_PATHS);

        // Re-touching a known path is coalesced, never counted again.
        pending.push(change("/r/0.jsonl"));
        assert!(!pending.overflowed);

        pending.push(change("/r/one-too-many.jsonl"));
        assert!(pending.overflowed);
        assert!(!pending.failed);
        assert!(pending.order.is_empty());
        assert!(pending.paths.is_empty());

        // Until the drain takes the batch, later events are not remembered:
        // the rescan the resync frame triggers covers them.
        pending.push(change("/r/later.jsonl"));
        assert!(pending.paths.is_empty());

        let taken = std::mem::take(&mut pending);
        assert!(taken.overflowed);
        assert!(pending.is_idle());
    }

    #[test]
    fn queue_hands_over_batches_and_flags_backend_errors() {
        let queue = EventQueue::default();
        queue.record(Ok(event(
            EventKind::Create(CreateKind::File),
            &["/r/a.jsonl"],
        )));
        let batch = queue.take();
        assert_eq!(batch.order, [PathBuf::from("/r/a.jsonl")]);
        assert!(!batch.failed);

        queue.record(Err(notify::Error::generic("backend")));
        assert!(queue.take().failed);

        // An idle queue yields an empty batch after the bounded wait.
        assert!(queue.take().is_idle());
    }
    struct FailingWatcher {
        error: Option<notify::Error>,
    }

    impl Watcher for FailingWatcher {
        fn new<F: EventHandler>(_event_handler: F, _config: Config) -> notify::Result<Self> {
            Ok(Self { error: None })
        }

        fn watch(&mut self, _path: &Path, _recursive_mode: RecursiveMode) -> notify::Result<()> {
            Err(self
                .error
                .take()
                .unwrap_or_else(|| notify::Error::generic("unexpected watch")))
        }

        fn unwatch(&mut self, _path: &Path) -> notify::Result<()> {
            Ok(())
        }

        fn kind() -> WatcherKind {
            WatcherKind::NullWatcher
        }
    }

    #[test]
    fn propagates_non_vanished_watch_install_failures() {
        let directory = std::env::temp_dir().join(format!(
            "chatmux-core-watch-error-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        fs::create_dir(&directory).unwrap();
        let mut watcher = FailingWatcher {
            error: Some(notify::Error::generic("watch limit reached")),
        };
        let mut output = Vec::new();

        assert!(!watch_directory_tree(
            &mut watcher,
            &mut output,
            std::slice::from_ref(&directory),
            &directory,
            0,
            false,
        ));

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn ignores_vanished_directory_watch_install_failures() {
        let directory = PathBuf::from("/nonexistent/chatmux-core-watch-test");
        let mut watcher = FailingWatcher {
            error: Some(notify::Error::path_not_found()),
        };
        let mut output = Vec::new();

        assert!(watch_directory_tree(
            &mut watcher,
            &mut output,
            std::slice::from_ref(&directory),
            &directory,
            0,
            false,
        ));
    }

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
    fn frames_only_supported_canonical_paths_inside_roots() {
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
        let pane_receipt = root.join("tmux-%7");
        fs::write(&session, b"{}\n").unwrap();
        fs::write(&ignored, b"ignored").unwrap();
        fs::write(&pane_receipt, b"/workspace\n/session.jsonl\n").unwrap();

        assert!(frame_for_path(OutputEvent::Add, &session, std::slice::from_ref(&root),).is_some());
        assert!(
            frame_for_path(
                OutputEvent::Change,
                &pane_receipt,
                std::slice::from_ref(&root),
            )
            .is_some()
        );
        assert_eq!(
            frame_for_path(OutputEvent::Change, &ignored, std::slice::from_ref(&root),),
            None
        );
        let nested_receipt = transcripts.join("tmux-%8");
        fs::write(&nested_receipt, b"ignored").unwrap();
        assert_eq!(
            frame_for_path(
                OutputEvent::Change,
                &nested_receipt,
                std::slice::from_ref(&root),
            ),
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
