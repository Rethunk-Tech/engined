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
`POST /v1/audio/transcriptions/stream`.

The frames are engined's NDJSON progress shape, the same one
engines/chatterbox-shared speaks: `{"phase": "segment", text, start, end}` per
segment as it decodes, then exactly one terminal `{"phase": "done", text}` or
`{"phase": "error", detail}`.

The two kinds of frame are produced two different ways, and that is the whole
design:

  * The `segment` frames are provisional. A chunked body is decoded while it is
    still arriving -- whisper-cli over the audio after the last segment
    boundary, once WINDOW_SECONDS of it has piled up -- so a caption appears
    while the speaker is still talking. Provisional because a decode of the
    first four seconds of a sentence is not a decode of the sentence.
  * The `done` frame is whisper-server's own answer to the completed upload,
    posted to it on loopback over the same handler the OpenAI verb reaches. Not
    a second decode that agrees most of the time -- the same one, so a streamed
    transcript and a buffered transcript are the same string by construction
    rather than by matching flags.

A body that arrives with a `content-length` is already whole, so there is
nothing to decode ahead of: it takes one whisper-cli pass for its segment
frames and the same terminal frame.

The request body is the raw audio bytes -- no multipart -- because the door in
front of this is the only caller and multipart would buy nothing but a parser.
`language` and `prompt` ride in the query string.

A caller that hangs up mid-transcript closes the socket, the next frame write
raises, and whisper-cli is killed. While the terminal decode runs there is no
frame to write, so the caller's socket is watched directly and the upstream
connection closed when it goes -- which is what `wparams.abort_callback` reads
as a hangup. Either way, work nobody will read stops rather than running the
GPU to completion.
"""

import http.client
import json
import os
import re
import secrets
import select
import signal
import socket
import struct
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import IO, Iterator, NamedTuple
from urllib.parse import parse_qs, urlparse

BIN_DIR = "/app/build/bin"
# The image sets PORT beside its own EXPOSE; a KeyError here is the wanted
# failure, since a default would be the second spelling this reads it to avoid.
LISTEN_PORT = int(os.environ["PORT"])
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

# How much undecoded audio makes a pass worth running: small enough that a
# caption lands while the next sentence is still being spoken, large enough
# that a pass carries a phrase rather than a syllable and that whisper-cli's
# model load is amortised over real work.
WINDOW_SECONDS = 4.0

# A window this long that whisper found no segment in is silence. whisper
# decodes in 30s windows regardless, so committing it holds nothing back.
MAX_WINDOW_SECONDS = 30.0

# The whole upload is held to hand it to whisper-server at the end, so a body
# with no end is a body that eventually exhausts the container. Matches the
# door's own upload ceiling.
MAX_AUDIO_BYTES = 268_435_456

READ_BYTES = 65536

# How often the caller's socket is checked for a hangup while whisper-server
# decodes. Short enough that an abandoned decode is not measurably longer than
# the abandonment; long enough not to be a spin loop.
POLL_SECONDS = 0.25

class Wav(NamedTuple):
    """One WAV header's fields, and where its samples begin."""

    encoding: int
    rate: int
    channels: int
    bits: int
    data_at: int

    @property
    def block(self) -> int:
        return self.channels * self.bits // 8

    @property
    def per_second(self) -> int:
        return self.rate * self.block


class Cancelled(Exception):
    """The caller went away. Nothing left to send, and nothing left to decode."""


class DecodeFailed(Exception):
    """Carries the detail of the one terminal error frame."""

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


def _parse_wav(buf: bytes | bytearray) -> Wav | None:
    """The stream's format and where its samples start, or None while the
    header is still incomplete -- and for a body that is not a WAV at all,
    which is decoded whole instead of in windows."""
    if len(buf) < 12 or buf[0:4] != b"RIFF" or buf[8:12] != b"WAVE":
        return None
    pos, fmt = 12, None
    while pos + 8 <= len(buf):
        chunk_id = bytes(buf[pos : pos + 4])
        size = struct.unpack("<I", buf[pos + 4 : pos + 8])[0]
        if chunk_id == b"data":
            if fmt is None:
                return None
            encoding, channels, rate, bits = fmt
            return Wav(encoding, rate, channels, bits, pos + 8)
        if chunk_id == b"fmt " and pos + 24 <= len(buf):
            encoding, channels, rate = struct.unpack("<HHI", buf[pos + 8 : pos + 16])
            bits = struct.unpack("<H", buf[pos + 22 : pos + 24])[0]
            fmt = (encoding, channels, rate, bits)
        pos += 8 + size + (size & 1)
    return None


