// Downloads the VB-CABLE driver pack into src-tauri/vbcable/ so the installer can offer it.
// Runs automatically before `tauri dev` / `tauri build`. Skips if it's already there.
//
// VB-CABLE is made by VB-Audio (www.vb-cable.com) and is donationware. Bundling is allowed
// under https://vb-audio.com/Services/licensing.htm as long as users can see where it comes
// from and can donate, which the installer prompt and the app both say.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const URL = "https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip";
const SHA256 = "b950e39f01af1d04ea623c8f6d8eb9b6ea5c477c637295fabf20631c85116bfb";
const DEST = join(import.meta.dirname, "..", "src-tauri", "vbcable");

if (existsSync(join(DEST, "VBCABLE_Setup_x64.exe"))) process.exit(0);

console.log(`Downloading VB-CABLE from ${URL}`);
const res = await fetch(URL);
if (!res.ok) throw new Error(`VB-CABLE download failed: HTTP ${res.status}`);
const zip = Buffer.from(await res.arrayBuffer());

const hash = createHash("sha256").update(zip).digest("hex");
if (hash !== SHA256) {
  throw new Error(`VB-CABLE download has an unexpected checksum (${hash}). Update URL/SHA256 in this script.`);
}

const zipPath = join(tmpdir(), "vbcable-driver-pack.zip");
writeFileSync(zipPath, zip);
rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
execFileSync("powershell", [
  "-NoProfile",
  "-Command",
  `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${DEST}' -Force`,
], { stdio: "inherit" });
rmSync(zipPath, { force: true });
console.log(`VB-CABLE ready in ${DEST}`);
