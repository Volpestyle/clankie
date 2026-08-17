use openh264::decoder::Decoder;
use openh264_sys2::{
    DECODER_OPTION_ERROR_CON_IDC, DECODING_STATE, SBufferInfo, dsDataErrorConcealed, dsErrorFree,
    dsNoParamSets, dsRefLost,
};
use std::os::raw::c_int;
use std::ptr::{addr_of_mut, from_mut, null_mut};
use tokio::time;
use tracing::{info, warn};

/// Metadata for a successfully decoded picture.
///
/// The RGB pixels stay in the decoder's reusable internal buffer; call
/// [`PersistentVideoDecoder::encode_jpeg`] to produce the JPEG only after the
/// caller's fps gate has decided the frame should actually be emitted, so
/// rate-limited frames never pay the JPEG encode cost.
pub(crate) struct DecodedFrame {
    pub(crate) width: u32,
    pub(crate) height: u32,
    /// Instantaneous normalized luma diff (0.0–1.0) between this frame and the
    /// previous one, computed on a coarse 64×36 grid.  0.0 = identical,
    /// 1.0 = every sampled pixel changed by maximum amount.
    pub(crate) change_score: f32,
    /// EMA-smoothed change score.  Rises when sustained visual change occurs
    /// across multiple consecutive frames; filters out single-frame noise
    /// (compression shimmer, cursor blink, HUD animation).
    pub(crate) ema_change_score: f32,
    /// True when the instantaneous change score is high enough to indicate a
    /// hard cut (scene change, app switch, new page load, etc.).
    pub(crate) is_scene_cut: bool,
}

// ── Frame-diff constants ────────────────────────────────────────────────

/// Coarse-grid dimensions used for luma diff sampling.
/// 64×36 = 2 304 samples — cheap enough to run every frame while capturing
/// meaningful spatial structure.
const DIFF_GRID_W: usize = 64;
const DIFF_GRID_H: usize = 36;
const DIFF_GRID_SIZE: usize = DIFF_GRID_W * DIFF_GRID_H;

/// EMA decay factor.  0.35 means each new frame contributes 35 % and history
/// contributes 65 %.  At 2 fps this gives a ~1.5 s smoothing window.
const EMA_ALPHA: f32 = 0.35;

/// Instantaneous diff above this is classified as a scene cut.
const SCENE_CUT_THRESHOLD: f32 = 0.40;

/// DECODING_STATE bitmask for states where the decoder may have produced a
/// usable frame (even if concealed or with lost references).  We accept
/// these and check `iBufferStatus` to see if YUV data is actually present.
const ACCEPTABLE_DECODE_STATES: DECODING_STATE = dsErrorFree | dsDataErrorConcealed | dsRefLost;

/// Persistent H264 decoder that accumulates codec state across frames.
///
/// Uses the OpenH264 raw API directly to bypass the Rust wrapper's strict
/// error handling, which treats `dsDataErrorConcealed` (error concealment
/// applied) as a fatal error even though the decoder produced valid output.
///
/// With error concealment enabled, the decoder can produce frames from
/// P-frames (NAL type 1) even without a prior IDR keyframe — the missing
/// reference data is concealed (green/grey initially, converging to correct
/// output as more P-frames arrive).
pub(crate) struct PersistentVideoDecoder {
    decoder: Decoder,
    jpeg_quality: i32,
    frames_decoded: u64,
    decode_errors: u64,
    consecutive_errors: u32,
    last_reset_at: Option<time::Instant>,
    /// Frames decoded since the last reset (or since creation if never
    /// reset).  Used to determine whether the decoder needs a fresh
    /// keyframe via PLI after a reset event.
    frames_decoded_since_reset: u64,
    /// Set to `true` after `try_reset` succeeds.  Cleared once the caller
    /// has had a chance to act on it (send PLI).
    reset_pending_pli: bool,
    /// Reusable RGB buffer to avoid per-frame allocation.
    rgb_buf: Vec<u8>,

