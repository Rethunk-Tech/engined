/** Outcome of one CopyButton click; the button flashes this for ~1200 ms. */
export async function clipboardFlash(
  text: string,
  writeText: (value: string) => Promise<void>,
): Promise<'Copied' | 'Copy failed'> {
  try {
    await writeText(text)
    return 'Copied'
  } catch {
    return 'Copy failed'
  }
}
