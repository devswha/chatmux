use std::ffi::{OsStr, OsString};
use std::path::{Component, Path, PathBuf};

#[cfg(not(windows))]
use nix::errno::Errno;

#[derive(Debug, Eq, PartialEq)]
pub enum MkdirUnderError {
    #[cfg(not(windows))]
    Root { root: PathBuf, errno: Errno },
    #[cfg(not(windows))]
    Component { component: OsString, errno: Errno },
    #[cfg(windows)]
    Unsupported,
}

#[cfg(not(windows))]
impl MkdirUnderError {
    pub fn errno(&self) -> Errno {
        match self {
            Self::Root { errno, .. } | Self::Component { errno, .. } => *errno,
        }
    }

    pub fn component(&self) -> &OsStr {
        match self {
            Self::Root { root, .. } => root.as_os_str(),
            Self::Component { component, .. } => component,
        }
    }
}

/// Creates `components` below an already-canonical directory without resolving
/// any pathname after the root has been opened.
#[cfg(not(windows))]
pub fn mkdir_under(
    canonical_root: &Path,
    components: &[OsString],
) -> Result<PathBuf, MkdirUnderError> {
    use nix::fcntl::{AtFlags, OFlag, open, openat};
    use nix::sys::stat::{Mode, SFlag, fstatat, mkdirat};

    let directory_flags = OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW;
    let mut directory = open(canonical_root, directory_flags, Mode::empty()).map_err(|errno| {
        MkdirUnderError::Root {
            root: canonical_root.to_path_buf(),
            errno,
        }
    })?;
    let mut result = canonical_root.to_path_buf();

    for component in components {
        if !is_single_normal_component(component) {
            return Err(MkdirUnderError::Component {
                component: component.clone(),
                errno: Errno::EINVAL,
            });
        }

        match mkdirat(
            &directory,
            component.as_os_str(),
            Mode::from_bits_truncate(0o755),
        ) {
            Ok(()) => {}
            Err(Errno::EEXIST) => {
                let metadata = fstatat(
                    &directory,
                    component.as_os_str(),
                    AtFlags::AT_SYMLINK_NOFOLLOW,
                )
                .map_err(|errno| MkdirUnderError::Component {
                    component: component.clone(),
                    errno,
                })?;
                if SFlag::from_bits_truncate(metadata.st_mode) & SFlag::S_IFMT != SFlag::S_IFDIR {
                    return Err(MkdirUnderError::Component {
                        component: component.clone(),
                        errno: Errno::ENOTDIR,
                    });
                }
            }
            Err(errno) => {
                return Err(MkdirUnderError::Component {
                    component: component.clone(),
                    errno,
                });
            }
        }

        directory = openat(
            &directory,
            component.as_os_str(),
            directory_flags,
            Mode::empty(),
        )
        .map_err(|errno| MkdirUnderError::Component {
            component: component.clone(),
            errno,
        })?;
        result.push(component);
    }

    Ok(result)
}

#[cfg(windows)]
pub fn mkdir_under(
    _canonical_root: &Path,
    _components: &[OsString],
) -> Result<PathBuf, MkdirUnderError> {
    Err(MkdirUnderError::Unsupported)
}

fn is_single_normal_component(component: &OsStr) -> bool {
    let mut parts = Path::new(component).components();
    matches!(parts.next(), Some(Component::Normal(part)) if part == component)
        && parts.next().is_none()
}

#[cfg(all(test, unix))]
mod tests {
    use super::{MkdirUnderError, mkdir_under};
    use nix::errno::Errno;
    use std::ffi::OsString;
    use std::fs;
    use std::os::unix::fs::symlink;
    use tempfile::tempdir;

    fn components(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn creates_nested_directories_on_disk() {
        let temporary = tempdir().unwrap();
        let root = fs::canonicalize(temporary.path()).unwrap();
        let result = mkdir_under(&root, &components(&["one", "two", "three"])).unwrap();

        assert_eq!(result, root.join("one/two/three"));
        assert!(fs::symlink_metadata(root.join("one")).unwrap().is_dir());
        assert!(fs::symlink_metadata(root.join("one/two")).unwrap().is_dir());
        assert!(fs::symlink_metadata(&result).unwrap().is_dir());
    }

    #[test]
    fn refuses_a_symlink_component_without_creating_through_it() {
        let temporary = tempdir().unwrap();
        let root = temporary.path().join("root");
        let outside = temporary.path().join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        symlink(&outside, root.join("link")).unwrap();
        let root = fs::canonicalize(root).unwrap();

        let error = mkdir_under(&root, &components(&["link", "child"])).unwrap_err();

        assert_eq!(
            error,
            MkdirUnderError::Component {
                component: OsString::from("link"),
                errno: Errno::ENOTDIR,
            }
        );
        assert!(
            fs::symlink_metadata(root.join("link"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            fs::symlink_metadata(outside.join("child"))
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::NotFound
        );
    }

    #[test]
    fn refuses_a_symlink_root() {
        let temporary = tempdir().unwrap();
        let actual = temporary.path().join("actual");
        let link = temporary.path().join("link");
        fs::create_dir(&actual).unwrap();
        symlink(&actual, &link).unwrap();

        let error = mkdir_under(&link, &components(&["child"])).unwrap_err();

        assert!(matches!(error, MkdirUnderError::Root { .. }));
        assert!(
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            fs::symlink_metadata(actual.join("child"))
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::NotFound
        );
    }

    #[test]
    fn refuses_an_existing_regular_file() {
        let temporary = tempdir().unwrap();
        let root = fs::canonicalize(temporary.path()).unwrap();
        fs::write(root.join("file"), b"contents").unwrap();

        let error = mkdir_under(&root, &components(&["file", "child"])).unwrap_err();

        assert_eq!(
            error,
            MkdirUnderError::Component {
                component: OsString::from("file"),
                errno: Errno::ENOTDIR,
            }
        );
        assert_eq!(fs::read(root.join("file")).unwrap(), b"contents");
        assert_eq!(
            fs::symlink_metadata(root.join("file/child"))
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::NotADirectory
        );
    }
}