    // ── Frame-diff state ────────────────────────────────────────────
    /// Coarse luma grid from the previously decoded frame.
    prev_luma_grid: Vec<u8>,
    /// EMA-smoothed change score, persists across frames.
    ema_change: f32,
}

/// Configure error concealment on an OpenH264 decoder.
///
/// ERROR_CON_SLICE_COPY_CROSS_IDR (4): copies slices across IDR
/// boundaries, allowing the decoder to produce (potentially concealed)
/// output instead of refusing with error 18 when reference frames are
/// missing.
#[allow(unsafe_code)]
fn configure_error_concealment(decoder: &mut Decoder) {
    let mut ec_idc: i32 = 4; // ERROR_CON_SLICE_COPY_CROSS_IDR
    unsafe {
        let _ = decoder
            .raw_api()
            .set_option(DECODER_OPTION_ERROR_CON_IDC, addr_of_mut!(ec_idc).cast());
    }
}

#[allow(unsafe_code)]
impl PersistentVideoDecoder {
    pub(crate) fn new() -> Result<Self, openh264::Error> {
        let mut decoder = Decoder::new()?;
        configure_error_concealment(&mut decoder);

        Ok(Self {
            decoder,
            jpeg_quality: 75,
            frames_decoded: 0,
            decode_errors: 0,
            consecutive_errors: 0,
            last_reset_at: None,
            frames_decoded_since_reset: 0,
            reset_pending_pli: false,
            rgb_buf: Vec::new(),
            prev_luma_grid: Vec::new(),
            ema_change: 0.0,
        })
    }

    /// Update the JPEG compression quality used when encoding decoded frames.
    /// Clamped to 10..=100.
    pub(crate) fn set_jpeg_quality(&mut self, quality: i32) {
        self.jpeg_quality = quality.clamp(10, 100);
    }

