//! Audio engine: mic -> clean chain -> virtual cable (and optionally your headphones).
//!
//! cpal streams live on a dedicated thread; the UI talks to it through a channel and
//! reads meters from lock-free atomics.

use crate::dsp::{Band, Chain, Settings, DEFAULT_EQ, EQ_BANDS, FRAME, SAMPLE_RATE};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, FromSample, Sample, SampleFormat, SizedSample, Stream, StreamConfig};
use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};
use serde::Serialize;
use sonora::config::EchoCanceller;
use sonora::AudioProcessing;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};

// ---------------------------------------------------------------- shared state

struct AtomicF32(AtomicU32);

impl AtomicF32 {
    fn new(v: f32) -> Self {
        Self(AtomicU32::new(v.to_bits()))
    }
    fn load(&self) -> f32 {
        f32::from_bits(self.0.load(Ordering::Relaxed))
    }
    fn store(&self, v: f32) {
        self.0.store(v.to_bits(), Ordering::Relaxed)
    }
    fn take(&self) -> f32 {
        f32::from_bits(self.0.swap(0, Ordering::Relaxed))
    }
    fn raise(&self, v: f32) {
        if v > self.load() {
            self.store(v)
        }
    }
}

pub struct Shared {
    pub enabled: AtomicBool,
    pub echo: AtomicBool,
    echo_active: AtomicBool,
    strength: AtomicF32,
    loudness: AtomicF32,
    in_peak: AtomicF32,
    out_peak: AtomicF32,
    voice: AtomicF32,
    running: AtomicBool,
    error: Mutex<Option<String>>,
    eq: Mutex<[Band; EQ_BANDS]>,
    eq_version: AtomicU32,
}

#[derive(Serialize, Clone)]
pub struct Meter {
    pub input: f32,
    pub output: f32,
    pub voice: f32,
    pub running: bool,
    pub echo_active: bool,
    pub error: Option<String>,
}

impl Shared {
    pub fn set_strength(&self, v: f32) {
        self.strength.store(v.clamp(0.0, 1.0))
    }

    pub fn set_loudness(&self, v: f32) {
        self.loudness.store(v.clamp(0.0, 1.0))
    }

    pub fn set_eq(&self, bands: [Band; EQ_BANDS]) {
        *self.eq.lock().unwrap() = bands;
        self.eq_version.fetch_add(1, Ordering::Release);
    }

    pub fn meter(&self) -> Meter {
        Meter {
            input: self.in_peak.take(),
            output: self.out_peak.take(),
            voice: self.voice.load(),
            running: self.running.load(Ordering::Relaxed),
            echo_active: self.echo_active.load(Ordering::Relaxed),
            error: self.error.lock().unwrap().clone(),
        }
    }

    fn fail(&self, msg: String) {
        *self.error.lock().unwrap() = Some(msg);
    }
}

// ---------------------------------------------------------------- devices

#[derive(Serialize)]
pub struct Devices {
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    pub default_input: Option<String>,
    pub default_output: Option<String>,
}

pub fn list_devices() -> Devices {
    let host = cpal::default_host();
    let names = |it: Option<Vec<Device>>| -> Vec<String> {
        it.unwrap_or_default().iter().filter_map(|d| d.name().ok()).collect()
    };
    Devices {
        inputs: names(host.input_devices().ok().map(|d| d.collect())),
        outputs: names(host.output_devices().ok().map(|d| d.collect())),
        default_input: host.default_input_device().and_then(|d| d.name().ok()),
        default_output: host.default_output_device().and_then(|d| d.name().ok()),
    }
}

fn find(input: bool, name: &str) -> Result<Device, String> {
    let host = cpal::default_host();
    let mut devs: Box<dyn Iterator<Item = Device>> = if input {
        Box::new(host.input_devices().map_err(|e| e.to_string())?)
    } else {
        Box::new(host.output_devices().map_err(|e| e.to_string())?)
    };
    devs.find(|d| d.name().map(|n| n == name).unwrap_or(false))
        .ok_or_else(|| format!("Device not found: {name}"))
}

