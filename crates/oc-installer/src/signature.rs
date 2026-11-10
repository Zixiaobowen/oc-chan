use crate::{ensure, filesystem::{deadline, digest_until, real_path}, process::bounded_command, reject, IoResult, Result, BUNDLE_ID};
use semver::Version;
use std::{fs::{self, OpenOptions}, io::Read, os::unix::fs::{MetadataExt, OpenOptionsExt}, path::Path, time::Instant};

#[derive(Debug, Clone)]
pub struct ValidatedBundle {
    pub version: String,
    pub team: String,
    pub executable: String,
    pub digest: String,
}
/// Kept inside a private module in production; re-exported only for acceptance.
pub trait BundleValidator {
    fn validate(&self, bundle: &Path, end: Instant) -> Result<ValidatedBundle>;
}
pub(crate) struct AppleValidator;
impl BundleValidator for AppleValidator {
    fn validate(&self, bundle: &Path, end: Instant) -> Result<ValidatedBundle> {
        ensure(cfg!(all(target_os = "macos", target_arch = "aarch64")), "production installation requires macOS arm64")?;
        real_path(bundle)?;
        // This requirement validates the cryptographic chain and the Developer ID
        // Application leaf/intermediate extensions. Ad-hoc/Apple Development and
        // self-signed certificates cannot satisfy it.
        let requirement = format!("=anchor apple generic and identifier \"{BUNDLE_ID}\" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists");
        bounded_command(Path::new("/usr/bin/codesign"), &[
            "--verify".into(), "--deep".into(), "--strict".into(), "--all-architectures".into(),
            "--test-requirement".into(), requirement.into(), bundle.as_os_str().to_owned()], end)?;
        bounded_command(Path::new("/usr/sbin/spctl"), &[
            "--assess".into(), "--type".into(), "execute".into(), "--verbose=4".into(), bundle.as_os_str().to_owned()], end)?;
        // Display output is identity evidence only *after* full validity and
        // Gatekeeper trust have been established above.
        let display = bounded_command(Path::new("/usr/bin/codesign"), &[
            "--display".into(), "--verbose=4".into(), bundle.as_os_str().to_owned()], end)?;
        let display = std::str::from_utf8(&display).map_err(|_| reject("invalid codesign identity encoding"))?;
        let teams: Vec<_> = display.lines().filter_map(|l| l.strip_prefix("TeamIdentifier=")).collect();
        ensure(teams.len() == 1 && teams[0].len() == 10 && teams[0].bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()),
            "missing or ambiguous Developer ID Team identity")?;
        let info = read_info(bundle)?;
        let dictionary = info.as_dictionary().ok_or_else(|| reject("Info.plist is not a dictionary"))?;
        let string = |key: &str| -> Result<&str> { dictionary.get(key).and_then(plist::Value::as_string).ok_or_else(|| reject(format!("missing {key}"))) };
        ensure(string("CFBundleIdentifier")? == BUNDLE_ID && string("CFBundlePackageType")? == "APPL", "invalid application bundle identity/type")?;
        let version = string("CFBundleShortVersionString")?;
        stable_version(version)?;
        let executable = string("CFBundleExecutable")?;
        executable_name(executable)?;
        let executable_path = bundle.join("Contents/MacOS").join(executable);
        verify_arm64_executable(&executable_path)?;
        verify_arm64_executable(&bundle.join("Contents/Resources/oc-installer"))?;
        deadline(end)?;
        let digest = digest_until(bundle, end)?;
        Ok(ValidatedBundle { version: version.to_owned(), team: teams[0].to_owned(), executable: executable.to_owned(), digest })
    }
}
pub(crate) fn stable_version(value: &str) -> Result<Version> {
    ensure(value.len() <= 128, "version exceeds bound")?;
    let version = Version::parse(value).map_err(|e| reject(format!("invalid semver: {e}")))?;
    ensure(version.pre.is_empty() && version.build.is_empty() && version.to_string() == value, "version must be strict stable semver")?;
    Ok(version)
}
pub(crate) fn executable_name(name: &str) -> Result<()> {
    ensure(!name.is_empty() && name.len() <= 255 && name != "." && name != ".."
        && !name.contains('/') && !name.bytes().any(|c| c < 32 || c == 127), "invalid bundle executable name")
}
fn read_info(bundle: &Path) -> Result<plist::Value> {
    let path = bundle.join("Contents/Info.plist");
    real_path(&path)?;
    let file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(&path).context("open Info.plist")?;
    let m = file.metadata().context("stat Info.plist")?;
    ensure(m.is_file() && m.nlink() == 1 && m.len() > 0 && m.len() <= 64 * 1024, "invalid Info.plist file")?;
    let mut bytes = Vec::with_capacity(m.len() as usize);
    file.take(64 * 1024 + 1).read_to_end(&mut bytes).context("read Info.plist")?;
    ensure(bytes.len() as u64 == m.len(), "Info.plist changed while reading")?;
    plist::from_bytes(&bytes).map_err(|e| reject(format!("invalid Info.plist: {e}")))
}
pub(crate) fn verify_arm64_executable(path: &Path) -> Result<()> {
    real_path(path)?;
    let m = fs::symlink_metadata(path).context("stat Mach-O executable")?;
    ensure(m.is_file() && m.nlink() == 1 && m.mode() & 0o111 != 0 && m.mode() & 0o7000 == 0, "invalid executable file mode")?;
    let mut file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(path).context("open Mach-O executable")?;
    let mut header = [0u8; 32];
    file.read_exact(&mut header).context("read Mach-O header")?;
    let u32_at = |start| u32::from_le_bytes([header[start], header[start + 1], header[start + 2], header[start + 3]]);
    ensure(u32_at(0) == 0xfeedfacf && u32_at(4) == 0x0100000c && u32_at(12) == 2,
        "application must contain a thin arm64 MH_EXECUTE Mach-O")?;
    let load_bytes = u32_at(20) as u64;
    ensure(u32_at(16) > 0 && load_bytes <= m.len().saturating_sub(32), "invalid Mach-O load commands")
}