    /// Feed a raw Annex-B access unit to the persistent decoder.
    ///
    /// Returns `Some(DecodedFrame)` when a picture is produced.
    ///
    /// Uses the OpenH264 raw C API directly because the Rust wrapper
    /// (`openh264` crate) treats `dsDataErrorConcealed` as a fatal error,
    /// but it actually means "decoded with concealment applied" — the
    /// decoder produced valid YUV output that we should use.
    pub(crate) fn decode_frame(&mut self, annexb_frame: &[u8]) -> Option<DecodedFrame> {
        if annexb_frame.is_empty() {
            return None;
        }

        let mut dst = [null_mut::<u8>(); 3];
        let mut buffer_info = SBufferInfo::default();

        // Call the raw C API directly, bypassing the Rust wrapper's
        // `.ok()` which rejects any non-zero DECODING_STATE.
        let state: DECODING_STATE = unsafe {
            self.decoder.raw_api().decode_frame_no_delay(
                annexb_frame.as_ptr(),
                annexb_frame.len() as c_int,
                from_mut(&mut dst).cast(),
                &raw mut buffer_info,
            )
        };

        // Check if the state indicates a usable frame was produced.
        // dsErrorFree (0), dsDataErrorConcealed (32), dsRefLost (2),
        // and combinations thereof are acceptable — the decoder may
        // have produced YUV output.  Other states (dsBitstreamError,
        // dsNoParamSets, etc.) are genuine failures.
        let state_acceptable =
            (state & !ACCEPTABLE_DECODE_STATES) == 0 && state != dsNoParamSets as DECODING_STATE;

        if !state_acceptable {
            self.decode_errors += 1;
            self.consecutive_errors += 1;
            if self.consecutive_errors <= 5 || self.consecutive_errors.is_multiple_of(100) {
                warn!(
                    consecutive_errors = self.consecutive_errors,
                    total_errors = self.decode_errors,
                    frames_decoded = self.frames_decoded,
                    decode_state = state,
                    "clankvox_openh264_decode_error"
                );
            }
            if self.consecutive_errors >= 50 {
                self.try_reset();
            }
            return None;
        }

        // Even with an acceptable state, the decoder might not have
        // produced a frame yet (e.g., SPS/PPS only).  Check buffer status.
        if buffer_info.iBufferStatus == 0 {
            // No frame produced — parameter sets ingested or buffering.
            self.consecutive_errors = 0;
            return None;
        }

        // Validate YUV plane pointers.
        if dst[0].is_null() || dst[1].is_null() || dst[2].is_null() {
            warn!("clankvox_openh264_null_yuv_pointers");
            return None;
        }

        // Extract frame dimensions from the buffer info.
        let sys_buf = unsafe { buffer_info.UsrData.sSystemBuffer };
        let width = sys_buf.iWidth as usize;
        let height = sys_buf.iHeight as usize;
        let y_stride = sys_buf.iStride[0] as usize;
        let uv_stride = sys_buf.iStride[1] as usize;

        if width == 0 || height == 0 || y_stride == 0 || uv_stride == 0 {
            warn!(
                width,
                height, y_stride, uv_stride, "clankvox_openh264_zero_dimension_frame"
            );
            return None;
        }

        self.frames_decoded += 1;
        self.frames_decoded_since_reset += 1;
        self.consecutive_errors = 0;

        // Convert YUV420 to RGB directly from the raw plane pointers.
        let rgb_len = width * height * 3;
        self.rgb_buf.resize(rgb_len, 0);

        // YUV420 chroma planes cover ceil(height/2) rows — an odd-height
        // frame still carries a chroma row for its final luma row.  Sizing
        // with height/2 would make the last luma row index one chroma row
        // past the slice and panic.
        let uv_rows = height.div_ceil(2);
        unsafe {
            let y_plane = std::slice::from_raw_parts(dst[0], height * y_stride);
            let u_plane = std::slice::from_raw_parts(dst[1], uv_rows * uv_stride);
            let v_plane = std::slice::from_raw_parts(dst[2], uv_rows * uv_stride);
            yuv420_to_rgb(
                y_plane,
                u_plane,
                v_plane,
                width,
                height,
                y_stride,
                uv_stride,
                &mut self.rgb_buf,
            );
        }

        // ── Coarse luma diff ─────────────────────────────────────
        let (change_score, ema_change_score, is_scene_cut) = self.compute_change(width, height);

        Some(DecodedFrame {
            width: width as u32,
            height: height as u32,
            change_score,
            ema_change_score,
            is_scene_cut,
        })
    }

    /// Compute a coarse luma diff between the current `rgb_buf` and the
    /// previous frame's luma grid.  Updates internal EMA and prev grid.
    ///
    /// Returns `(instantaneous_score, ema_score, is_scene_cut)`.
    /// First frame always returns (0.0, 0.0, false) because there is no
    /// previous frame to compare against.
    fn compute_change(&mut self, width: usize, height: usize) -> (f32, f32, bool) {
        // Build a coarse luma grid by sampling the RGB buffer at evenly
        // spaced grid points.  Luma ≈ 0.299 R + 0.587 G + 0.114 B, but
        // integer approximation (77 R + 150 G + 29 B) >> 8 is plenty.
        let mut grid = vec![0u8; DIFF_GRID_SIZE];
        for gy in 0..DIFF_GRID_H {
            let src_y = (gy * height) / DIFF_GRID_H;
            for gx in 0..DIFF_GRID_W {
                let src_x = (gx * width) / DIFF_GRID_W;
                let idx = (src_y * width + src_x) * 3;
                if idx + 2 < self.rgb_buf.len() {
                    let r = self.rgb_buf[idx] as u32;
                    let g = self.rgb_buf[idx + 1] as u32;
                    let b = self.rgb_buf[idx + 2] as u32;
                    grid[gy * DIFF_GRID_W + gx] = ((77 * r + 150 * g + 29 * b) >> 8) as u8;
                }
            }
        }

        // Compare against previous grid.
        let change_score = if self.prev_luma_grid.len() == DIFF_GRID_SIZE {
            let mut total_diff: u64 = 0;
            for i in 0..DIFF_GRID_SIZE {
                let diff = (grid[i] as i16 - self.prev_luma_grid[i] as i16).unsigned_abs() as u64;
                total_diff += diff;
            }
            // Normalize: max possible diff per sample is 255.
            (total_diff as f64 / (DIFF_GRID_SIZE as f64 * 255.0)) as f32
        } else {
            // First frame — no previous data to compare.
            0.0
        };

        // Update EMA.
        self.ema_change = EMA_ALPHA * change_score + (1.0 - EMA_ALPHA) * self.ema_change;

        let is_scene_cut = change_score >= SCENE_CUT_THRESHOLD;

        // Store current grid as previous for next frame.
        self.prev_luma_grid = grid;

        (change_score, self.ema_change, is_scene_cut)
    }