/// Prefer 48 kHz (no resampling needed) and f32; otherwise fall back to the device default.
fn pick_config(dev: &Device, input: bool) -> Result<(StreamConfig, SampleFormat), String> {
    let ranges: Vec<_> = if input {
        dev.supported_input_configs().map_err(|e| e.to_string())?.collect()
    } else {
        dev.supported_output_configs().map_err(|e| e.to_string())?.collect()
    };
    let want = cpal::SampleRate(SAMPLE_RATE as u32);
    let best = ranges
        .iter()
        .filter(|r| r.min_sample_rate() <= want && r.max_sample_rate() >= want)
        .max_by_key(|r| (r.sample_format() == SampleFormat::F32, std::cmp::Reverse(r.channels())));
    if let Some(r) = best {
        let c = r.with_sample_rate(want);
        return Ok((c.config(), c.sample_format()));
    }
    let c = if input { dev.default_input_config() } else { dev.default_output_config() }
        .map_err(|e| e.to_string())?;
    Ok((c.config(), c.sample_format()))
}

// ---------------------------------------------------------------- resampler

/// Tiny linear resampler; good enough for voice and only used when a device can't do 48 kHz.
struct Resampler {
    step: f64,
    pos: f64,
    prev: f32,
}

impl Resampler {
    fn new(from: u32, to: u32) -> Self {
        Self { step: from as f64 / to as f64, pos: 0.0, prev: 0.0 }
    }

    #[inline]
    fn push(&mut self, x: f32, out: &mut Vec<f32>) {
        if self.step == 1.0 {
            out.push(x);
            return;
        }
        while self.pos < 1.0 {
            out.push(self.prev + (x - self.prev) * self.pos as f32);
            self.pos += self.step;
        }
        self.pos -= 1.0;
        self.prev = x;
    }
}

// ---------------------------------------------------------------- processor (runs in the input callback)

struct Sink {
    rs: Resampler,
    prod: HeapProd<f32>,
    scratch: Vec<f32>,
}

struct Processor {
    shared: Arc<Shared>,
    chain: Chain,
    channels: usize,
    rs_in: Resampler,
    buf48: Vec<f32>,
    frame: Vec<f32>,
    raw: Vec<f32>,
    sinks: Vec<Sink>,
    eq_seen: u32,
    echo: Option<Echo>,
}

/// WebRTC AEC3 fed with what the speakers are playing (loopback capture).
struct Echo {
    apm: AudioProcessing,
    render: HeapCons<f32>,
    render_frame: Vec<f32>,
    render_out: Vec<f32>,
    capture_out: Vec<f32>,
}

impl Echo {
    fn new(render: HeapCons<f32>) -> Self {
        let apm = AudioProcessing::builder()
            .config(sonora::Config { echo_canceller: Some(EchoCanceller::default()), ..Default::default() })
            .capture_config(sonora::StreamConfig::new(SAMPLE_RATE as u32, 1))
            .render_config(sonora::StreamConfig::new(SAMPLE_RATE as u32, 1))
            .build();
        Self { apm, render, render_frame: vec![0.0; FRAME], render_out: vec![0.0; FRAME], capture_out: vec![0.0; FRAME] }
    }

    /// Remove speaker sound from one mic frame. Always runs so the filter stays adapted;
    /// `apply` decides whether the result is used.
    fn process(&mut self, frame: &mut [f32], apply: bool) {
        // Feed exactly one speaker frame per mic frame so the two stay in step.
        // Windows sends nothing while the speakers are silent, so fall back to zeros.
        let have = self.render.occupied_len();
        if have > FRAME * 20 {
            self.render.skip(have - FRAME * 2); // way behind: jump ahead, AEC3 re-finds the delay
        }
        if self.render.occupied_len() >= FRAME {
            self.render.pop_slice(&mut self.render_frame);
        } else {
            self.render_frame.fill(0.0);
        }
        let _ = self.apm.process_render_f32(&[&self.render_frame], &mut [&mut self.render_out]);
        if self.apm.process_capture_f32(&[frame], &mut [&mut self.capture_out]).is_ok() && apply {
            frame.copy_from_slice(&self.capture_out);
        }
    }
}

