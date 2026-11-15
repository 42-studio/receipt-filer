const DCT = new TextEncoder().encode("/DCTDecode");
const STREAM = new TextEncoder().encode("stream");
const ENDSTREAM = new TextEncoder().encode("endstream");

function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0, to = hay.length): number {
  outer: for (let i = from; i <= to - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** JPEG page scans stored inside a PDF, largest first. No rendering needed. */
export function embeddedJpegs(pdf: Uint8Array): Uint8Array[] {
  const found: Uint8Array[] = [];
  for (let at = indexOf(pdf, STREAM); at !== -1; at = indexOf(pdf, STREAM, at + 1)) {
    let start = at + STREAM.length;
    if (pdf[start] === 0x0d) start++;
    if (pdf[start] !== 0x0a) continue;
    start++;
    if (indexOf(pdf, DCT, Math.max(0, at - 600), at) === -1) continue;
    let end = indexOf(pdf, ENDSTREAM, start);
    if (end === -1) end = pdf.length;
    while (end > start && (pdf[end - 1] === 0x0a || pdf[end - 1] === 0x0d)) end--;
    if (pdf[start] === 0xff && pdf[start + 1] === 0xd8) found.push(pdf.slice(start, end));
  }
  return found.sort((a, b) => b.length - a.length);
}
