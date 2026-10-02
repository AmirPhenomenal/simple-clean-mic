# Contributing to Clean Mic

Thanks for helping! Clean Mic is a small project, so every bug report, idea and pull request
makes a real difference.

## Ways to help

- **Report a bug** or **suggest a feature** with the [issue templates](https://github.com/AmirPhenomenal/simple-clean-mic/issues/new/choose).
- **Share how it sounds** with your mic and setup in [Discussions](https://github.com/AmirPhenomenal/simple-clean-mic/discussions).
- **Pick up an issue** labeled [good first issue](https://github.com/AmirPhenomenal/simple-clean-mic/labels/good%20first%20issue)
  or [help wanted](https://github.com/AmirPhenomenal/simple-clean-mic/labels/help%20wanted).
  Comment on it so nobody else works on the same thing.
- **Star the repo** so more people find it.

## Setup

You need Windows 10/11, [Rust](https://rustup.rs) (MSVC toolchain), Node.js 20+ and the
Visual Studio Build Tools ("Desktop development with C++"). Use PowerShell.

```powershell
git clone https://github.com/AmirPhenomenal/simple-clean-mic
cd simple-clean-mic
npm install
npm run dev
```

Run the tests before opening a PR:

```powershell
cd src-tauri
cargo test --release
```

## Where things are

| Path | What's there |
| --- | --- |
| `src-tauri/src/dsp.rs` | The cleaning chain (filters, RNNoise, gate, auto gain, EQ, compressor, limiter). |
| `src-tauri/src/audio.rs` | Devices, streams, resampling, echo removal. Runs on the real-time audio thread. |
| `src-tauri/src/main.rs` | Tauri commands, tray, autostart, updater. |
| `ui/` | Plain HTML/CSS/JS interface, no framework or build step. |

## Guidelines

- **Keep it simple for normal users.** Clean Mic is for people who don't know audio. New
  options need a plain-English name and a sensible default; prefer fewer, smarter settings.
- **Never block the audio thread.** No locks that can wait, no allocation, no I/O in the
  audio callbacks. Use the atomics in `Shared` (see `audio.rs`).
- **Match the surrounding style.** Small functions, short comments explaining *why*.
  Run `cargo fmt` on Rust code.
- **Add a test** for DSP changes when you can (see the tests at the bottom of `dsp.rs`).
- **One change per PR**, with a short description of what you changed and how you tested it.
  Before/after audio clips are great for sound changes.

By contributing you agree that your work is licensed under the project's [MIT license](LICENSE).
