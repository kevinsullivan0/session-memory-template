# Session memory

A reusable web app for recoverable audio capture, transcripts, notes, photos, searchable sources, and human-reviewed decisions. It starts with an empty workspace. No accounts, recordings, API keys, hosted resources, or paid services are provisioned.

## Run locally

Install Node.js 24 or later, then run these commands from the repository directory:

```sh
npm ci
npm run build
npm test
npm start
```

Open **http://127.0.0.1:3210**. Keep that exact address: `localhost` is intentionally rejected by the HTTP Host check. Stop with Ctrl+C. The server binds only to loopback. It is a single-operator local app, not an authenticated internet service. Do not expose it through a tunnel or a reverse proxy without implementing a real authentication and authorization adapter. See [security and deployment](SECURITY.md).

No database setup command is needed. The server creates `data/memory.sqlite` and `data/objects/`. Both are ignored by Git. To choose another directory or port:

```sh
SESSION_MEMORY_DATA=./my-local-data PORT=3211 npm start
```

Use the same data directory when running the transcription command. `.env.example` documents settings; `.env` files are not loaded automatically. The shell environment examples above use POSIX syntax; on Windows set the same environment variables in PowerShell.

## Capture and recover

1. Enter consenting participant labels, confirm consent and permitted local processing, and choose microphone or computer audio.
2. Start recording. For computer audio, select a browser surface that offers audio and enable its audio-sharing option. Browser and OS support vary; video is never recorded or uploaded. There is no microphone fallback when computer audio is missing.
3. Each independently playable segment seals about once per minute. Sealed audio is written to IndexedDB before upload. A local copy is removed only after the server confirms the same SHA-256 hash. You may run one microphone input and one computer input in separate tabs; duplicate claims for the same input are rejected.
4. Stop & save before closing. Offline or failed uploads remain on the device. Reopening the same origin and browser profile resumes queued uploads; Retry uploads retries them immediately. Hold uploads is a per-tab setting and resets on reopening. Download local copy saves queued audio without deleting it. A failed recorder start retains provisional bytes locally; download and import that copy to create a valid session.
5. Late audio uploaded after a recorder lease ends is held. Open its source and explicitly approve processing. This is expected for the final stopped segment and offline recovery.

**The currently unsealed minute is not crash-safe.** Reloading or closing during capture can lose that partial minute. Browser eviction, clearing site data, switching profiles, or changing the port can make the local queue unavailable. Browser storage is not encrypted by this app and is not a backup.

The **Synthetic recovery test** creates a two-second tone in the browser and holds its upload. It never asks for microphone access. Reopen the app in another tab, retry the upload, open its held source, approve processing, and attach a clearly labeled synthetic transcript. Repeat to test a second recording session. No sample speech files are included.

Import supports independently playable audio segments up to 125 seconds and 10 MiB. Browser metadata support varies, especially for WebM files without duration headers. Recovered WebM files can be remuxed with an external media tool if browser import rejects their duration. Photos support JPEG, PNG and WebP; OCR is not included. Photo captions can be represented by a separate source note.

## Transcription

The app works immediately with **manual transcript entry**: open an audio source, review it if held, and attach or correct its transcript. Text becomes searchable and appears in Markdown/JSONL exports.

An optional local Whisper adapter provides automatic speech recognition without an API key. Install [Whisper and ffmpeg](https://github.com/openai/whisper#setup) separately, obtain model weights from a source you trust, and point the adapter at an existing local model file:

```sh
WHISPER_PYTHON=./.venv/bin/python WHISPER_MODEL_PATH=/absolute/path/to/model.pt npm run transcribe -- ./adapters/whisper-local.mjs
```

This drains currently available jobs, then exits. Run it again for new segments. It does not install software or download model weights. Use a Python interpreter with `openai-whisper` installed, and put ffmpeg on PATH. CPU transcription has a three-minute per-segment timeout; choose model size and hardware accordingly. Audio is independently decoded and bounded to 125 seconds before inference. Whisper's setup, dependencies, models and output quality remain your responsibility. Real model inference is not part of the default test suite.

For another engine, export `async function transcribe({bytes, mime, sourceId, signal})` from a local `.mjs` file and return a string of at most 50,000 characters. Then run `npm run transcribe -- ./your-adapter.mjs`. Adapters are trusted executable code with access to the process environment and local files. The supplied Whisper adapter uses only local files and subprocesses; a custom adapter may send data elsewhere, so review it first.

Jobs use four-minute leases. Failed jobs remain pending, and interrupted jobs become reclaimable after lease expiry. At most four attempts run before **Retry failed local processing** resets the queue. A manually attached transcript also completes its pending job. A source revision change prevents a worker from overwriting a newer correction. `adapters/synthetic-example.mjs` is a test fixture only and does not recognize speech.

## Source-linked memory

Add notes and photos, search the source text, or open source links. Propose an idea, question, proposal, decision candidate, action candidate or result claim linked to a source revision. Only an explicit human review creates a confirmed decision. Repeated or stale reviews fail. Transcripts are untrusted evidence; they cannot authorize actions. Candidate extraction is manual; no AI extraction service runs by default. The app does not assign work or execute commands from transcripts.

Search returns up to 50 matches before an optional `before` timestamp; the main timeline shows the latest 200 sources. Complete audio transcripts can be downloaded as Markdown or JSONL, including pending/held status and source hashes. Exported links refer to your local origin. Export files can contain private information once you add your own data; keep them out of a public repository.

## Development

- `npm run build`: bundles React with esbuild; outputs ignored `dist/`.
- `npm test`: unit, SQLite, HTTP, recovery and adapter-contract checks. Build first for the HTTP test. The ffmpeg adapter-contract check skips if ffmpeg is absent.
- `npm start`: serves the built app and the local API.
- `npm run transcribe -- PATH`: drains transcription jobs with an explicit adapter.

See [component boundaries](docs/architecture.md), [verification and limits](docs/verification.md), and [dependency licenses](THIRD_PARTY_NOTICES.md).

## License

MIT. Copyright holder: **kevinsullivan0**. Dependencies retain their own licenses.
