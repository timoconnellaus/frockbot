# Third-party notices — FrockBot for Mac

Fonts bundled with every client carry their licences beside them in
`packages/frockbot_client/assets/fonts/`. This file covers what only the Mac
app links or downloads.

## FluidAudio

On-device dictation (`Runner/LocalDictation.swift`) links
[FluidAudio](https://github.com/FluidInference/FluidAudio) 0.17.4, Copyright
FluidInference, under the Apache License 2.0. FluidAudio links
[text-processing-rs](https://github.com/FluidInference/text-processing-rs)
(`NemoTextProcessing.xcframework`), also Apache License 2.0. Both permit
redistribution in binary form with this notice and a copy of the licence:
<https://www.apache.org/licenses/LICENSE-2.0>.

## Parakeet TDT 0.6B v3

The speech model is not bundled. The app downloads it on the person's request
from Hugging Face,
[`FluidInference/parakeet-tdt-0.6b-v3-coreml`](https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml),
a Core ML conversion of NVIDIA's
[`nvidia/parakeet-tdt-0.6b-v3`](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3).
Both are licensed under Creative Commons Attribution 4.0
(<https://creativecommons.org/licenses/by/4.0/>), which permits use,
redistribution and on-demand download, commercially, with attribution:
"Parakeet TDT 0.6B v3 by NVIDIA, converted to Core ML by FluidInference,
CC BY 4.0." The model is used unmodified.

Whisper and whisper.cpp (both MIT) were considered and are not used.

## Sparkle

Desktop updates use [Sparkle](https://sparkle-project.org) 2.8.1, under the
MIT licence.
