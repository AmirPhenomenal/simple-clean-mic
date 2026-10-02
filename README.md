<p align="center">
  <img src="ui/logo.png" width="96" alt="Clean Mic logo" />
</p>

<h1 align="center">Clean Mic</h1>

<p align="center">
  <b>Make any microphone sound clean on Windows. One click, no audio knowledge needed.</b><br />
  AI noise removal · voice gate · automatic volume · speaker-echo removal · simple EQ
</p>

<p align="center">
  <a href="https://github.com/AmirPhenomenal/simple-clean-mic/releases/latest"><b>⬇ Download for Windows</b></a>
</p>

---

Fans, keyboards, traffic, a loud room, a cheap headset: Clean Mic removes the noise around your
voice, evens out your volume and keeps it from ever clipping. Your clean voice is sent to
[VB-CABLE](https://vb-cable.com), a free virtual microphone, so **Discord, OBS, Zoom, Teams,
games and any other app** can use it like a normal mic.

Everything runs on your PC, in real time. No account, no cloud, no recording.

## Features

- **AI noise removal** - removes fans, keyboard clicks, hum and room noise
  ([RNNoise](https://jmvalin.ca/demo/rnnoise/)), with one slider for how strong it is.
- **Voice gate** - background sound is pushed down between your words, and opens instantly
  when you talk.
- **Automatic volume** - quiet or loud, you come out at a steady level. Choose how loud with
  one slider.
- **Never clips** - a compressor and limiter catch shouts and laughs.
- **Speaker-echo removal** - using speakers instead of headphones? Others won't hear
  themselves echo back (WebRTC AEC3).
- **Voice styles** - Natural, Warm, Crisp, Radio, Deep or Flat, plus Bass / Mid / Treble
  sliders and a drag-the-dots equalizer for fine-tuning.
- **Hear myself** - listen to your clean voice on your headphones.
- **Lives in the tray** - starts with Windows, keeps running when you close the window,
  and updates itself.
- **Low latency and light** - native Rust audio engine, a small download.

## Install

1. Download **`Clean.Mic_x.y.z_x64-setup.exe`** from the
   [latest release](https://github.com/AmirPhenomenal/simple-clean-mic/releases/latest) and run it.
2. The installer offers to install **VB-CABLE** if you don't have it yet. Say yes, then restart
   your PC.
3. In Discord, OBS, games, etc., choose **CABLE Output** as your microphone.

That's it. Clean Mic is now cleaning your voice.

> **Windows SmartScreen warning?** The installer isn't code-signed (that costs money every
> year), so Windows may say it "protected your PC". Click **More info → Run anyway**.
> The source code is all here if you want to check it.

## Using it

| Tab | What it does |
| --- | --- |
| **Voice** | Mic level meters, voice style, voice volume and Bass / Mid / Treble. |
| **Cleaning** | How strongly background noise is removed, and speaker-echo removal. |
| **Fine-tune** | Equalizer: drag a dot to shape your voice, scroll on it to make it wider or narrower, double-click to flatten it. |
| **Settings** | Which microphone to use, where to send the clean voice, start with Windows. |

The buttons at the bottom:

- **Big mic button** - turn cleaning on or off. Off means others hear your raw mic.
- **Left button** - quickly switch microphones.
- **Ear button** - "Hear myself": play your clean voice on your headphones.

Closing the window keeps Clean Mic running in the tray (bottom-right of the taskbar).
Right-click the tray icon to turn cleaning off or quit.

## Troubleshooting

**Others can't hear me.** In your chat or game app, the microphone must be **CABLE Output**
(not your real mic). In Clean Mic → Settings, "Send clean voice to" should be **CABLE Input**.

**"CABLE Input" isn't in the list.** VB-CABLE isn't installed yet, or Windows needs a restart
after installing it. Clean Mic shows an **Install VB-CABLE** button when it's missing.

**I hear an echo of myself.** Turn off the ear button ("Hear myself") when you don't need it.

**"Remove speaker echo" says it's paused.** It pauses while "Hear myself" is on, because it
would remove your own voice. If it says "not available", your speakers are the same device as
the clean-voice output.

**I unplugged my mic.** Clean Mic notices and restarts on its own once a mic is available.

## How it works

```
mic ─► high-pass ─► AI denoise ─► echo removal ─► voice gate ─► auto volume ─► EQ ─► compressor ─► limiter ─► VB-CABLE
                     (RNNoise)      (AEC3)                                                                   └─► headphones (optional)
```

Audio is processed at 48 kHz in 10 ms frames on a dedicated audio thread. The UI only sends
settings and reads level meters, so it can never stall your voice.

Built with [Tauri 2](https://tauri.app) (Rust + a plain HTML/JS interface),
[cpal](https://github.com/RustAudio/cpal) for audio devices,
[nnnoiseless](https://github.com/jneem/nnnoiseless) (RNNoise in Rust) and
[sonora](https://crates.io/crates/sonora) (WebRTC audio processing).

## Development

Needs [Rust](https://rustup.rs) (MSVC toolchain), Node.js 20+, and the Visual Studio Build Tools
("Desktop development with C++"). Build from PowerShell.

```powershell
npm install
npm run dev     # run the app
npm run build   # build the installer (src-tauri/target/release/bundle/nsis/)
cd src-tauri; cargo test --release   # DSP and echo-removal tests
```

The first `dev`/`build` downloads the VB-CABLE driver pack into `src-tauri/vbcable/`
(checksum-verified, not committed).

`npm run build` signs the update files, so it needs the updater key in the environment:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw "$HOME\.tauri\clean-mic.key"
npm run build
```

### Project layout

| Path | What's there |
| --- | --- |
| `src-tauri/src/dsp.rs` | The cleaning chain: filters, denoise, gate, auto gain, EQ, compressor, limiter. |
| `src-tauri/src/audio.rs` | Audio engine: devices, streams, resampling, echo removal. |
| `src-tauri/src/main.rs` | App shell: commands for the UI, tray, autostart, updater. |
| `ui/` | The interface (`index.html`, `main.js`, `style.css`). |
| `scripts/` | VB-CABLE download and release helper. |

## Releasing

Versions follow [semver](https://semver.org). Bump, commit and tag in one step, then push the tag:

```powershell
npm run release patch   # or minor / major / 1.2.3
git push --follow-tags
```

GitHub Actions then runs the tests, builds the installer and creates a **draft** release with
the installer and `latest.json` (used by the auto-updater). Check it and click **Publish**.
Installed apps pick up the update once the release is published.

**One-time setup:** add the repo secret `TAURI_SIGNING_PRIVATE_KEY` (contents of
`~/.tauri/clean-mic.key`) under **Settings → Secrets and variables → Actions**. The matching
public key is in `src-tauri/tauri.conf.json`. Keep the private key backed up: if it's lost,
installed copies can no longer verify updates.

## Credits

- VB-CABLE is made by VB-Audio ([www.vb-cable.com](https://vb-cable.com)). It is donationware,
  all participations are welcome.
- [RNNoise](https://jmvalin.ca/demo/rnnoise/) by Jean-Marc Valin, via nnnoiseless.
- WebRTC audio processing (AEC3), via sonora.
- [Manrope](https://github.com/sharanda/manrope) font (SIL Open Font License).

## License

[MIT](LICENSE)