impl Processor {
    fn push<T>(&mut self, data: &[T])
    where
        T: SizedSample,
        f32: FromSample<T>,
    {
        for chunk in data.chunks(self.channels) {
            let mono = chunk.iter().map(|s| f32::from_sample(*s)).sum::<f32>() / self.channels as f32;
            self.rs_in.push(mono, &mut self.buf48);
        }

        let mut consumed = 0;
        while self.buf48.len() - consumed >= FRAME {
            self.frame.clear();
            self.frame.extend_from_slice(&self.buf48[consumed..consumed + FRAME]);
            consumed += FRAME;
            self.process_frame();
        }
        self.buf48.drain(..consumed);
    }

    fn process_frame(&mut self) {
        let sh = &self.shared;

        // pick up EQ changes from the UI without ever blocking the audio thread
        let v = sh.eq_version.load(Ordering::Acquire);
        if v != self.eq_seen {
            if let Ok(bands) = sh.eq.try_lock() {
                self.chain.set_eq(&bands);
                self.eq_seen = v;
            }
        }

        let in_peak = self.frame.iter().fold(0f32, |m, x| m.max(x.abs()));
        sh.in_peak.raise(in_peak);

        // Always run the chain so its state stays warm; bypass just outputs the raw mic.
        self.raw.clear();
        self.raw.extend_from_slice(&self.frame);
        if let Some(echo) = self.echo.as_mut() {
            echo.process(&mut self.frame, sh.echo.load(Ordering::Relaxed));
        }
        let settings = Settings { strength: sh.strength.load(), loudness: sh.loudness.load() };
        let vad = self.chain.process_frame(&mut self.frame, &settings);
        sh.voice.store(vad);
        let out: &[f32] = if sh.enabled.load(Ordering::Relaxed) { &self.frame } else { &self.raw };

        sh.out_peak.raise(out.iter().fold(0f32, |m, x| m.max(x.abs())));

        for sink in self.sinks.iter_mut() {
            sink.scratch.clear();
            for &x in out {
                sink.rs.push(x, &mut sink.scratch);
            }
            sink.prod.push_slice(&sink.scratch); // drops samples if the output fell behind
        }
    }
}

// ---------------------------------------------------------------- stream builders

fn build_input<T>(dev: &Device, cfg: &StreamConfig, mut p: Processor) -> Result<Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let sh = p.shared.clone();
    dev.build_input_stream(
        cfg,
        move |data: &[T], _| p.push(data),
        move |e| sh.fail(format!("Microphone error: {e}")),
        None,
    )
    .map_err(|e| e.to_string())
}

fn build_output<T>(
    dev: &Device,
    cfg: &StreamConfig,
    mut cons: HeapCons<f32>,
    shared: Arc<Shared>,
) -> Result<Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    let channels = cfg.channels as usize;
    let rate = cfg.sample_rate.0 as usize;
    let prefill = rate * 30 / 1000; // 30 ms cushion against jitter
    let max_fill = rate * 80 / 1000; // beyond this, drop audio to keep latency low
    let mut primed = false;
    dev.build_output_stream(
        cfg,
        move |data: &mut [T], _| {
            let have = cons.occupied_len();
            if !primed && have >= prefill {
                primed = true;
            }
            if have > max_fill {
                cons.skip(have - prefill);
            }
            for frame in data.chunks_mut(channels) {
                let v = if primed { cons.try_pop() } else { None };
                if v.is_none() {
                    primed = false; // underrun: wait to refill before playing again
                }
                let s = T::from_sample(v.unwrap_or(0.0));
                frame.iter_mut().for_each(|o| *o = s);
            }
        },
        move |e| shared.fail(format!("Output error: {e}")),
        None,
    )
    .map_err(|e| e.to_string())
}

fn build_loopback<T>(dev: &Device, cfg: &StreamConfig, mut prod: HeapProd<f32>) -> Result<Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = cfg.channels as usize;
    let mut rs = Resampler::new(cfg.sample_rate.0, SAMPLE_RATE as u32);
    let mut scratch = Vec::new();
    // cpal's WASAPI backend records an output device in loopback mode when opened as an input
    dev.build_input_stream(
        cfg,
        move |data: &[T], _| {
            scratch.clear();
            for chunk in data.chunks(channels) {
                let mono = chunk.iter().map(|s| f32::from_sample(*s)).sum::<f32>() / channels as f32;
                rs.push(mono, &mut scratch);
            }
            prod.push_slice(&scratch);
        },
        |_| {}, // losing the echo reference is not fatal
        None,
    )
    .map_err(|e| e.to_string())
}

