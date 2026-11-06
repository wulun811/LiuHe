// build.rs — 构建期把 git commit 注入二进制（health RPC 的 build_commit 字段）
//
// 2026-11-02 DSH 复验：解析器 daemon 自报的 build_commit 恒为 "unknown"。
// 因为 src/server.rs 用的是 option_env!("MALONG_GIT_COMMIT")，而构建时没人设这个变量。
// 一个恒为 "unknown" 的身份字段比没有更坏：看起来像值，又永远判不出来。
//
// 注入优先级：环境变量 MALONG_GIT_COMMIT > git rev-parse > "unknown"（源码包 / 无 .git）。
// 同时监看 git 的 HEAD 与当前分支 ref，否则「提交变了但 build.rs 没变」会嵌入旧 commit。
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=MALONG_GIT_COMMIT");

    if let Ok(v) = std::env::var("MALONG_GIT_COMMIT") {
        println!("cargo:rustc-env=MALONG_GIT_COMMIT={}", v.trim());
        return;
    }

    // 让 cargo 在 commit 变化时重跑本脚本（.git 可能在上层目录）
    if let Some(git_dir) = git(&["rev-parse", "--git-dir"]) {
        println!("cargo:rerun-if-changed={}/HEAD", git_dir);
        if let Some(refname) = git(&["symbolic-ref", "-q", "HEAD"]) {
            println!("cargo:rerun-if-changed={}/{}", git_dir, refname);
        }
    }

    let commit = git(&["rev-parse", "--short=12", "HEAD"]).unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=MALONG_GIT_COMMIT={}", commit);
}

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}
