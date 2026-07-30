use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::UnixListener;
use tokio::signal;
use tokio::sync::broadcast;
use tracing::{info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod protocol;
mod parser_pool;
mod server;
mod extract;
mod simplify;
mod classify;
mod cache;

fn get_socket_path() -> PathBuf {
    let uid = unsafe { libc::getuid() };
    PathBuf::from(format!("/tmp/malong-parse-{}.sock", uid))
}

fn get_pid_path() -> PathBuf {
    let uid = unsafe { libc::getuid() };
    PathBuf::from(format!("/tmp/malong-parse-{}.pid", uid))
}

fn get_data_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(format!("{}/.local/share/malong", home))
}

fn write_pid_file() -> std::io::Result<()> {
    let pid_path = get_pid_path();
    let pid = std::process::id();
    std::fs::write(&pid_path, pid.to_string())?;
    info!("wrote PID {} to {:?}", pid, pid_path);
    Ok(())
}

fn remove_pid_file() {
    let pid_path = get_pid_path();
    let _ = std::fs::remove_file(&pid_path);
}

fn check_existing_instance() -> bool {
    let pid_path = get_pid_path();
    if let Ok(content) = std::fs::read_to_string(&pid_path) {
        if let Ok(pid) = content.trim().parse::<u32>() {
            if unsafe { libc::kill(pid as i32, 0) } == 0 {
                return true;
            }
        }
    }
    false
}

fn setup_crash_log() -> PathBuf {
    let data_dir = get_data_dir();
    let _ = std::fs::create_dir_all(&data_dir);
    data_dir.join("parse-crash.log")
}

fn log_crash(msg: &str, context: Option<&str>) {
    let crash_log = setup_crash_log();
    
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

    let socket_path = get_socket_path();
    let _ = std::fs::remove_file(&socket_path);

    let listener = UnixListener::bind(&socket_path)?;
    std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))?;
    info!("listening on {:?} (0600)", socket_path);

    write_pid_file()?;

    let state = Arc::new(server::ServerState::new());
    let (shutdown_tx, _) = broadcast::channel::<()>(1);
    let shutdown_rx = shutdown_tx.subscribe();

    let state_clone = state.clone();
    let shutdown_tx_clone = shutdown_tx.clone();
    tokio::spawn(async move {
        signal::ctrl_c().await.ok();
        info!("received Ctrl+C, shutting down");
        log_crash(&format!("shutdown pid={}", std::process::id()), None);
        let _ = shutdown_tx_clone.send(());
    });

    tokio::spawn(async move {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to register SIGTERM")
            .recv()
            .await;
        info!("received SIGTERM, shutting down");
        log_crash(&format!("SIGTERM pid={}", std::process::id()), None);
        let _ = shutdown_tx.send(());
    });

    info!("malong-parse v{} started, pid={}", env!("CARGO_PKG_VERSION"), std::process::id());

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
                    Err(e) => {
                        warn!("accept error: {}", e);
                    }
                }
            }
            _ = shutdown_rx.recv() => {
                info!("shutdown signal received");
                break;
            }
        }
    }

    let _ = std::fs::remove_file(&socket_path);
    remove_pid_file();
    info!("malong-parse stopped");

    Ok(())
}
