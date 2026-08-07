use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::broadcast;
use tracing::{info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[cfg(unix)]
use tokio::net::UnixListener;

mod protocol;
mod parser_pool;
mod server;
mod extract;
mod simplify;
mod classify;
mod cache;

// r31：三平台支持——Unix 保持 Unix socket + pid 文件；Windows 用 TCP 127.0.0.1 端口
// （无 uid/无 Unix socket/无 SIGTERM 语义）。环境变量 MALONG_SOCKET / MALONG_PORT 覆盖默认值。

#[cfg(unix)]
fn get_socket_path() -> PathBuf {
    if let Ok(p) = std::env::var("MALONG_SOCKET") {
        return PathBuf::from(p);
    }
    let uid = unsafe { libc::getuid() };
    PathBuf::from(format!("/tmp/malong-parse-{}.sock", uid))
}

#[cfg(unix)]
fn get_pid_path() -> PathBuf {
    // Y002-S3：MALONG_SOCKET 隔离时 pid 文件跟随 socket 目录——测试 daemon 与 live daemon
    // （同 UID）可共存，避免 check_existing_instance 误判 "already running"
    if let Ok(p) = std::env::var("MALONG_SOCKET") {
        return PathBuf::from(format!("{}.pid", p));
    }
    let uid = unsafe { libc::getuid() };
    PathBuf::from(format!("/tmp/malong-parse-{}.pid", uid))
}

#[cfg(windows)]
fn get_listen_addr() -> std::net::SocketAddr {
    let port = std::env::var("MALONG_PORT").ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(31001);
    std::net::SocketAddr::from(([127, 0, 0, 1], port))
}

fn get_data_dir() -> PathBuf {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_else(|_| ".".to_string());
    PathBuf::from(format!("{}/.local/share/malong", home))
}

#[cfg(unix)]
fn write_pid_file() -> std::io::Result<()> {
    let pid_path = get_pid_path();
    let pid = std::process::id();
    std::fs::write(&pid_path, pid.to_string())?;
    info!("wrote PID {} to {:?}", pid, pid_path);
    Ok(())
}

#[cfg(windows)]
fn write_pid_file() -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn remove_pid_file() {
    let pid_path = get_pid_path();
    let _ = std::fs::remove_file(&pid_path);
}

#[cfg(windows)]
fn remove_pid_file() {}

// Windows：pid 文件落盘为 no-op，实例共存检查无意义（返回 false 允许启动）
#[cfg(windows)]
fn check_existing_instance() -> bool {
    false
}

#[cfg(unix)]
fn check_existing_instance() -> bool {
    let pid_path = get_pid_path();
    if let Ok(content) = std::fs::read_to_string(&pid_path) {
        if let Ok(pid) = content.trim().parse::<u32>() {
            if unsafe { libc::kill(pid as i32, 0) } == 0 && pid_belongs_to_malong(pid) {
                return true;
            }
        }
    }
    // r8(F4)：陈旧 pid（进程已死 / pid 被系统复用给别的进程）——清除，允许启动
    let _ = std::fs::remove_file(&pid_path);
    false
}

#[cfg(target_os = "linux")]
fn pid_belongs_to_malong(pid: u32) -> bool {
    if let Ok(cmdline) = std::fs::read_to_string(format!("/proc/{}/cmdline", pid)) {
        if cmdline.contains("malong-parse") {
            return true;
        }
    }
    if let Ok(comm) = std::fs::read_to_string(format!("/proc/{}/comm", pid)) {
        if comm.trim().contains("malong-parse") {
            return true;
        }
    }
    false
}

#[cfg(not(target_os = "linux"))]
fn pid_belongs_to_malong(_pid: u32) -> bool {
    // 无 /proc（macOS 等）：保守认为在跑——宁可误判已运行，也不抢 socket 打死活 daemon
    true
}

#[cfg(unix)]
fn generate_token() -> Option<String> {
    // r8(F1)：认证 token——/dev/urandom 32 hex（0600 token 文件，同主机其他用户读不到）
    use std::io::Read;
    let mut f = std::fs::File::open("/dev/urandom").ok()?;
    let mut bytes = [0u8; 16];
    f.read_exact(&mut bytes).ok()?;
    Some(bytes.iter().map(|b| format!("{:02x}", b)).collect())
}

#[cfg(windows)]
fn generate_token() -> Option<String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_nanos();
    Some(format!("{:x}-{}", t, std::process::id()))
}

