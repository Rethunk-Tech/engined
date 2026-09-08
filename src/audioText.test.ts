/**
 * What the door does to the text it carries: the markup a TTS engine would
 * otherwise vocalize, removed once for every consumer rather than five times
 * with five different rules.
 */
import { expect, test } from "bun:test";
import { handleSpeech } from "./audio.ts";
import { startFakeUpstream } from "./test-support.ts";

const SAMPLE_WAV_BASE64 = Buffer.from("RIFF____WAVEfmt ", "utf8").toString("base64");

/** A real `Bun.serve` TTS engine emitting one terminal NDJSON frame, recording the `text` it was sent. */
function startFakeTts(): { base: string; texts: string[]; stop: () => void } {
  const texts: string[] = [];
  const fake = startFakeUpstream(async (req) => {
    const body: unknown = await req.json();
    texts.push(
      typeof body === "object" && body !== null && "text" in body ? String(body.text) : "",
    );
    return new Response(`${JSON.stringify({ phase: "done", audio: SAMPLE_WAV_BASE64 })}\n`, {
      headers: { "content-type": "application/x-ndjson" },
    });
  });
  return { base: `127.0.0.1:${fake.port}`, texts, stop: fake.stop };
}

/** The one text the fake engine was sent. */
async function spokenText(input: string): Promise<string> {
  const fake = startFakeTts();
  const res = await handleSpeech({ engine: "chatterbox-en", input }, async () => ({
    private_url: fake.base,
  }));
  fake.stop();
  expect(res.status).toBe(200);
  expect(fake.texts).toHaveLength(1);
  return fake.texts[0] ?? "";
}

test("bold and a bare URL reach the engine as words, which is what the 3.5x and 2.2x buy back", async () => {
  expect(await spokenText("**Ready** in a moment")).toBe("Ready in a moment");
  expect(await spokenText("See https://example.com for the rest")).toBe(
    "See example dot com for the rest",
  );
  expect(await spokenText("Read [the notes](https://example.com/notes) first")).toBe(
    "Read the notes first",
  );
});

test("a heading or list marker is markup, and the words after it are not", async () => {
  expect(await spokenText("# Status\n- one\n- two")).toBe("Status\none\ntwo");
});

test("already-plain text reaches the engine byte-identical, so a caller that normalizes is not normalized twice", async () => {
  const plain = "Priya asked about some_var and `npm run build` at 3.5 percent.";
  expect(await spokenText(plain)).toBe(plain);
  // The pass is idempotent: what a first pass produces is what a second one
  // would, so the door and a normalizing caller cannot disagree.
  expect(await spokenText("See https://example.com for **the rest**")).toBe(
    await spokenText("See example dot com for the rest"),
  );
});

test("an input that was nothing but markup is a 400, not an empty utterance the engine has to explain", async () => {
  const res = await handleSpeech({ engine: "chatterbox-en", input: "**" }, () => {
    throw new Error("no engine should be started for an unspeakable input");
  });

  expect(res.status).toBe(400);
});