    /// Encode the most recently decoded frame (held in the internal RGB
    /// buffer) to JPEG.  `width`/`height` must come from the
    /// [`DecodedFrame`] returned by the matching `decode_frame` call.
    pub(crate) fn encode_jpeg(&self, width: u32, height: u32) -> Option<Vec<u8>> {
        let image = turbojpeg::Image {
            pixels: self.rgb_buf.as_slice(),
            width: width as usize,
            pitch: width as usize * 3,
            height: height as usize,
            format: turbojpeg::PixelFormat::RGB,
        };
        turbojpeg::compress(image, self.jpeg_quality, turbojpeg::Subsamp::Sub2x2)
            .map_err(|e| {
                warn!("turbojpeg compress error: {e}");
                e
            })
            .ok()
            .map(|output| output.to_vec())
    }

    fn try_reset(&mut self) {
        let now = time::Instant::now();
        if let Some(last) = self.last_reset_at
            && now.duration_since(last) < std::time::Duration::from_secs(5)
        {
            return;
        }
        info!(
            consecutive_errors = self.consecutive_errors,
            total_errors = self.decode_errors,
            frames_decoded = self.frames_decoded,
            frames_decoded_since_reset = self.frames_decoded_since_reset,
            "clankvox_openh264_decoder_reset"
        );
        match Decoder::new() {
            Ok(mut decoder) => {
                configure_error_concealment(&mut decoder);
                self.decoder = decoder;
                self.consecutive_errors = 0;
                self.frames_decoded_since_reset = 0;
                self.reset_pending_pli = true;
                self.prev_luma_grid.clear();
                self.ema_change = 0.0;
                self.last_reset_at = Some(now);
            }
            Err(e) => warn!("clankvox_openh264_decoder_reset_failed: {e}"),
        }
    }

    pub(crate) fn frames_decoded(&self) -> u64 {
        self.frames_decoded
    }

    /// Consume and return the pending PLI flag.  Returns `true` exactly
    /// once after each decoder reset so the caller can send a PLI/FIR to
    /// request a fresh keyframe from the sender.
    pub(crate) fn take_pending_pli(&mut self) -> bool {
        let pending = self.reset_pending_pli;
        self.reset_pending_pli = false;
        pending
    }
}

