"""The HTTP surface whisper.cpp's own server does not have.

whisper.cpp fires a new-segment callback as decoding proceeds, and its CLI
installs that callback and prints each segment the moment it lands. Its
`whisper-server`, by contrast, registers four routes that all answer through a
single buffered `res.set_content` after the whole transcript exists. So the
library streams and the server does not.

This process is PID 1 in the container and owns the one exposed port. It runs
whisper-server on loopback and proxies every request it already served to it
byte-for-byte -- a caller that does not ask for streaming reaches exactly the
same handler it always did -- and answers one route of its own,
`POST /v1/audio/transcriptions/stream`, by driving whisper-cli and forwarding
its segments as they arrive.

The frames are engined's NDJSON progress shape, the same one
engines/chatterbox-shared speaks: `{"phase": "segment", text, start, end}` per
segment as it decodes, then exactly one terminal `{"phase": "done", text}` or
`{"phase": "error", detail}`.

The request body is the raw audio bytes -- no multipart -- because the door in
front of this is the only caller and multipart would buy nothing but a parser.
`language` and `prompt` ride in the query string.

A caller that hangs up mid-transcript closes the socket, the next frame write
raises, and whisper-cli is killed. That is the wrapper's half of the 499
whisper-server gets from `wparams.abort_callback`: work nobody will read stops
rather than running the GPU to completion.
"""

import http.client
import json
import re
import signal
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import IO
from urllib.parse import parse_qs, urlparse

BIN_DIR = "/app/build/bin"
LISTEN_PORT = 8080
# whisper-server is moved off the exposed port and onto loopback; nothing
# outside the container can reach it except through this process.
UPSTREAM = "127.0.0.1:8081"
STREAM_PATH = "/v1/audio/transcriptions/stream"
NDJSON = "application/x-ndjson"

# Per-connection headers, which describe the hop and not the message: copying
# one across a proxy hop makes this process claim a framing or a lifetime that
# belongs to the other socket.
HOP_BY_HOP = frozenset(
    {
        "connection",
        "host",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    }
)

# `[00:00:02.590 --> 00:00:05.490]   text`, whisper-cli's own segment line.
SEGMENT = re.compile(
    r"^\[(\d+):(\d\d):(\d\d\.\d+) --> (\d+):(\d\d):(\d\d\.\d+)\]\s*(.*)$"
)

# Enough of a failing whisper-cli's stderr to name the cause without pasting a
# Vulkan device dump into a JSON frame.
DETAIL_TAIL = 500

SERVER_ARGV: list[str] = []


def _seconds(hours: str, minutes: str, secs: str) -> float:
    return int(hours) * 3600 + int(minutes) * 60 + float(secs)


def _value(argv: list[str], flag: str) -> str | None:
    """The token after `flag`, or None -- the same `-m <path>` pair engined
    rewrites to switch models is how this process learns which weights the
    container was started for."""
    if flag not in argv:
        return None
    idx = argv.index(flag) + 1
    return argv[idx] if idx < len(argv) else None


def _server_argv(argv: list[str]) -> list[str]:
    """whisper-server's own arguments with its bind moved to loopback."""
    out = list(argv)
    host = out.index("--host") + 1 if "--host" in out else 0
    if host:
        out[host] = "127.0.0.1"
    else:
        out += ["--host", "127.0.0.1"]
    return out + ["--port", UPSTREAM.split(":")[1]]


def _cli_argv(audio_path: str, params: dict[str, list[str]]) -> list[str]:
    """The decode this container was configured for, aimed at one file.

    Built from the named flags rather than by filtering the server's argv, so a
    flag that means something different to the two binaries cannot leak across.

    The two binaries do not share defaults, and the ones that differ change the
    text rather than only its formatting. whisper-server samples greedily
    (`best_of 2`, `beam_size -1`); whisper-cli beam-searches (`best_of 5`,
    `beam_size 5`). Over 15 clips that alone put the two transcripts at odds on
    6 -- "four minutes" against "4 minutes", "Daman" against "Damen", an added
    comma -- so the server's sampling is named here explicitly.

    `--no-timestamps` is the one server flag this cannot carry. It is not a
    print setting inside whisper: it pushes `<|notimestamps|>` into the prompt,
    drives every timestamp token's logit to -inf, and makes each 30s window
    decode as a single segment. Carrying it would leave a frame with no place
    in the recording and no segment smaller than a window, which is the whole
    of what streaming delivers. It is the one decode difference between the two
    paths that survives, and it is the reason a streamed transcript of a
    recording longer than 30s is not the buffered path's transcript.

    `stdbuf -oL` because whisper-cli's stdout is a pipe here rather than a
    terminal, and a segment held in libc's buffer until the buffer fills is a
    segment that did not stream.
    """
    argv = [
        "stdbuf",
        "-oL",
        f"{BIN_DIR}/whisper-cli",
        "-f",
        audio_path,
        "-np",
        "-bo",
        "2",
        "-bs",
        "-1",
    ]
    model = _value(SERVER_ARGV, "-m")
    if model is not None:
        argv += ["-m", model]
    threads = _value(SERVER_ARGV, "-t")
    if threads is not None:
        argv += ["-t", threads]
    if "-fa" in SERVER_ARGV:
        argv.append("-fa")
    vad_model = _value(SERVER_ARGV, "-vm")
    if "--vad" in SERVER_ARGV and vad_model is not None:
        argv += ["--vad", "-vm", vad_model]
    language = params.get("language", [None])[0]
    if language:
        argv += ["-l", language]
    prompt = params.get("prompt", [None])[0]
    if prompt:
        argv += ["--prompt", prompt]
    return argv


