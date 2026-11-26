fn main() {
  println!("cargo:rerun-if-changed=icons/icon.ico");
  println!("cargo:rerun-if-changed=icons/128x128@2x.png");
  tauri_build::build()
}