def _wav_header(wav: Wav, n_bytes: int) -> bytes:
    """A canonical header for a slice of the upload's samples. Written fresh
    rather than copied, because the caller's own header declares a length for
    audio that has not been recorded yet."""
    return b"".join(
        [
            b"RIFF",
            struct.pack("<I", 36 + n_bytes),
            b"WAVEfmt ",
            struct.pack(
                "<IHHIIHH",
                16,
                # The source's own encoding: relabelling float samples as PCM
                # hands whisper-cli a file it reads as noise.
                wav.encoding,
                wav.channels,
                wav.rate,
                wav.per_second,
                wav.block,
                wav.bits,
            ),
            b"data",
            struct.pack("<I", n_bytes),
        ]
    )


def _spill(work: str, name: str, data: bytes) -> str:
    path = os.path.join(work, name)
    with open(path, "wb") as out:
        out.write(data)
    return path


def _inference_path() -> str:
    """Where whisper-server answers the OpenAI verb, read from the arguments it
    was started with -- the terminal frame has to reach the same handler the
    buffered route reaches, and engined's spec is free to move it."""
    prefix = _value(SERVER_ARGV, "--request-path") or ""
    return prefix + (_value(SERVER_ARGV, "--inference-path") or "/inference")


def _multipart(audio: bytes, params: dict[str, list[str]]) -> tuple[bytes, str]:
    """The upload in the form whisper-server parses, carrying the same
    per-request fields the door sends on the buffered verb."""
    boundary = f"engined{secrets.token_hex(8)}"
    body = bytearray()
    for field in ("language", "prompt"):
        value = params.get(field, [None])[0]
        if value:
            body += (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{field}"\r\n\r\n'
                f"{value}\r\n"
            ).encode()
    body += (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="file"; filename="upload"\r\n'
        "Content-Type: application/octet-stream\r\n\r\n"
    ).encode()
    body += audio
    body += f"\r\n--{boundary}--\r\n".encode()
    return bytes(body), f"multipart/form-data; boundary={boundary}"


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

    def _audio_chunks(self) -> tuple[Iterator[bytes], bool]:
        """The request body as it arrives, and whether it is still arriving. A
        declared length is a body the caller already holds; a chunked one is a
        recording still being made."""
        encoding = (self.headers.get("transfer-encoding") or "").lower()
        if "chunked" in encoding:
            return self._read_chunked(), True
        return self._read_sized(int(self.headers.get("content-length") or 0)), False

    def _read_sized(self, length: int) -> Iterator[bytes]:
        remaining = length
        while remaining > 0:
            data = self.rfile.read(min(remaining, READ_BYTES))
            if not data:
                return
            remaining -= len(data)
            yield data

    def _read_chunked(self) -> Iterator[bytes]:
        """Chunked transfer decoding, which BaseHTTPRequestHandler does not do
        for a request body. This is the only framing that can carry audio whose
        length is not known when the recording starts."""
        while True:
            header = self.rfile.readline(READ_BYTES).split(b";")[0].strip()
            try:
                size = int(header, 16)
            except ValueError:
                raise DecodeFailed("request body is not valid chunked encoding")
            if size == 0:
                while self.rfile.readline(READ_BYTES).strip():
                    pass
                return
            while size > 0:
                data = self.rfile.read(min(size, READ_BYTES))
                if not data:
                    return
                size -= len(data)
                yield data
            self.rfile.read(2)

    def _transcribe(self) -> None:
        params = parse_qs(urlparse(self.path).query)
        chunks, live = self._audio_chunks()
        try:
            audio = bytearray(next(chunks, b""))
        except DecodeFailed as err:
            # Nothing has been sent yet, so a malformed body is still a status
            # rather than an error frame.
            self._error(400, str(err))
            return
        if not audio:
            self._error(400, "request body carried no audio")
            return
        self.send_response(200)
        self.send_header("content-type", NDJSON)
        self.end_headers()
        with tempfile.TemporaryDirectory() as work:
            try:
                if live:
                    self._windows(chunks, audio, work, params)
                else:
                    for chunk in chunks:
                        audio += chunk
                    self._decode(_spill(work, "upload", bytes(audio)), params, 0.0)
                self._frame({"phase": "done", "text": self._buffered(bytes(audio), params)})
            except (BrokenPipeError, ConnectionResetError, Cancelled):
                # The caller hung up. Killing the decode is the whole point:
                # a dropped body does not by itself stop the work behind it.
                pass
            except DecodeFailed as err:
                self._frame({"phase": "error", "detail": str(err)})

    def _windows(
        self,
        chunks: Iterator[bytes],
        audio: bytearray,
        work: str,
        params: dict[str, list[str]],
    ) -> None:
        """Decodes what has arrived while the rest is still arriving.

        Each pass covers the samples after the end of the last segment whisper
        found, so a pass boundary falls where whisper itself stopped rather
        than mid-word, and no segment is emitted twice. A body that is not a
        WAV has no sample boundaries to cut on and so waits for the terminal
        frame.
        """
        wav = _parse_wav(audio)
        committed = wav.data_at if wav else 0
        for chunk in chunks:
            if len(audio) + len(chunk) > MAX_AUDIO_BYTES:
                raise DecodeFailed(f"upload is larger than {MAX_AUDIO_BYTES} bytes")
            audio += chunk
            if wav is None:
                wav = _parse_wav(audio)
                if wav is None:
                    continue
                committed = wav.data_at
            if len(audio) - committed < WINDOW_SECONDS * wav.per_second:
                continue
            committed += self._window(bytes(audio[committed:]), wav, committed, work, params)

    def _window(
        self,
        pcm: bytes,
        wav: Wav,
        start: int,
        work: str,
        params: dict[str, list[str]],
    ) -> int:
        """One pass over the uncommitted samples; returns how many of them it
        accounted for.

        A window ends wherever the upload happened to reach, so its last
        segment is a phrase cut in half. That one is held back rather than
        framed, and the samples under it stay uncommitted for the next pass to
        decode whole -- a caption that reads "the web socket dropped twice" and
        is never completed is worse than the same caption two seconds later.
        Silence that has grown past a whole decode window is the exception:
        nothing is coming to complete it.
        """
        exhausted = len(pcm) >= MAX_WINDOW_SECONDS * wav.per_second
        path = _spill(work, "window.wav", _wav_header(wav, len(pcm)) + pcm)
        end = self._decode(
            path, params, (start - wav.data_at) / wav.per_second, keep_last=exhausted
        )
        if end is None:
            return len(pcm) if exhausted else 0
        return min(len(pcm), int(end * wav.per_second) // wav.block * wav.block)

    def _decode(
        self,
        audio_path: str,
        params: dict[str, list[str]],
        offset: float,
        keep_last: bool = True,
    ) -> float | None:
        """Runs whisper-cli over one file, framing each segment as it lands.
        Returns where the last framed segment ended, in seconds from the start
        of that file, or None if it framed none. `keep_last` is false for a
        file that stops mid-recording."""
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
                raise DecodeFailed("whisper-cli opened no output")
            code = None
            try:
                last = self._forward(segments, offset, keep_last)
                code = proc.wait()
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
                segments.close()
            if code != 0:
                errors.seek(0)
                detail = errors.read().strip()[-DETAIL_TAIL:]
                raise DecodeFailed(detail or f"whisper-cli exited {code}")
            return last

    def _forward(self, segments: IO[str], offset: float, keep_last: bool) -> float | None:
        """One frame per segment line, each written as the next one lands so
        that nothing waits on the pass finishing. The one segment held back
        under `keep_last=False` is the one the window cut short."""
        held: tuple[dict[str, object], float] | None = None
        framed: float | None = None
        for line in segments:
            match = SEGMENT.match(line.rstrip("\n"))
            if match is None:
                continue
            if held is not None:
                self._frame(held[0])
                framed = held[1]
            end = _seconds(*match.group(4, 5, 6))
            text = match.group(7).strip()
            if not text:
                # Silence carries no caption but is still decoded ground.
                held, framed = None, end
                continue
            held = (
                {
                    "phase": "segment",
                    "text": text,
                    "start": offset + _seconds(*match.group(1, 2, 3)),
                    "end": offset + end,
                },
                end,
            )
        if held is not None and keep_last:
            self._frame(held[0])
            framed = held[1]
        return framed

    def _buffered(self, audio: bytes, params: dict[str, list[str]]) -> str:
        """The transcript the OpenAI verb answers with, from the handler that
        answers it. Parity between the two routes is not a set of flags kept in
        step -- it is one decode, reached twice."""
        body, content_type = _multipart(audio, params)
        conn = http.client.HTTPConnection(UPSTREAM)
        try:
            conn.request(
                "POST",
                _inference_path(),
                body=body,
                headers={"content-type": content_type, "content-length": str(len(body))},
            )
            self._await(conn)
            res = conn.getresponse()
            payload = res.read()
            if res.status != 200:
                raise DecodeFailed(
                    f"whisper-server answered {res.status} to the completed upload"
                )
        except OSError as err:
            raise DecodeFailed(f"whisper-server is not answering: {err}")
        finally:
            conn.close()
        text = json.loads(payload).get("text")
        if not isinstance(text, str):
            raise DecodeFailed("whisper-server returned no transcript")
        return text

    def _await(self, conn: http.client.HTTPConnection) -> None:
        """Waits for whisper-server with an eye on the caller's socket. No
        frame is written while it decodes, so a hangup is invisible until this
        looks for it -- and closing the upstream connection is what
        whisper-server's abort_callback reads as one."""
        watching = [self.connection, conn.sock]
        while True:
            ready, _, _ = select.select(watching, [], [], POLL_SECONDS)
            if conn.sock in ready:
                return
            if self.connection in ready:
                if not self.connection.recv(1, socket.MSG_PEEK):
                    raise Cancelled()
                # Bytes rather than a hangup: a pipelined request, which this
                # connection will never get to. Watching it further would spin.
                watching = [conn.sock]


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