class Handler(BaseHTTPRequestHandler):
    # HTTP/1.0: the NDJSON body's length is unknown when the headers go out, and
    # a close-delimited body is the framing that needs no hand-rolled chunk
    # encoding to say so.
    protocol_version = "HTTP/1.0"

    def do_POST(self) -> None:
        if urlparse(self.path).path == STREAM_PATH:
            self._transcribe()
        else:
            self._proxy()

    def do_GET(self) -> None:
        self._proxy()

    def do_OPTIONS(self) -> None:
        self._proxy()

    def log_message(self, fmt: str, *args: object) -> None:
        """One line per request would restore exactly the per-request noise
        engines/whisper/quiet.sh exists to drop."""

    def _body(self) -> bytes:
        length = int(self.headers.get("content-length") or 0)
        return self.rfile.read(length) if length > 0 else b""

    def _error(self, status: int, message: str) -> None:
        payload = json.dumps({"error": message}).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _proxy(self) -> None:
        body = self._body()
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_BY_HOP}
        conn = http.client.HTTPConnection(UPSTREAM)
        try:
            conn.request(self.command, self.path, body=body or None, headers=headers)
            res = conn.getresponse()
            # Read whole: whisper-server answers a transcript in one buffered
            # body, so there is nothing here to stream and the upstream's own
            # content-length stays correct on the way out.
            payload = res.read()
            status, out_headers = res.status, res.getheaders()
        except OSError as err:
            # Before whisper-server has finished loading its model, which the
            # readiness probe treats as not-yet-ready and retries.
            self._error(503, f"whisper-server is not answering yet: {err}")
            return
        finally:
            conn.close()
        self.send_response(status)
        for key, value in out_headers:
            if key.lower() not in HOP_BY_HOP:
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def _frame(self, frame: dict[str, object]) -> None:
        self.wfile.write(f"{json.dumps(frame)}\n".encode())

    def _transcribe(self) -> None:
        audio = self._body()
        if not audio:
            self._error(400, "request body carried no audio")
            return
        self.send_response(200)
        self.send_header("content-type", NDJSON)
        self.end_headers()
        with tempfile.NamedTemporaryFile(suffix=".wav") as upload:
            upload.write(audio)
            upload.flush()
            self._decode(upload.name, parse_qs(urlparse(self.path).query))

    def _decode(self, audio_path: str, params: dict[str, list[str]]) -> None:
        # stderr to a file rather than a pipe: nothing here drains it while the
        # decode runs, and a pipe nobody reads deadlocks the moment ggml's
        # device banter fills it.
        with tempfile.TemporaryFile(mode="w+") as errors:
            proc = subprocess.Popen(
                _cli_argv(audio_path, params),
                stdout=subprocess.PIPE,
                stderr=errors,
                text=True,
                bufsize=1,
            )
            segments = proc.stdout
            if segments is None:
                self._frame({"phase": "error", "detail": "whisper-cli opened no output"})
                return
            try:
                self._forward(segments, proc, errors)
            except (BrokenPipeError, ConnectionResetError):
                # The caller hung up. Killing the decode is the whole point:
                # a dropped body does not by itself stop the work behind it.
                pass
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
                segments.close()

    def _forward(
        self, segments: IO[str], proc: "subprocess.Popen[str]", errors: IO[str]
    ) -> None:
        spoken: list[str] = []
        for line in segments:
            match = SEGMENT.match(line.rstrip("\n"))
            if match is None:
                continue
            text = match.group(7).strip()
            spoken.append(text)
            self._frame(
                {
                    "phase": "segment",
                    "text": text,
                    "start": _seconds(*match.group(1, 2, 3)),
                    "end": _seconds(*match.group(4, 5, 6)),
                }
            )
        if proc.wait() != 0:
            errors.seek(0)
            detail = errors.read().strip()[-DETAIL_TAIL:]
            self._frame(
                {
                    "phase": "error",
                    "detail": detail or f"whisper-cli exited {proc.returncode}",
                }
            )
            return
        # One transcript, joined from the frames already sent, so a caller that
        # only wants the whole thing can ignore everything before this.
        self._frame({"phase": "done", "text": " ".join(spoken)})


def main() -> None:
    global SERVER_ARGV
    SERVER_ARGV = sys.argv[1:]
    server = subprocess.Popen([f"{BIN_DIR}/whisper-server", *_server_argv(SERVER_ARGV)])

    def stop(*_: object) -> None:
        server.terminate()
        sys.exit(0)

    # docker stop signals PID 1 only, so whisper-server is this process's to
    # take down; without this it survives until the runtime's SIGKILL.
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    ThreadingHTTPServer(("0.0.0.0", LISTEN_PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
