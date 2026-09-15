# Model attribution

The build expects `version-RFB-320.onnx` in this directory. It is the UltraFace
RFB 320 model from
[`Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB`](https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB),
which is distributed under the MIT License. The model is deliberately not
downloaded by the build: its presence and checksum must be reviewed by the
person producing a release.

The extension exposes `missing`, `webgpu`, `wasm`, or `error` detector state in
its popup and in sanitized request metadata. If the asset cannot be loaded,
network transmission is blocked unless the operator explicitly enables the
full-image opaque-mask fallback.
