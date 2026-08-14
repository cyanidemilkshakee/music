use std::process::Command;

fn main() {
    let output = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .unwrap_or_else(|| "unknown".to_string());
        
    println!("cargo:rustc-env=GIT_REVISION={}", output.trim());
    
    println!("cargo:rerun-if-changed=src/db/schema.sql");
}