/// Listen to what the default speakers play, as the echo canceller's reference.
fn open_loopback(output: &str) -> Result<(Stream, HeapCons<f32>), String> {
    let dev = cpal::default_host().default_output_device().ok_or("no speakers")?;
    if dev.name().map(|n| n == output).unwrap_or(true) {
        return Err("speakers are the clean-voice output".into());
    }
    let c = dev.default_output_config().map_err(|e| e.to_string())?;
    let cfg = c.config();
    let (prod, cons) = HeapRb::<f32>::new(SAMPLE_RATE as usize).split();
    let stream = match c.sample_format() {
        SampleFormat::F32 => build_loopback::<f32>(&dev, &cfg, prod),
        SampleFormat::I16 => build_loopback::<i16>(&dev, &cfg, prod),
        SampleFormat::I32 => build_loopback::<i32>(&dev, &cfg, prod),
        f => Err(format!("Unsupported loopback format {f:?}")),
    }?;
    Ok((stream, cons))
}

fn open_output(name: &str, shared: &Arc<Shared>) -> Result<(Stream, Sink), String> {
    let dev = find(false, name)?;
    let (cfg, fmt) = pick_config(&dev, false)?;
    let (prod, cons) = HeapRb::<f32>::new(cfg.sample_rate.0 as usize).split(); // 1 s capacity
    let sh = shared.clone();
    let stream = match fmt {
        SampleFormat::F32 => build_output::<f32>(&dev, &cfg, cons, sh),
        SampleFormat::I16 => build_output::<i16>(&dev, &cfg, cons, sh),
        SampleFormat::U16 => build_output::<u16>(&dev, &cfg, cons, sh),
        SampleFormat::I32 => build_output::<i32>(&dev, &cfg, cons, sh),
        f => Err(format!("Unsupported output format {f:?}")),
    }?;
    let sink = Sink { rs: Resampler::new(SAMPLE_RATE as u32, cfg.sample_rate.0), prod, scratch: Vec::new() };
    Ok((stream, sink))
}

fn open(input: &str, output: &str, monitor: Option<&str>, shared: &Arc<Shared>) -> Result<Vec<Stream>, String> {
    let mut streams = Vec::new();
    let mut sinks = Vec::new();

    let (s, k) = open_output(output, shared)?;
    streams.push(s);
    sinks.push(k);
    if let Some(m) = monitor.filter(|m| *m != output) {
        let (s, k) = open_output(m, shared)?;
        streams.push(s);
        sinks.push(k);
    }

    // Echo removal needs to hear the speakers. While "Hear myself" is on, the speakers carry
    // our own voice, so the canceller would erase it — skip it then.
    let echo = if monitor.is_none() {
        match open_loopback(output) {
            Ok((s, cons)) => {
                streams.push(s);
                shared.echo_active.store(true, Ordering::Relaxed);
                Some(Echo::new(cons))
            }
            Err(_) => None,
        }
    } else {
        None
    };

    let dev = find(true, input)?;
    let (cfg, fmt) = pick_config(&dev, true)?;
    let p = Processor {
        shared: shared.clone(),
        chain: Chain::new(),
        channels: cfg.channels as usize,
        rs_in: Resampler::new(cfg.sample_rate.0, SAMPLE_RATE as u32),
        buf48: Vec::with_capacity(FRAME * 8),
        frame: Vec::with_capacity(FRAME),
        raw: Vec::with_capacity(FRAME),
        sinks,
        eq_seen: u32::MAX, // forces the current EQ to load on the first frame
        echo,
    };
    let stream = match fmt {
        SampleFormat::F32 => build_input::<f32>(&dev, &cfg, p),
        SampleFormat::I16 => build_input::<i16>(&dev, &cfg, p),
        SampleFormat::U16 => build_input::<u16>(&dev, &cfg, p),
        SampleFormat::I32 => build_input::<i32>(&dev, &cfg, p),
        f => Err(format!("Unsupported mic format {f:?}")),
    }?;
    streams.push(stream);

    for s in &streams {
        s.play().map_err(|e| e.to_string())?;
    }
    Ok(streams)
}

