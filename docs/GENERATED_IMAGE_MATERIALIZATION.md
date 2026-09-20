# Generated image materialization

## Contract

A generated-image candidate is a browser observation, not proof of durable
artifact availability. The Bridge artifact registry starts capture when it first
registers a READY image candidate. Public projections expose MATERIALIZING until
FileStore has validated and persisted the bytes. Only then do they expose READY,
a concrete image MIME, byte size, normalized filename, and stored file identity.
Capture failure exposes FAILED with a materialization error. It never stores the
error body as an image or replaces the image with a text artifact.

The registry is shared by active observations, terminal snapshots, forced
snapshots, passive turns, and recovery. Capture uses the existing source-bound
Protocol 5 `artifact.fetch` command. It has no request lease and does not introduce
another browser transport or request reducer. Inbound message processing does
not await capture: its result must traverse that same queue. Final result and
passive journal publication await the independent capture promise.

Content fetch remains the first path, with `credentials: include`. If it fails,
the extension API explicitly forwards `anonymous: false` to the background,
which uses `credentials: include`. Other privileged requests keep their existing
anonymous default. HTTP failures and unrecognized image bytes remain errors.
Diagnostics identify the execution context and response status without media
URLs, headers, cookies, response bodies, or image data. Background captures have
a distinct `extension-background-fetch` source.

Concurrent downloads share one capture. Subsequent observations preserve the
stored readiness and metadata rather than restoring the original temporary URL
as the only source. Downloads use the local artifact even when a force option is
supplied for an image. Stored images remain addressable after a Bridge restart;
explicit deletion of local storage ends that storage lifetime. Cached image
bytes are validated too, preventing an old text/error record from bypassing the
new contract. Ordinary ZIP, PDF, CSV, JSON, TXT, and file artifacts keep their
existing retrieval behavior. Generated-image detection rules are unchanged.

## Live investigation, 2026-09-20

The investigation used the existing primary Bridge and its authenticated
extension connection. No second Bridge attached to an existing owned tab. The
following record contains only allowlisted diagnostic facts:

1. A live tab observation contained one generated-image candidate, `kind: image`,
   `phase: READY`, `mime: image/*`.
2. Source-bound `/browser/recover-latest` registered the candidate.
3. The recovery response propagated the same logical image identity to the
   HTTP client. This trace used recovery output; it did not exercise a new
   turn-item creation event.
4. The client requested `GET /artifacts/:id/download`.
5. The stored capture source was `direct-fetch`, rather than a Chrome download
   path or artifact preview.
6. The pre-change `direct-fetch` label covered both content fetch and background
   fallback. It cannot, by itself, prove which of those executed. Source inspection
   showed the content request includes credentials, while the old background
   implementation unconditionally omitted them and the extension API discarded
   the caller's `anonymous: false` preference.
7. The live HTTP download succeeded. A separate Node request to the same media
   URL without the browser session returned HTTP 403, `application/json`, 39 bytes.
   This demonstrates that the observable URL alone was insufficient in that
   runtime; it does not identify which individual cookie/header was required.
8. Downloaded bytes matched PNG magic, with size 2,618,911 bytes.
9. FileStore retained `metadata.kind: image`, `mime: image/png`, and that byte size.
   The inspected stored image records contained no text MIME. The reported fake
   text download was not reproduced in this trace.
10. The HTTP endpoint returned 200 with `image/png` and the actual image bytes.
    HTTP and RPC equivalence, including explicit failures, are also covered by
    the retrieval-boundary tests below.

The media endpoint was `/backend-api/estuary/content`; its query had signature
and timestamp fields. Treat it as temporary. Exact expiry duration and rotation
between observation and this immediate download were not measured. The fix does
not depend on either duration or rotation behavior. No cookie enumeration or
credential capture was necessary.

The initial attempt to validate the updated extension in an isolated live tab
stopped before reloading because another live browser request was active.

## Regression coverage

- `generatedImageRetrievalBoundary.test.js` executes production content transfer,
  extension API serialization, background HTTP transport, FileStore, HTTP server,
  and Codex RPC. The browser cookie jar/network boundary is simulated. It covers
  both authenticated paths, 401/403, 200 HTML/JSON/text error bodies, URL expiry,
  concurrent capture, restarted operations, and legacy cached error text.
- `generatedImagePublication.test.js` uses actual local Protocol 5 WebSockets and
  a delayed capture response to prove recovery/passive publication waits for
  storage without deadlocking incoming results. It also tests canonical final
  publication ordering.
- Existing image normalization and real HTTP tests cover PNG/WebP and other
  supported signatures, including Chrome download-path imports.
- Generic turn items update their status and metadata in place as materialization
  settles, including resumed turns. The bundled Codex chat test UI consumes the
  same persisted artifact items for live and historical previews.

Use extension 2.3.18 (content runtime 4.3.16) with the updated Bridge. Restart the
Bridge and reload the extension to activate both halves of the change.
