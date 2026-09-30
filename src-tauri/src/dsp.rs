//! The "clean mic" processing chain. Everything runs at 48 kHz mono.
//!
//! high-pass -> AI denoise (RNNoise) -> voice gate -> auto gain -> EQ -> compressor -> limiter

use nnnoiseless::DenoiseState;
use serde::Deserialize;
use std::f32::consts::PI;

pub const SAMPLE_RATE: f32 = 48_000.0;
pub const FRAME: usize = DenoiseState::FRAME_SIZE; // 480 samples = 10 ms

fn db_to_lin(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

fn lin_to_db(x: f32) -> f32 {
    20.0 * x.max(1e-9).log10()
}

/// One-pole smoothing coefficient for a time constant in milliseconds (per sample).
fn coef(ms: f32) -> f32 {
    (-1.0 / (ms * 0.001 * SAMPLE_RATE)).exp()
}

// ---------------------------------------------------------------- biquad (RBJ cookbook)

#[derive(Clone, Copy)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    fn new(b0: f32, b1: f32, b2: f32, a0: f32, a1: f32, a2: f32) -> Self {
        Self { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, z1: 0.0, z2: 0.0 }
    }

    fn highpass(freq: f32, q: f32) -> Self {
        let w = 2.0 * PI * freq / SAMPLE_RATE;
        let (s, c) = w.sin_cos();
        let alpha = s / (2.0 * q);
        Self::new((1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0, 1.0 + alpha, -2.0 * c, 1.0 - alpha)
    }

    fn peaking(freq: f32, q: f32, gain_db: f32) -> Self {
        let a = 10f32.powf(gain_db / 40.0);
        let w = 2.0 * PI * freq / SAMPLE_RATE;
        let (s, c) = w.sin_cos();
        let alpha = s / (2.0 * q);
        Self::new(1.0 + alpha * a, -2.0 * c, 1.0 - alpha * a, 1.0 + alpha / a, -2.0 * c, 1.0 - alpha / a)
    }

    fn low_shelf(freq: f32, gain_db: f32) -> Self {
        let a = 10f32.powf(gain_db / 40.0);
        let w = 2.0 * PI * freq / SAMPLE_RATE;
        let (s, c) = w.sin_cos();
        let alpha = s / 2.0 * std::f32::consts::SQRT_2; // shelf slope 1
        let sa = 2.0 * a.sqrt() * alpha;
        Self::new(
            a * ((a + 1.0) - (a - 1.0) * c + sa),
            2.0 * a * ((a - 1.0) - (a + 1.0) * c),
            a * ((a + 1.0) - (a - 1.0) * c - sa),
            (a + 1.0) + (a - 1.0) * c + sa,
            -2.0 * ((a - 1.0) + (a + 1.0) * c),
            (a + 1.0) + (a - 1.0) * c - sa,
        )
    }

    /// Take new coefficients but keep the filter memory, so live tweaks don't click.
    fn retune(&mut self, other: Biquad) {
        let (z1, z2) = (self.z1, self.z2);
        *self = other;
        self.z1 = z1;
        self.z2 = z2;
    }

    fn high_shelf(freq: f32, gain_db: f32) -> Self {
        let a = 10f32.powf(gain_db / 40.0);
        let w = 2.0 * PI * freq / SAMPLE_RATE;
        let (s, c) = w.sin_cos();
        let alpha = s / 2.0 * std::f32::consts::SQRT_2; // shelf slope 1
        let sa = 2.0 * a.sqrt() * alpha;
        Self::new(
            a * ((a + 1.0) + (a - 1.0) * c + sa),
            -2.0 * a * ((a - 1.0) + (a + 1.0) * c),
            a * ((a + 1.0) + (a - 1.0) * c - sa),
            (a + 1.0) - (a - 1.0) * c + sa,
            2.0 * ((a - 1.0) - (a + 1.0) * c),
            (a + 1.0) - (a - 1.0) * c - sa,
        )
    }

    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        // transposed direct form II
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

// ---------------------------------------------------------------- user EQ

pub const EQ_BANDS: usize = 5;

/// One band of the user EQ. Band 0 is a low shelf, the last band a high shelf, the rest are bells.
#[derive(Clone, Copy, Deserialize)]
pub struct Band {
    pub freq: f32,
    pub gain: f32,
    pub q: f32,
}

fn band_filter(i: usize, b: &Band) -> Biquad {
    let freq = b.freq.clamp(20.0, 20_000.0);
    let gain = b.gain.clamp(-18.0, 18.0);
    match i {
        0 => Biquad::low_shelf(freq, gain),
        i if i == EQ_BANDS - 1 => Biquad::high_shelf(freq, gain),
        _ => Biquad::peaking(freq, b.q.clamp(0.2, 8.0), gain),
    }
}

/// "Natural" voice tuning: a little less mud, a little more presence and air.
pub const DEFAULT_EQ: [Band; EQ_BANDS] = [
    Band { freq: 100.0, gain: 0.0, q: 0.7 },
    Band { freq: 300.0, gain: -2.0, q: 1.0 },
    Band { freq: 1000.0, gain: 0.0, q: 1.0 },
    Band { freq: 3500.0, gain: 2.5, q: 0.8 },
    Band { freq: 8000.0, gain: 1.5, q: 0.7 },
];

// ---------------------------------------------------------------- chain

pub struct Settings {
    /// 0..1 — how hard background noise is pushed down between words.
    pub strength: f32,
    /// 0..1 — how loud the voice ends up (0.5 = normal).
    pub loudness: f32,
}

pub struct Chain {
    hpf: [Biquad; 2],
    denoise: Box<DenoiseState<'static>>,
    denoise_out: Vec<f32>,
    eq: [Biquad; EQ_BANDS],

    // voice gate
    gate_gain: f32,
    gate_hold: usize,
    vad_smooth: f32,
    noise_floor: f32, // tracked background level before denoising (linear RMS)

    // auto gain
    speech_level: f32, // running estimate of speech RMS (linear)
    agc_gain: f32,

    // compressor / limiter envelopes
    comp_env: f32,
    lim_gain: f32,
}

impl Chain {
    pub fn new() -> Self {
        Self {
            // 4th-order-ish rumble cut at 80 Hz
            hpf: [Biquad::highpass(80.0, 0.54), Biquad::highpass(80.0, 1.31)],
            denoise: DenoiseState::new(),
            denoise_out: vec![0.0; FRAME],
            eq: std::array::from_fn(|i| band_filter(i, &DEFAULT_EQ[i])),
            gate_gain: 0.0,
            gate_hold: 0,
            vad_smooth: 0.0,
            noise_floor: 0.0,
            speech_level: db_to_lin(-30.0),
            agc_gain: 1.0,
            comp_env: 0.0,
            lim_gain: 1.0,
        }
    }

    pub fn set_eq(&mut self, bands: &[Band; EQ_BANDS]) {
        for (i, (f, b)) in self.eq.iter_mut().zip(bands).enumerate() {
            f.retune(band_filter(i, b));
        }
    }

    /// Process exactly one FRAME of 48 kHz mono audio in place (samples in -1..1).
    /// Returns the voice-activity probability for the frame.
    pub fn process_frame(&mut self, buf: &mut [f32], s: &Settings) -> f32 {
        debug_assert_eq!(buf.len(), FRAME);

        // 1. high-pass, then scale to the i16 range RNNoise expects
        let mut energy = 0.0;
        for x in buf.iter_mut() {
            let mut y = *x;
            for f in self.hpf.iter_mut() {
                y = f.process(y);
            }
            energy += y * y;
            *x = y * 32768.0;
        }
        let level = (energy / FRAME as f32).sqrt().max(1e-7);

        // track the background level: falls fast, rises ~10 dB/s (so speech bursts barely move it)
        if self.noise_floor == 0.0 || level < self.noise_floor {
            self.noise_floor = if self.noise_floor == 0.0 { level } else { self.noise_floor * 0.8 + level * 0.2 };
        } else {
            self.noise_floor *= 1.0116;
        }

        // 2. AI noise suppression
        let vad = self.denoise.process_frame(&mut self.denoise_out, buf);
        for (x, y) in buf.iter_mut().zip(self.denoise_out.iter()) {
            *x = *y / 32768.0;
        }

        // 3. voice gate: RNNoise's voice detector AND clearly louder (+8 dB) than the background
        self.vad_smooth = self.vad_smooth * 0.6 + vad * 0.4;
        let talking = self.vad_smooth > 0.45 && level > self.noise_floor * db_to_lin(8.0);
        if talking {
            self.gate_hold = 25; // keep open 250 ms after speech ends
        } else if self.gate_hold > 0 {
            self.gate_hold -= 1;
        }
        let open = talking || self.gate_hold > 0;
        let floor = db_to_lin(-6.0 - 54.0 * s.strength.clamp(0.0, 1.0));
        let gate_target = if open { 1.0 } else { floor };
        let gate_c = if open { coef(4.0) } else { coef(120.0) };

        // 4. auto gain: learn speech loudness only while talking
        // target speech level: -30 dBFS (quiet) .. -24 (normal) .. -18 (loud)
        let target_rms = db_to_lin(-30.0 + 12.0 * s.loudness.clamp(0.0, 1.0));
        if talking {
            let rms = (buf.iter().map(|x| x * x).sum::<f32>() / FRAME as f32).sqrt();
            if rms > db_to_lin(-60.0) {
                // ~1.5 s memory, measured in frames of 10 ms
                self.speech_level = self.speech_level * 0.993 + rms * 0.007;
            }
        }
        let wanted = (target_rms / self.speech_level).clamp(db_to_lin(-12.0), db_to_lin(15.0));
        let agc_c = coef(400.0);

        // compressor: -18 dBFS threshold, 3:1 (tames peaks; auto gain already sets the level)
        let comp_thresh = -18.0;
        let comp_ratio = 3.0;
        let comp_att = coef(5.0);
        let comp_rel = coef(120.0);

        // limiter: never exceed -1 dBFS
        let ceiling = db_to_lin(-1.0);
        let lim_rel = coef(60.0);

        for x in buf.iter_mut() {
            self.gate_gain = gate_target + gate_c * (self.gate_gain - gate_target);
            self.agc_gain = wanted + agc_c * (self.agc_gain - wanted);
            let mut y = *x * self.gate_gain * self.agc_gain;

            // 5. EQ
            for f in self.eq.iter_mut() {
                y = f.process(y);
            }

            // 6. compressor (peak envelope, log-domain gain computer)
            let level = y.abs();
            let c = if level > self.comp_env { comp_att } else { comp_rel };
            self.comp_env = level + c * (self.comp_env - level);
            let over = lin_to_db(self.comp_env) - comp_thresh;
            let gr = if over > 0.0 { db_to_lin(-over * (1.0 - 1.0 / comp_ratio)) } else { 1.0 };
            y *= gr;

            // 7. limiter: instant attack, smooth release
            let peak = y.abs();
            let need = if peak > ceiling { ceiling / peak } else { 1.0 };
            let released = 1.0 + lim_rel * (self.lim_gain - 1.0);
            self.lim_gain = need.min(released);
            y *= self.lim_gain;

            *x = y.clamp(-1.0, 1.0);
        }

        vad
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic white noise in -amp..amp.
    fn noise(seed: &mut u32, amp: f32) -> f32 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 17;
        *seed ^= *seed << 5;
        (*seed as f32 / u32::MAX as f32 * 2.0 - 1.0) * amp
    }

    fn run(mut gen: impl FnMut(usize) -> f32, seconds: usize) -> Vec<f32> {
        let mut chain = Chain::new();
        let s = Settings { strength: 0.7, loudness: 0.5 };
        let mut out = Vec::new();
        let mut buf = vec![0.0; FRAME];
        for f in 0..seconds * 100 {
            for (i, x) in buf.iter_mut().enumerate() {
                *x = gen(f * FRAME + i);
            }
            chain.process_frame(&mut buf, &s);
            out.extend_from_slice(&buf);
        }
        out
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
    }

    #[test]
    fn background_noise_is_pushed_down() {
        let mut seed = 1;
        let out = run(|_| noise(&mut seed, 0.03), 3);
        let tail = &out[out.len() / 2..];
        assert!(tail.iter().all(|v| v.is_finite()));
        assert!(rms(tail) < 0.03 * 0.1, "noise rms {}", rms(tail));
    }

    #[test]
    fn loud_input_never_clips() {
        let mut seed = 7;
        let out = run(|i| (i as f32 * 0.05).sin() * 0.99 + noise(&mut seed, 0.3), 2);
        let peak = out.iter().fold(0f32, |m, v| m.max(v.abs()));
        assert!(out.iter().all(|v| v.is_finite()));
        assert!(peak <= db_to_lin(-1.0) + 1e-4, "peak {peak}");
    }

    #[test]
    fn silence_stays_silent() {
        let out = run(|_| 0.0, 1);
        assert!(out.iter().all(|v| v.abs() < 1e-6));
    }
}

