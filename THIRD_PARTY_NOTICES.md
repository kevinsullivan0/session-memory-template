# Dependency licenses

This repository's application code is MIT licensed under `LICENSE`. Dependencies are installed through npm, are not vendored here, and retain their own copyright and license notices. The lockfile pins resolved versions and integrity hashes. Build output is ignored; esbuild preserves bundled legal comments in `dist/app.js.LEGAL.txt`, which the server also serves.

| Package | Version | License | Upstream |
| --- | --- | --- | --- |
| react | 19.2.6 | MIT | https://github.com/facebook/react |
| react-dom | 19.2.6 | MIT | https://github.com/facebook/react |
| scheduler (transitive) | 0.27.0 | MIT | https://github.com/facebook/react |
| esbuild and platform binary package | 0.28.2 | MIT | https://github.com/evanw/esbuild |

The optional local Whisper adapter invokes independently installed software. Whisper code/model licensing is documented by [its project](https://github.com/openai/whisper#license); it and its Python dependencies are not bundled. ffmpeg is not bundled and its LGPL/GPL terms depend on the installed build; see [FFmpeg's legal page](https://ffmpeg.org/legal.html). Installing or redistributing those tools requires checking their own terms. No third-party UI component source, CSS vendor file, media, model weights or platform helper script is included.