fn write_token_file(socket_path: &std::path::Path, token: &str) -> bool {
    let token_path = format!("{}.token", socket_path.display());
    if std::fs::write(&token_path, token).is_err() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&token_path, std::fs::Permissions::from_mode(0o600));
    }
    true
}

fn setup_crash_log() -> PathBuf {
    let data_dir = get_data_dir();
    let _ = std::fs::create_dir_all(&data_dir);
    data_dir.join("parse-crash.log")
}

// r10(B)：日志轮转核心（纯文件操作，可单测）——主文件超 max_bytes 时轮转保留 keep 份：
// 主 → .1，原 .1 → .2 … 原 .keep-1 → .keep，原 .keep 删除。
fn rotate_log_file(path: &std::path::Path, max_bytes: u64, keep: usize) -> bool {
    if keep == 0 {
        return false;
    }
    let Ok(meta) = std::fs::metadata(path) else { return false };
    if !meta.is_file() || meta.len() <= max_bytes {
        return false;
    }
    for i in (1..=keep).rev() {
        let cur = std::path::PathBuf::from(format!("{}.{}", path.display(), i));
        if i == keep {
            let _ = std::fs::remove_file(&cur);
        } else {
            let _ = std::fs::rename(&cur, std::path::PathBuf::from(format!("{}.{}", path.display(), i + 1)));
        }
    }
    let _ = std::fs::rename(path, std::path::PathBuf::from(format!("{}.{}", path.display(), 1)));
    true
}

// r10(B)：启动轮转——tracing 写 stderr，shell 重定向（2>&1）到 parse.log；
// 解析 fd2 真实目标（仅 Linux /proc），文件名含 parse.log 才轮转（不误伤其他输出文件）；
// 轮转后 shell 的 fd 仍指向旧 inode——重新打开新文件 dup2 接管 fd2。
fn rotate_stdout_log_if_needed() {
    #[cfg(target_os = "linux")]
    {
        let max_bytes: u64 = std::env::var("MALONG_LOG_MAX_BYTES")
            .ok().and_then(|v| v.parse().ok()).unwrap_or(20 * 1024 * 1024);
        let keep: usize = std::env::var("MALONG_LOG_KEEP")
            .ok().and_then(|v| v.parse().ok()).unwrap_or(3);
        let Ok(target) = std::fs::read_link("/proc/self/fd/2") else { return };
        let name = target.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !name.contains("parse.log") {
            return;
        }
        if rotate_log_file(&target, max_bytes, keep) {
            // 轮转后 shell 的 fd 仍指向旧 inode——重新打开新文件并 dup2 接管 fd1/fd2：
            // tracing fmt layer 默认写 stdout（fd1），shell `2>&1` 使两者同文件但独立 fd——只接管 fd2 会漏掉 fd1
            if let Ok(f) = std::fs::OpenOptions::new().create(true).append(true).open(&target) {
                use std::os::unix::io::AsRawFd;
                let raw = f.as_raw_fd();
                unsafe {
                    libc::dup2(raw, 1);
                    libc::dup2(raw, 2);
                }
            }
        }
    }
}

// r10(B2)：周期轮转间隔——env 可覆盖（测试/调试注入短间隔），默认 6 小时。
fn rotation_interval_ms() -> u64 {
    std::env::var("MALONG_LOG_ROTATE_INTERVAL_MS")
        .ok().and_then(|v| v.parse().ok()).unwrap_or(6 * 3600 * 1000)
}