/// Convert YUV420 planar data to packed RGB8.
///
/// This is a simple scalar conversion — adequate for the 2 fps screen
/// capture rate.  For higher throughput, SIMD or GPU conversion would
/// be needed.
fn yuv420_to_rgb(
    y_plane: &[u8],
    u_plane: &[u8],
    v_plane: &[u8],
    width: usize,
    height: usize,
    y_stride: usize,
    uv_stride: usize,
    rgb: &mut [u8],
) {
    // Clamp chroma indices to the smaller of the two chroma planes so a
    // decoder that hands us undersized planes degrades to repeating the last
    // chroma row/column instead of panicking on an out-of-bounds index.
    let uv_len = u_plane.len().min(v_plane.len());
    let max_uv_row = (uv_len / uv_stride).saturating_sub(1);
    let max_uv_col = uv_stride - 1;
    for row in 0..height {
        for col in 0..width {
            let y_idx = row * y_stride + col;
            let uv_row = (row / 2).min(max_uv_row);
            let uv_col = (col / 2).min(max_uv_col);
            let uv_idx = uv_row * uv_stride + uv_col;

            let y = y_plane[y_idx] as f32;
            let u = u_plane[uv_idx] as f32 - 128.0;
            let v = v_plane[uv_idx] as f32 - 128.0;

            let r = (y + 1.402 * v).clamp(0.0, 255.0) as u8;
            let g = (y - 0.344136 * u - 0.714136 * v).clamp(0.0, 255.0) as u8;
            let b = (y + 1.772 * u).clamp(0.0, 255.0) as u8;

            let rgb_idx = (row * width + col) * 3;
            rgb[rgb_idx] = r;
            rgb[rgb_idx + 1] = g;
            rgb[rgb_idx + 2] = b;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{PersistentVideoDecoder, yuv420_to_rgb};

    #[test]
    fn decoder_initializes_successfully() {
        let decoder = PersistentVideoDecoder::new();
        assert!(decoder.is_ok());
        let decoder = decoder.unwrap();
        assert_eq!(decoder.frames_decoded(), 0);
        assert!(!decoder.reset_pending_pli);
    }

    #[test]
    fn decoder_handles_empty_input_gracefully() {
        let mut decoder = PersistentVideoDecoder::new().unwrap();
        let result = decoder.decode_frame(&[]);
        assert!(result.is_none());
        assert_eq!(decoder.frames_decoded(), 0);
    }

    #[test]
    fn decoder_handles_garbage_input_without_panic() {
        let mut decoder = PersistentVideoDecoder::new().unwrap();
        let garbage = vec![0x00, 0x00, 0x00, 0x01, 0xFF, 0xAB, 0xCD, 0xEF];
        let result = decoder.decode_frame(&garbage);
        assert!(result.is_none());
    }

    /// Regression: odd-height H264 frames used to size the U/V planes as
    /// `(height / 2) * uv_stride`, so the final luma row indexed one chroma
    /// row past the slice and panicked the main task.  Chroma planes must be
    /// sized with `height.div_ceil(2)` and the conversion must stay in
    /// bounds for odd width and height.
    #[test]
    fn yuv420_to_rgb_handles_odd_dimensions_without_panic() {
        let width = 5usize;
        let height = 5usize;
        let y_stride = 8usize;
        let uv_stride = 4usize;
        let uv_rows = height.div_ceil(2);

        let y_plane = vec![128u8; height * y_stride];
        let u_plane = vec![128u8; uv_rows * uv_stride];
        let v_plane = vec![128u8; uv_rows * uv_stride];
        let mut rgb = vec![0u8; width * height * 3];

        yuv420_to_rgb(
            &y_plane, &u_plane, &v_plane, width, height, y_stride, uv_stride, &mut rgb,
        );

        // Neutral chroma (128) with mid luma should produce grey pixels for
        // every output position, including the final odd row/column.
        assert!(rgb.iter().all(|&channel| channel == 128));
    }

    /// Even if a decoder hands back undersized chroma planes, the conversion
    /// clamps to the last available chroma row instead of panicking.
    #[test]
    fn yuv420_to_rgb_clamps_undersized_chroma_planes() {
        let width = 4usize;
        let height = 6usize;
        let y_stride = 4usize;
        let uv_stride = 2usize;

        let y_plane = vec![128u8; height * y_stride];
        // Only two chroma rows where three are expected.
        let u_plane = vec![128u8; 2 * uv_stride];
        let v_plane = vec![128u8; 2 * uv_stride];
        let mut rgb = vec![0u8; width * height * 3];

        yuv420_to_rgb(
            &y_plane, &u_plane, &v_plane, width, height, y_stride, uv_stride, &mut rgb,
        );

        assert!(rgb.iter().all(|&channel| channel == 128));
    }
}