// ---------------------------------------------------------------- engine handle

enum Cmd {
    Start { input: String, output: String, monitor: Option<String>, reply: Sender<Result<(), String>> },
    Stop,
}

pub struct Engine {
    tx: Mutex<Sender<Cmd>>,
    pub shared: Arc<Shared>,
}

impl Engine {
    pub fn new() -> Self {
        let shared = Arc::new(Shared {
            enabled: AtomicBool::new(true),
            echo: AtomicBool::new(true),
            echo_active: AtomicBool::new(false),
            strength: AtomicF32::new(0.7),
            loudness: AtomicF32::new(0.5),
            in_peak: AtomicF32::new(0.0),
            out_peak: AtomicF32::new(0.0),
            voice: AtomicF32::new(0.0),
            running: AtomicBool::new(false),
            error: Mutex::new(None),
            eq: Mutex::new(DEFAULT_EQ),
            eq_version: AtomicU32::new(0),
        });
        let (tx, rx) = channel::<Cmd>();
        let sh = shared.clone();
        std::thread::Builder::new()
            .name("audio-engine".into())
            .spawn(move || {
                let mut streams: Vec<Stream> = Vec::new();
                for cmd in rx {
                    streams.clear(); // dropping streams closes the devices
                    sh.running.store(false, Ordering::Relaxed);
                    sh.echo_active.store(false, Ordering::Relaxed);
                    *sh.error.lock().unwrap() = None;
                    if let Cmd::Start { input, output, monitor, reply } = cmd {
                        let res = open(&input, &output, monitor.as_deref(), &sh);
                        match res {
                            Ok(s) => {
                                streams = s;
                                sh.running.store(true, Ordering::Relaxed);
                                let _ = reply.send(Ok(()));
                            }
                            Err(e) => {
                                sh.fail(e.clone());
                                let _ = reply.send(Err(e));
                            }
                        }
                    }
                }
            })
            .expect("spawn audio thread");
        Self { tx: Mutex::new(tx), shared }
    }

    pub fn start(&self, input: String, output: String, monitor: Option<String>) -> Result<(), String> {
        let (reply, rx) = channel();
        self.tx
            .lock()
            .unwrap()
            .send(Cmd::Start { input, output, monitor, reply })
            .map_err(|e| e.to_string())?;
        rx.recv().map_err(|e| e.to_string())?
    }

    pub fn stop(&self) {
        let _ = self.tx.lock().unwrap().send(Cmd::Stop);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn echo_is_removed() {
        let (mut prod, cons) = HeapRb::<f32>::new(48_000).split();
        let mut echo = Echo::new(cons);
        let mut seed: u32 = 3;
        let mut speaker = Vec::new();
        let delay = 48 * 40; // 40 ms speaker -> mic path
        let (mut before, mut after) = (0.0f32, 0.0f32);
        for f in 0..600 {
            // speaker plays band-limited noise (smoothed white noise ~ speech-like spectrum)
            let mut frame = vec![0.0; FRAME];
            let mut prev = 0.0;
            for x in frame.iter_mut() {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                let w = seed as f32 / u32::MAX as f32 * 2.0 - 1.0;
                prev = prev * 0.7 + w * 0.3;
                *x = prev * 0.5;
            }
            speaker.extend_from_slice(&frame);
            prod.push_slice(&frame);

            // mic hears the speaker 40 ms later at half volume
            let start = (f * FRAME) as isize - delay as isize;
            let mut mic: Vec<f32> =
                (0..FRAME).map(|i| if start + (i as isize) >= 0 { speaker[start as usize + i] * 0.5 } else { 0.0 }).collect();
            if f >= 500 {
                before += mic.iter().map(|x| x * x).sum::<f32>();
            }
            echo.process(&mut mic, true);
            if f >= 500 {
                after += mic.iter().map(|x| x * x).sum::<f32>();
            }
        }
        let db = 10.0 * (after / before).log10();
        println!("echo reduced by {:.1} dB", -db);
        assert!(db < -15.0, "echo only reduced by {:.1} dB", -db);
    }
}
