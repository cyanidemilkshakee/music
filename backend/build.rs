use std::{env, fs, path::Path};

fn collect(dir: &Path, root: &Path, entries: &mut Vec<String>) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            collect(&path, root, entries)?;
        } else {
            let relative = path.strip_prefix(root).map_err(std::io::Error::other)?;
            let url = format!("/{}", relative.to_string_lossy().replace('\\', "/"));
            entries.push(format!(
                "({url:?}, include_bytes!({:?})),",
                path.to_string_lossy()
            ));
        }
    }
    Ok(())
}

fn main() -> std::io::Result<()> {
    let manifest = env::var("CARGO_MANIFEST_DIR").map_err(std::io::Error::other)?;
    let root = Path::new(&manifest).join("../public").canonicalize()?;
    println!("cargo:rerun-if-changed={}", root.display());
    let mut entries = Vec::new();
    collect(&root, &root, &mut entries)?;
    entries.sort();
    let output = Path::new(&env::var("OUT_DIR").map_err(std::io::Error::other)?).join("assets.rs");
    fs::write(
        output,
        format!(
            "static ASSETS: &[(&str, &[u8])] = &[{}];",
            entries.join("\n")
        ),
    )
}
