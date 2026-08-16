# apps/vox/src/video_decoder.rs

Wraps a persistent OpenH264 decoder with error concealment, YUV420-to-RGB conversion, TurboJPEG output, and automatic reset/PLI after repeated failures. A downsampled luminance grid and EMA produce frame/scene-change scores without storing a full video history.