fn log_crash(msg: &str, context: Option<&str>) {
    let crash_log = setup_crash_log();
    // r10(B)：crash log 同样轮转防无限增长（低频写，stat 开销可忽略）
    rotate_log_file(&crash_log, 10 * 1024 * 1024, 2);
    
    let record = if let Some(ctx) = context {
        serde_json::json!({
            "timestamp": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
            "pid": std::process::id(),
            "message": msg,
            "context": ctx,
        })
    } else {
        serde_json::json!({
            "timestamp": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
            "pid": std::process::id(),
            "message": msg,
        })
    };
    
    let line = format!("{}\n", serde_json::to_string(&record).unwrap_or_default());
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&crash_log)
        .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // r10(B)：最早执行——tracing init 前完成日志轮转 + fd2 接管
    rotate_stdout_log_if_needed();

    human_panic::setup_panic!();

    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::from_default_env()
            .add_directive("malong_parse=info".parse().unwrap()))
        .with(tracing_subscriber::fmt::layer().with_target(false))
        .init();

    if check_existing_instance() {
        info!("malong-parse already running, exiting");
        return Ok(());
    }

    let mut state = server::ServerState::new();
    let (shutdown_tx, _) = broadcast::channel::<()>(1);
    let shutdown_rx = shutdown_tx.subscribe();

    // r10(B2)：周期日志轮转——启动轮转（B1）只覆盖「重启时超阈值」；常驻 daemon 长跑超阈值后不再触发。
    // 每 ROTATE_INTERVAL_MS（默认 6h）检查一次 fd2 目标大小，超阈值即轮转（与启动轮转同一函数，未超则 no-op）。
    {
        let mut rot_rx = shutdown_tx.subscribe();
        tokio::spawn(async move {
            let interval_ms: u64 = rotation_interval_ms();
            let mut ticker = tokio::time::interval(std::time::Duration::from_millis(interval_ms));
            loop {
                tokio::select! {
                    _ = ticker.tick() => {
                        rotate_stdout_log_if_needed();
                    }
                    _ = rot_rx.recv() => break,
                }
            }
        });
    }

    #[cfg(unix)]
    let socket_path = get_socket_path();
    #[cfg(unix)]
    let _ = std::fs::remove_file(&socket_path);

// r8(F1)：认证 token 写入 {socket}.token（0600）——未认证连接会被服务端拒。
// r8.1(修复根因)：认证**默认关闭**，仅 MALONG_AUTH=1（或设置了 MALONG_AUTH_TOKEN）才开启。
// 原因：强制认证会拒绝未实现 __hello 的老客户端（如通天活插件目录的旧 parse-client），
// 其熔断逻辑会 SIGKILL 共享 daemon 再拉起 → 守护进程反复被杀（杀来杀去），所有会话一起断。
// 认证开启时可用 MALONG_AUTH_TOKEN 固定 token，否则 /dev/urandom 随机 + 写 0600 token 文件。
let env_token = std::env::var("MALONG_AUTH_TOKEN").ok().filter(|t| !t.is_empty());
let auth_enabled = env_token.is_some()
    || std::env::var("MALONG_AUTH").map(|v| v != "0" && !v.is_empty()).unwrap_or(false);
let auth_token = if auth_enabled {
    env_token.or_else(generate_token)
} else {
    None
};
// r9(E1)：auth_token 设置不引用 socket_path（Windows 无该变量）——E0425 修复：
// 旧实现此块无条件用 socket_path，Windows 目标编译失败（r31 宣称的三平台支持已断）
state.auth_token = auth_token.clone();
let state = Arc::new(state);

