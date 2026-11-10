use std::{ffi::CStr, os::unix::fs::{DirBuilderExt, MetadataExt}, path::{Component, PathBuf}};
use oc_core::{error::{Error, Result, check_cancel}, io::BoundedIo};
use tauri::Manager;

include!(concat!(env!("OUT_DIR"), "/catalog.rs"));

#[derive(Clone)]
pub enum InstallationReceipt { Signed(PathBuf), Local(PathBuf) }

pub struct Config {
    pub home: PathBuf,
    pub profile: PathBuf,
    pub resources: PathBuf,
    pub bundle: PathBuf,
    pub tmp: PathBuf,
    pub headless: bool,
    pub development: bool,
    pub recovery_acceptance: bool,
    pub ready_request: Option<InstallationReceipt>,
    pub os_release: String,
    #[cfg(feature="acceptance")]
    seed_applied: std::sync::atomic::AtomicBool,
}

pub fn development() -> bool { cfg!(any(debug_assertions, feature = "acceptance")) }
pub fn headless() -> Result<bool> {
    if !development() { return Ok(false); }
    match std::env::var("OC_CHAN_HEADLESS").as_deref() {
        Ok("1") | Err(std::env::VarError::NotPresent) => Ok(true),
        Ok("0") => Ok(false),
        _ => Err(Error::invalid("OC_CHAN_HEADLESS")),
    }
}
fn absolute(path: PathBuf, name: &str) -> Result<PathBuf> {
    if !path.is_absolute() || path.as_os_str().len() > 4096 || path.components().any(|part| matches!(part, Component::ParentDir)) {
        return Err(Error::invalid(name));
    }
    Ok(path)
}
fn system_temporary_directory(path: PathBuf) -> Result<PathBuf> {
    let path = absolute(path, "temporary directory")?;
    // macOS supplies TMPDIR with a trailing slash and a /var -> /private/var alias.
    // Normalize this system input before passing it to strict native path validation.
    let canonical = std::fs::canonicalize(path).map_err(|error| Error::io("canonical temporary directory", error))?;
    absolute(canonical, "temporary directory")
}
impl Config {
    pub fn read(app: &tauri::AppHandle) -> Result<Self> {
        let development = development();
        let home = absolute(if development { std::env::var_os("OC_CHAN_HOME").or_else(|| std::env::var_os("HOME")) } else { std::env::var_os("HOME") }
            .map(PathBuf::from).ok_or_else(|| Error::invalid("home directory"))?, "home directory")?;
        let profile = absolute(if development { std::env::var_os("OC_CHAN_PROFILE").map(PathBuf::from)
            .ok_or_else(|| Error::new("OC_PROFILE_REQUIRED", "开发实例必须使用独立配置目录 / Development requires an isolated profile"))? }
            else { home.join("Library/Application Support/OC Chan") }, "profile directory")?;
        if development && profile == home.join("Library/Application Support/OC Chan") {
            return Err(Error::new("OC_PROFILE_PROTECTED", "开发实例不能使用正式配置 / Development cannot use the installed profile"));
        }
        let resources = absolute(if development { std::env::var_os("OC_CHAN_RESOURCE_DIR").map(PathBuf::from)
            .ok_or_else(|| Error::invalid("development resources"))? }
            else { app.path().resource_dir().map_err(|_| Error::new("OC_RESOURCES", "无法定位应用资源 / Application resources unavailable"))? }, "resource directory")?;
        let executable = std::env::current_exe().map_err(|e| Error::io("application executable", e))?;
        let bundle = match executable.ancestors().find(|path| path.extension().is_some_and(|extension| extension == "app")) {
            Some(path) => path.to_owned(),
            None if development => executable.clone(),
            None => return Err(Error::new("OC_BUNDLE_REQUIRED", "正式应用必须从应用包运行 / Production must run from its application bundle")),
        };
        let mut ready_request = None;
        for argument in std::env::args_os().skip(1) {
            let argument = argument.to_str().ok_or_else(|| Error::invalid("application argument encoding"))?;
            if let Some(path) = argument.strip_prefix(oc_installer::READY_ARGUMENT) {
                if ready_request.is_some() { return Err(Error::invalid("duplicate installation receipt")); }
                ready_request = Some(InstallationReceipt::Signed(absolute(PathBuf::from(path), "installation receipt")?));
            } else if let Some(path) = argument.strip_prefix(oc_installer::LOCAL_READY_ARGUMENT) {
                if ready_request.is_some() { return Err(Error::invalid("duplicate installation receipt")); }
                ready_request = Some(InstallationReceipt::Local(absolute(PathBuf::from(path), "local installation receipt")?));
            } else if !(argument.starts_with("-psn_") && argument.len() <= 64 && argument[5..].bytes().all(|b| b.is_ascii_digit() || b == b'_')) {
                return Err(Error::invalid("application argument"));
            }
        }
        let mut system = std::mem::MaybeUninit::<libc::utsname>::uninit();
        if unsafe { libc::uname(system.as_mut_ptr()) } != 0 { return Err(Error::io("system release", std::io::Error::last_os_error())); }
        let system = unsafe { system.assume_init() };
        let os_release = unsafe { CStr::from_ptr(system.release.as_ptr()) }.to_str().map_err(|_| Error::invalid("system release"))?.to_owned();
        let tmp = system_temporary_directory(std::env::temp_dir())?;
        Ok(Self { home, profile, resources, bundle, tmp, headless: headless()?, development,
            recovery_acceptance: cfg!(feature = "acceptance") && std::env::var("OC_CHAN_ACCEPTANCE_RECOVERY").as_deref() == Ok("1"), ready_request, os_release,
            #[cfg(feature="acceptance")] seed_applied: std::sync::atomic::AtomicBool::new(false) })
    }
    pub fn catalog_digest(&self) -> &str {
        std::hint::black_box(CATALOG_MARKER).strip_prefix("OC_CHAN_CATALOG_SHA256=").expect("compiled catalog marker")
    }
    pub async fn prepare_profile(&self, io: &BoundedIo) -> Result<()> {
        let profile = self.profile.clone();
        io.with_file_budget("desktop-startup", 4096, &io.cancellation(), move |cancel| async move {
            tokio::task::spawn_blocking(move || {
                for path in [&profile, &profile.join("events")] {
                    check_cancel(&cancel)?;
                    match std::fs::symlink_metadata(path) {
                        Ok(metadata) => {
                            if !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() } { return Err(Error::invalid("profile directory identity")); }
                        },
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                            std::fs::DirBuilder::new().recursive(true).mode(0o700).create(path).map_err(|e| Error::io("create profile directory", e))?;
                        },
                        Err(error) => return Err(Error::io("profile directory", error)),
                    }
                    let real = std::fs::canonicalize(path).map_err(|e| Error::io("profile identity", e))?;
                    if real != *path { return Err(Error::invalid("profile directory symlink")); }
                }
                check_cancel(&cancel)
            }).await.map_err(|_| Error::new("OC_PROFILE_TASK", "配置目录初始化失败 / Profile initialization task failed"))?
        }).await?;
        #[cfg(feature="acceptance")]
        if !self.seed_applied.swap(true, std::sync::atomic::Ordering::AcqRel) {
            if let Some(seed) = std::env::var_os("OC_CHAN_ACCEPTANCE_SETTINGS") {
                if !self.headless { return Err(Error::invalid("acceptance settings require a headless profile")); }
                let seed = absolute(PathBuf::from(seed), "acceptance settings seed")?;
                let target = self.profile.join("settings.json");
                let bytes = io.read_file("desktop-startup", &seed, 64 * 1024, true, &io.cancellation()).await?.bytes;
                io.with_file_budget("desktop-startup", bytes.len(), &io.cancellation(), move |cancel| async move {
                    use tokio::io::AsyncWriteExt;
                    check_cancel(&cancel)?;
                    let mut file = tokio::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).custom_flags(libc::O_NOFOLLOW).open(&target).await.map_err(|error| Error::io("seed isolated settings", error))?;
                    let result = async { file.write_all(&bytes).await.map_err(|error| Error::io("write isolated settings", error))?; file.sync_all().await.map_err(|error| Error::io("sync isolated settings", error)) }.await;
                    oc_core::io::merge_close(result, oc_core::io::close_file(file).await)
                }).await?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_temporary_directory_resolves_alias_and_trailing_separator() {
        let directory = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(directory.path()).unwrap();
        let target = root.join("temporary");
        std::fs::create_dir(&target).unwrap();
        let alias = root.join("alias");
        std::os::unix::fs::symlink(&target, &alias).unwrap();
        let mut input = alias.into_os_string();
        input.push("/");
        let canonical = system_temporary_directory(PathBuf::from(input)).unwrap();
        assert_eq!(canonical, target);
        assert!(!canonical.as_os_str().as_encoded_bytes().ends_with(b"/"));
        assert_eq!(system_temporary_directory(std::env::temp_dir()).unwrap(), std::fs::canonicalize(std::env::temp_dir()).unwrap());
    }

    #[test]
    fn system_temporary_directory_preserves_invalid_and_missing_path_errors() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(system_temporary_directory(directory.path().join("missing")).unwrap_err().code, "ENOENT");
        for path in [PathBuf::from("relative"), directory.path().join("../other")] {
            assert_eq!(system_temporary_directory(path).unwrap_err().code, "OC_INVALID_INPUT");
        }
    }
}
