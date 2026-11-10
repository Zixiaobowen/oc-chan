use super::*;
use std::{fs, os::unix::fs::{PermissionsExt, symlink}};
use tokio::io::AsyncBufReadExt;

#[tokio::test]
async fn private_directory_and_file_identity_are_checked_against_real_handles() {
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let file = root.path().join("session"); fs::write(&file, b"0123456789").unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    let io = BoundedIo::new(ResourceBudget::default()); let cancel = CancellationToken::new();
    let read = io.read_file("agents", &file, 32, true, &cancel).await.unwrap();
    assert_eq!(read.identity.uid, unsafe { libc::getuid() });
    assert_eq!(read.identity.mode & 0o777, 0o600); assert_eq!(read.identity.nlink, 1);
    assert_eq!(io.read_range("agents", &file, 3, 4, &cancel).await.unwrap().bytes, b"3456");
    let alias = root.path().join("alias"); symlink(&file, &alias).unwrap();
    assert_eq!(io.read_range("agents", &alias, 0, 4, &cancel).await.unwrap_err().code, "ELOOP");
    let mut names = io.read_private_directory("agents", root.path(), 2, 64, &cancel).await.unwrap(); names.sort();
    assert_eq!(names, vec![alias, file]);
    assert_eq!(io.read_private_directory("agents", root.path(), 1, 64, &cancel).await.unwrap_err().code, "OC_COLLECTION_LIMIT");
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o750)).unwrap();
    assert_eq!(io.read_private_directory("agents", root.path(), 2, 64, &cancel).await.unwrap_err().code, "OC_PRIVATE_DIRECTORY");
    io.shutdown().await.unwrap();
    assert_eq!(io.resources().snapshot().global.current.files, 0);
}

#[tokio::test]
async fn directory_admits_normal_names_and_rejects_actual_bytes_before_allocation() {
    let root = tempfile::tempdir().unwrap();
    let first = root.path().join("first"); fs::write(&first, b"").unwrap();
    let capacity = 2 * std::mem::size_of::<PathBuf>() + root.path().as_os_str().len() + 1 + 5;
    let pool = ResourceBudget::new(crate::resources::ResourceLimits { file_bytes: capacity, ..Default::default() }).unwrap();
    let io = BoundedIo::new(pool.clone()); let cancel = CancellationToken::new();
    assert_eq!(io.read_directory("directory", root.path(), 2, 4096, &cancel).await.unwrap(), vec![first]);
    fs::write(root.path().join("second"), b"").unwrap();
    assert_eq!(io.read_directory("directory", root.path(), 2, 4096, &cancel).await.unwrap_err().code, "OC_COLLECTION_LIMIT");
    io.shutdown().await.unwrap();
    let usage = pool.snapshot().global;
    assert_eq!(usage.current.files, 0); assert_eq!(usage.current.file_bytes, 0);
    assert!(usage.peak.file_bytes <= capacity);
}

#[tokio::test]
async fn socket_response_finishes_at_newline_without_waiting_for_peer_close() {
    let root = tempfile::tempdir().unwrap(); let path = root.path().join("host.sock");
    let listener = tokio::net::UnixListener::bind(&path).unwrap();
    let (release, released) = oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = tokio::io::BufReader::new(socket); let mut request = String::new();
        socket.read_line(&mut request).await.unwrap(); assert_eq!(request, "metadata\n");
        socket.get_mut().write_all(b"{\"pid\":123}\n").await.unwrap();
        released.await.unwrap();
    });
    let io = BoundedIo::new(ResourceBudget::default()); let cancel = CancellationToken::new();
    let result = io.socket("agents", &path, b"metadata\n".to_vec(), 128, Duration::from_secs(1), &cancel).await;
    release.send(()).unwrap(); server.await.unwrap();
    assert_eq!(result.unwrap(), b"{\"pid\":123}\n");
    io.shutdown().await.unwrap(); assert_eq!(io.resources().snapshot().global.current.sockets, 0);
}