// r9(F1)：pid/token 落盘全部移到 bind 成功之后——双 daemon 并发启动（check_existing_instance 竞态窗口）时，
// 败者 bind EADDRINUSE 退出、不再覆盖胜者的 pid/token；此前 pid/token 先写后 bind，败者覆盖胜者文件 →
// 运行时 pid 文件指向死进程，MALONG_AUTH=1 时 token 文件可能指向败者 token → 客户端 hello 失败永久锁死
    // r31：SIGTERM 注册仅 Unix；Windows 无该信号语义（Ctrl+C 由 ctrl_c 分支覆盖）
    #[cfg(unix)]
    {
        use tokio::signal;
        tokio::spawn(async move {
            signal::unix::signal(signal::unix::SignalKind::terminate())
                .expect("failed to register SIGTERM")
                .recv()
                .await;
            info!("received SIGTERM, shutting down");
            log_crash(&format!("SIGTERM pid={}", std::process::id()), None);
            let _ = shutdown_tx.send(());
        });
    }

    info!("malong-parse v{} started, pid={}", env!("CARGO_PKG_VERSION"), std::process::id());

    #[cfg(unix)]
    {
        let listener = UnixListener::bind(&socket_path)?;
        // r8(F3)：chmod 必须在 bind 之后——对不存在的路径 set_permissions 静默失败，会按 umask 建出 775
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600));
        }
        // r9(F1)：bind 成功后才写 pid/token——双 daemon 竞态时败者 bind 失败退出不污染胜者文件
        write_pid_file()?;
        if let Some(t) = &auth_token {
            write_token_file(&socket_path, t);
            info!("socket auth enabled (MALONG_AUTH=1)");
        } else {
            // 删除残留 token 文件——防新客户端读到旧 token 发 hello 被拒（免认证模式 hello 亦应答 ok）
            let _ = std::fs::remove_file(format!("{}.token", socket_path.display()));
            info!("socket auth disabled (default); set MALONG_AUTH=1 to enable");
        }
        info!("listening on {:?} (0600)", socket_path);
        let state_clone = state.clone();
        let mut shutdown_rx = shutdown_rx;
        // r8(F2)：连接数上限——防 16MB×N 读缓冲 OOM
        let conn_sem = Arc::new(tokio::sync::Semaphore::new(16));
        loop {
            tokio::select! {
                accept_result = listener.accept() => {
                    match accept_result {
                        Ok((stream, _)) => {
                            let state = state_clone.clone();
                            let sem = conn_sem.clone();
                            tokio::spawn(async move {
                                if let Ok(permit) = tokio::sync::Semaphore::try_acquire_owned(sem) {
                                    server::handle_connection(stream, state).await;
                                    drop(permit);
                                } else {
                                    // r9(C1)：忙拒发错误帧再关——客户端据此区分「服务端拒」与「崩溃」（零数据关闭）
                                    let msg = serde_json::json!({"id": null, "error": {"code": "SERVER_BUSY", "message": "connection limit reached"}});
                                    if let Ok(frame) = crate::protocol::encode_frame(&msg) {
                                        let _ = tokio::time::timeout(std::time::Duration::from_millis(500), async {
                                            let _ = stream.writable().await;
                                            let _ = stream.try_write(&frame);
                                        }).await;
                                    }
                                }
                            });
                        }
                        Err(e) => { warn!("accept error: {}", e); }
                    }
                }
                _ = shutdown_rx.recv() => {
                    info!("shutdown signal received");
                    break;
                }
            }
        }
        let _ = std::fs::remove_file(&socket_path);
    }

    #[cfg(windows)]
    {
        use tokio::net::{TcpListener, TcpStream};
        // r9(B2)：TCP 模式无认证（无 socket/token 文件）——r8 的 __hello 认证不适用于 TCP，明确告警不静默
        if auth_enabled {
            warn!("MALONG_AUTH ignored: TCP mode has no socket auth (Windows/container); ensure 127.0.0.1 only");
        }
        let addr = get_listen_addr();
        let listener = TcpListener::bind(addr).await?;
        info!("listening on {} (TCP, no auth)", addr);
        let state_clone = state.clone();
        let mut shutdown_rx = shutdown_rx;
        loop {
            tokio::select! {
                accept_result = listener.accept() => {
                    match accept_result {
                        Ok((stream, _)) => {
                            let state = state_clone.clone();
                            tokio::spawn(async move {
                                server::handle_connection(stream, state).await;
                            });
                        }
                        Err(e) => { warn!("accept error: {}", e); }
                    }
                }
                _ = shutdown_rx.recv() => {
                    info!("shutdown signal received");
                    break;
                }
            }
        }
    }

    remove_pid_file();
    info!("malong-parse stopped");

    Ok(())
}

