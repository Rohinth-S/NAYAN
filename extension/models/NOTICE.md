# Model attribution

The build expects `version-RFB-320.onnx` in this directory. It is the UltraFace
RFB 320 model from
[`Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB`](https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB),
which is distributed under the MIT License. The model is deliberately not
downloaded by the build: its presence and checksum must be reviewed by the
person producing a release.

The current ONNX artifact has SHA-256
`b63e0028667fd9e7e5dcc56ebd91e85281b8df1498b4c3c5799de9229305c0b1`.
It was introduced in commit `0fb08c1`: the 244 initializer tensors were removed
from the graph's public input declarations, leaving the image as its only input.
A protobuf field comparison against the original checked-in artifact
(`34cd7e60aeff28744c657de7a3dc64e872d506741de66987f3426f2b79f88017`)
confirmed identical computation nodes, weights, outputs, opset and model metadata.
The build now validates size and checksum using `vision-lock.json` before copying
any ONNX model. Optional YOLO/DBNet assets require reviewed lock entries too.

The extension exposes `missing`, `webgpu`, `wasm`, or `error` detector state in
its popup and in sanitized request metadata. If the asset cannot be loaded,
network transmission is blocked unless the operator explicitly enables the
full-image opaque-mask fallback.