#[tokio::test]
async fn socket_truncation_and_byte_limits_are_explicit_failures() {
    for (response, maximum, code) in [(b"unfinished".as_slice(), 128, "OC_SOCKET_PROTOCOL"), (b"12345\n".as_slice(), 4, "OC_COLLECTION_LIMIT")] {
        let root = tempfile::tempdir().unwrap(); let path = root.path().join("host.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let response = response.to_vec();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut input = [0u8; 1]; socket.read_exact(&mut input).await.unwrap();
            socket.write_all(&response).await.unwrap();
        });
        let io = BoundedIo::new(ResourceBudget::default()); let cancel = CancellationToken::new();
        let error = io.socket("agents", &path, vec![b'?'], maximum, Duration::from_secs(1), &cancel).await.unwrap_err();
        server.await.unwrap(); assert_eq!(error.code, code);
        io.shutdown().await.unwrap(); assert_eq!(io.resources().snapshot().global.current.sockets, 0);
    }
}

#[tokio::test]
async fn command_cancel_waits_for_actual_child_exit_and_reaping() {
    let root = tempfile::tempdir().unwrap(); let pid_file = root.path().join("pid");
    let io = BoundedIo::new(ResourceBudget::default()); let cancel = CancellationToken::new();
    let spec = CommandSpec::new("/bin/sh", vec![OsString::from("-c"), OsString::from("printf '%s' $$ > \"$1\"; exec /bin/sleep 30"), OsString::from("io-test"), pid_file.as_os_str().to_owned()], 4096, Duration::from_secs(10));
    let task = { let io = io.clone(); let cancel = cancel.clone(); tokio::spawn(async move { io.command("agents", spec, &cancel).await }) };
    let pid = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match tokio::fs::read_to_string(&pid_file).await {
                Ok(text) if !text.is_empty() => break text.parse::<u32>().unwrap(),
                Ok(_) => {}, Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}, Err(error) => panic!("pid marker: {error}"),
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }).await.unwrap();
    let identity = crate::process::ProcessIdentity::read(pid).unwrap();
    cancel.cancel(); let error = task.await.unwrap().unwrap_err(); assert!(error.is_cancelled(), "{error}");
    assert!(!matches!(crate::process::ProcessIdentity::read(pid), Ok(actual) if actual == identity));
    let mut status = 0; assert_eq!(unsafe { libc::waitpid(pid as i32, &mut status, libc::WNOHANG) }, -1);
    assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(libc::ECHILD));
    assert_eq!(io.resources().snapshot().global.current.commands, 0); io.shutdown().await.unwrap();
}

#[tokio::test]
async fn command_closes_stdin_before_waiting_for_eof_consumers() {
    let io = BoundedIo::new(ResourceBudget::default());
    let mut spec = CommandSpec::new("/usr/bin/wc", ["-c"], 4096, Duration::from_secs(1));
    spec.input = vec![b'x'; 8192];
    let result = io.command("events", spec, &CancellationToken::new()).await.unwrap().success().unwrap();
    assert_eq!(result.stdout_text().unwrap().trim(), "8192");
    io.shutdown().await.unwrap();
}

#[tokio::test]
async fn command_timeout_kills_pipe_holding_descendant_after_leader_exit() {
    let root = tempfile::tempdir().unwrap(); let pid_file = root.path().join("descendant");
    let io = BoundedIo::new(ResourceBudget::default());
    let spec = CommandSpec::new("/bin/sh", vec![OsString::from("-c"), OsString::from("/bin/sleep 30 & printf '%s' $! > \"$1\"; exit 0"), OsString::from("io-test"), pid_file.as_os_str().to_owned()], 4096, Duration::from_millis(500));
    let error = io.command("events", spec, &CancellationToken::new()).await.unwrap_err();
    assert_eq!(error.code, "ETIMEDOUT");
    let descendant = fs::read_to_string(&pid_file).unwrap().parse::<u32>().unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while crate::process::ProcessIdentity::read(descendant).is_ok() { tokio::time::sleep(Duration::from_millis(5)).await; }
    }).await.expect("descendant must exit and be reaped");
    assert_eq!(io.resources().snapshot().global.current.commands, 0); io.shutdown().await.unwrap();
}