#[cfg(test)]
mod rotate_tests {
    use super::rotate_log_file;
    use super::rotation_interval_ms;
    use std::fs;
    use std::path::PathBuf;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "malong-rotate-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos()
        ));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn rotation_interval_default_and_override() {
        // env 隔离：测试前清理，结束后恢复默认（其他测试不读该 env，无并行竞争）
        std::env::remove_var("MALONG_LOG_ROTATE_INTERVAL_MS");
        assert_eq!(rotation_interval_ms(), 6 * 3600 * 1000, "默认 6 小时");
        std::env::set_var("MALONG_LOG_ROTATE_INTERVAL_MS", "1500");
        assert_eq!(rotation_interval_ms(), 1500, "env 覆盖生效");
        std::env::set_var("MALONG_LOG_ROTATE_INTERVAL_MS", "abc");
        assert_eq!(rotation_interval_ms(), 6 * 3600 * 1000, "非法值回落默认");
        std::env::remove_var("MALONG_LOG_ROTATE_INTERVAL_MS");
    }

    #[test]
    fn no_rotate_when_under_threshold() {
        let d = tmp_dir("under");
        let p = d.join("parse.log");
        fs::write(&p, "x".repeat(100)).unwrap();
        assert!(!rotate_log_file(&p, 200, 3));
        assert!(!d.join("parse.log.1").exists());
        assert!(fs::read_to_string(&p).unwrap().len() == 100);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn rotate_keeps_keep_copies() {
        let d = tmp_dir("rotate");
        let p = d.join("parse.log");
        fs::write(&p, "x".repeat(1000)).unwrap();
        fs::write(d.join("parse.log.1"), "old1").unwrap();
        fs::write(d.join("parse.log.2"), "old2").unwrap();
        fs::write(d.join("parse.log.3"), "old3").unwrap();
        assert!(rotate_log_file(&p, 100, 3));
        // 主文件 → .1，原 .1/.2 → .2/.3，原 .3 删除
        assert!(fs::read_to_string(d.join("parse.log.1")).unwrap().len() == 1000, "main -> .1");
        assert!(fs::read_to_string(d.join("parse.log.2")).unwrap() == "old1", ".1 -> .2");
        assert!(fs::read_to_string(d.join("parse.log.3")).unwrap() == "old2", ".2 -> .3");
        assert!(!d.join("parse.log.4").exists(), "old .3 dropped");
        assert!(!p.exists(), "main renamed away");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn keep_zero_is_noop() {
        let d = tmp_dir("keep0");
        let p = d.join("parse.log");
        fs::write(&p, "x".repeat(1000)).unwrap();
        assert!(!rotate_log_file(&p, 100, 0));
        assert!(p.exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn missing_file_and_directory_skipped() {
        let d = tmp_dir("missing");
        let p = d.join("no-such.log");
        assert!(!rotate_log_file(&p, 100, 3), "missing file noop");
        assert!(!rotate_log_file(&d, 100, 3), "directory noop");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn empty_rotation_chain() {
        let d = tmp_dir("chain");
        let p = d.join("parse.log");
        fs::write(&p, "x".repeat(500)).unwrap();
        assert!(rotate_log_file(&p, 100, 2));
        assert!(d.join("parse.log.1").exists());
        // 二次轮转：.1 存在时挤到 .2
        fs::write(&p, "y".repeat(500)).unwrap();
        assert!(rotate_log_file(&p, 100, 2));
        assert!(d.join("parse.log.2").exists(), ".1 promoted to .2 on second rotate");
        assert!(!d.join("parse.log.3").exists(), "no third copy");
        let _ = fs::remove_dir_all(&d);
    }
}
