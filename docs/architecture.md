# Component boundaries

The application keeps the capture and evidence core independent from its hosting adapter.

| Component | Retained behavior | Boundary |
| --- | --- | --- |
| `app/desk.tsx` | Recording controller: prime encoded audio, confirm ownership, renew leases, seal independent segments, stop on input loss, save provisional bytes, import audio, capture photos | React interface and generic local workspace |
| `lib/capture-input.mjs` | Microphone/computer selection, audio-only stream, first-byte probe, retry and reconcile ambiguous recorder claims | Browser MediaDevices/MediaRecorder |
| `lib/capture-queue.mjs` | IndexedDB queue, SHA-256 sealing, keep data after failure, remove only matching receipts | Small store/upload interfaces |
| `lib/api.mjs` | Recorder generations/leases, idempotent evidence ingestion, durable receipts, late-upload review, notes, source search, transcript exports, candidate review | Injected verified principal, D1-shaped SQL adapter and object bucket |
| `lib/domain.mjs` | Origin, evidence identity and renewal checks | Pure validation |
| `lib/transcript-export.mjs` | Source IDs, revisions, hashes and pending/held status in Markdown/JSONL | Portable text export |
| `lib/audio.mjs` | ffmpeg decode, independent duration bound and mono 16 kHz WAV normalization | Optional local transcription dependency |
| `server/storage.mjs` | SQLite transactions and atomic filesystem object storage | Local implementation of SQL/bucket interfaces |
| `server/index.mjs` | Loopback HTTP server, pinned Host/Origin, static asset allowlist | Single local operator; replace for authenticated hosting |
| `lib/transcription.mjs` | Lease, retry, source revision check and transactional completion | Explicit local transcription function |

The core API keeps a D1-shaped interface so a hosted storage adapter can implement `prepare().bind().first()/all()/run()` and transactional `batch()`, plus bucket `put/head/get`. The local implementation uses Node SQLite and files. It is the supported runnable default; hosted authentication/storage is not configured.

The public application includes no team roster, invitation flow, task lanes, agent dispatch, benchmark promotion, private repository mirror, external connector identity, platform hosting manifest, service token, billing reservation, AI model API client or deployment workflow. The UI control library and large component catalog are unnecessary for the retained core; React renders a compact native-control interface. The SQLite schema includes only evidence, sessions, recorder leases, records, jobs and events. There are no seed records or media assets.

Candidate creation remains manual. Decision confirmation records who reviewed a proposal within this local principal model; it is not a cryptographic signature or proof of multi-person approval. Local adapter changes need their own authorization and security review before internet deployment.
