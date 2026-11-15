#!/usr/bin/env python3
"""How well does Cloudflare's Clairic model read real receipts?

Pipeline under test (the one proposed for the Worker):
  1. text first: email body and PDF text (Cloudflare toMarkdown) -> Clairic
  2. no usable text: send an image -> Clairic
     (a scanned PDF has no text, so pull the embedded page JPEG out of it)

Setup:
  1. Export CLOUDFLARE_API_TOKEN (Workers AI permission) and CLOUDFLARE_ACCOUNT_ID
  2. Put receipts in ./samples  (.pdf .jpg .jpeg .png .webp .heic .eml)
  3. python3 clairic_test.py
"""
import base64, email, email.policy, json, os, pathlib, re, subprocess, sys, tempfile, uuid
import urllib.error, urllib.request

HERE = pathlib.Path(__file__).parent
SAMPLES = HERE / "samples"
MAX_IMAGE = 4 * 1024 * 1024  # Clairic's limit per image
IMAGE_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}
# One set of field instructions for the Worker and this eval.
FIELDS = json.loads((HERE.parent / "src" / "read" / "fields.json").read_text())


def env():
    out = {k: os.environ.get(k, "") for k in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID")}
    missing = [k for k, v in out.items() if not v]
    if missing:
        sys.exit("Set these environment variables first: " + ", ".join(missing))
    return out




def post(path, data, content_type):
    cfg = env()
    api = f"https://api.cloudflare.com/client/v4/accounts/{cfg['CLOUDFLARE_ACCOUNT_ID']}/ai"
    req = urllib.request.Request(api + path, data=data, method="POST", headers={
        "Authorization": "Bearer " + cfg["CLOUDFLARE_API_TOKEN"],
        "Content-Type": content_type, "User-Agent": "receipt-spike"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return {"success": False, "errors": e.read().decode(errors="replace")[:400]}


def to_text(name, blob, mime):
    """Cloudflare's free document-to-text conversion (PDF and HTML)."""
    b = uuid.uuid4().hex
    body = (f"--{b}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"{name}\"\r\n"
            f"Content-Type: {mime}\r\n\r\n").encode() + blob + (
            f"\r\n--{b}\r\nContent-Disposition: form-data; name=\"conversionOptions\"\r\n\r\n"
            + json.dumps({"pdf": {"metadata": False}, "output": {"format": "text"}})
            + f"\r\n--{b}--\r\n").encode()
    out = post("/tomarkdown", body, f"multipart/form-data; boundary={b}")
    res = (out.get("result") or [{}])[0] if out.get("success") else {}
    return res.get("data") or "" if res.get("format") != "error" else ""


def embedded_jpegs(pdf):
    """JPEG page scans stored inside a PDF, largest first. No rendering needed."""
    found = []
    for m in re.finditer(rb"stream\r?\n", pdf):
        if b"/DCTDecode" in pdf[max(0, m.start() - 600):m.start()]:
            end = pdf.find(b"endstream", m.end())
            data = pdf[m.end():end].rstrip(b"\r\n")
            if data.startswith(b"\xff\xd8"):
                found.append(data)
    return sorted(found, key=len, reverse=True)


def shrink(blob, suffix):
    """Convert or downscale with macOS sips until the image is a JPEG under 4 MiB."""
    with tempfile.TemporaryDirectory() as d:
        src, dst = pathlib.Path(d) / ("in" + suffix), pathlib.Path(d) / "out.jpg"
        src.write_bytes(blob)
        for side in (2400, 1800, 1400, 1000):
            subprocess.run(["sips", "-s", "format", "jpeg", "-Z", str(side), str(src), "--out", str(dst)],
                           capture_output=True)
            if dst.exists() and dst.stat().st_size <= MAX_IMAGE:
                return dst.read_bytes()
    return None


def has_text(text):
    return len(re.sub(r"\s", "", text)) >= 40


def parts_of(path):
    """Return (text, [(image bytes, mime)], route description) for one sample file."""
    ext, blob = path.suffix.lower(), path.read_bytes()
    if ext == ".pdf":
        text = to_text(path.name, blob, "application/pdf")
        if has_text(text):
            return text, [], "PDF text"
        scans = [j for j in embedded_jpegs(blob)]
        if scans:
            img = scans[0] if len(scans[0]) <= MAX_IMAGE else shrink(scans[0], ".jpg")
            if img:
                return "", [(img, "image/jpeg")], "scanned PDF, embedded JPEG"
        return "", [], "scanned PDF, no JPEG inside"
    if ext in IMAGE_TYPES or ext == ".heic":
        if ext == ".heic" or len(blob) > MAX_IMAGE:
            small = shrink(blob, ext)
            return ("", [(small, "image/jpeg")], "image, resized") if small else ("", [], "image too large")
        return "", [(blob, IMAGE_TYPES[ext])], "image"
    if ext == ".txt":
        return blob.decode(errors="replace"), [], "email body text"
    if ext == ".eml":
        msg = email.message_from_bytes(blob, policy=email.policy.default)
        text, images, routes = "Subject: " + str(msg["subject"] or "") + "\n", [], []
        body = msg.get_body(preferencelist=("plain", "html"))
        if body is not None:
            content = body.get_content()
            if body.get_content_type() == "text/html":
                content = to_text("body.html", content.encode(), "text/html")
            text += content + "\n"
            routes.append("email body")
        for att in msg.iter_attachments():
            name, data = att.get_filename() or "file", att.get_payload(decode=True) or b""
            aext = pathlib.Path(name).suffix.lower()
            if aext == ".pdf":
                ptext = to_text(name, data, "application/pdf")
                if has_text(ptext):
                    text += ptext + "\n"
                    routes.append("PDF text")
            elif aext in IMAGE_TYPES and 50_000 < len(data) <= MAX_IMAGE and len(images) < 4:
                images.append((data, IMAGE_TYPES[aext]))
                routes.append("image")
        return text, images, " + ".join(routes) or "email, nothing usable"
    return "", [], "unsupported file type"


def clairic_body(text, images, reference_date=None):
    """Same shape as the Worker's request (src/read/reader.ts): images and reference_date only when present."""
    body = {"model": "clairic", "state": text, "fields": FIELDS}
    if images:
        body["images"] = [{"content_type": m, "base64": base64.b64encode(b).decode()} for b, m in images]
    if reference_date:
        body["reference_date"] = reference_date
    return body


def clairic(text, images):
    body = clairic_body(text, images)
    return post("/run/@cf/cloudflare/clairic", json.dumps(body).encode(), "application/json")


def main():
    if len(sys.argv) > 1:
        sys.exit(__doc__)
    files = sorted(p for p in SAMPLES.iterdir() if p.is_file() and not p.name.startswith("."))
    if not files:
        sys.exit(f"Put some receipts in {SAMPLES}")
    results = []
    for path in files:
        text, images, route = parts_of(path)
        row = {"file": path.name, "route": route}
        if has_text(text) or images:
            out = clairic(text if has_text(text) else "", images)
            if out.get("success"):
                res = out["result"]
                for name, ans in res.get("answers", {}).items():
                    row[name] = ans.get("value")
                    row[name + "_conf"] = ans.get("confidence")
                row["tokens"] = res.get("usage", {}).get("input_tokens")
                row["passes"] = res.get("usage", {}).get("passes")
                row["truncated"] = res.get("truncated")
            else:
                row["error"] = str(out.get("errors"))[:300]
        else:
            row["error"] = "nothing to send to the model"
        results.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
    (HERE / "clairic_results.json").write_text(json.dumps(results, indent=2, ensure_ascii=False))
    print(f"\n{len(results)} files. Saved clairic_results.json")


if __name__ == "__main__":
    main()
