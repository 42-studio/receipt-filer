#!/usr/bin/env python3
"""Score Clairic against labelled receipt and invoice datasets.

  python3 eval/clairic_eval.py fetch   # download samples + ground truth into eval/eval (free)
  python3 eval/clairic_eval.py run     # call Clairic for every item (resumable, costs about $0.10)
  python3 eval/clairic_eval.py score   # print accuracy tables and failures
  python3 eval/clairic_eval.py check   # offline: confirm the request carries src/read/fields.json

Datasets (public, labelled):
  sroie       jsdnrs/ICDAR2019-SROIE (Hugging Face)   scanned shop receipts, MYR
  cord        naver-clova-ix/cord-v2 (Hugging Face)   phone photos of receipts, IDR
  invoices    katanaml-org/invoices-donut-data-v1     invoice page images, USD
  invoice2data  github.com/invoice-x/invoice2data     real PDF invoices, mixed currency
  edge        eval_cases.json, hand-made text cases
"""
import concurrent.futures, datetime, json, pathlib, re, sys, urllib.parse, urllib.request

import clairic_test as t

EVAL = t.HERE / "eval"
RESULTS = EVAL / "results.jsonl"
SAMPLE = {"sroie": 40, "cord": 20, "invoices": 20}

def http(url, binary=False):
    req = urllib.request.Request(url, headers={"User-Agent": "receipt-spike"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read() if binary else json.load(r)


def hf_rows(dataset, config, split, offset, length):
    q = urllib.parse.urlencode({"dataset": dataset, "config": config, "split": split,
                                "offset": offset, "length": length})
    return [r["row"] for r in http("https://datasets-server.huggingface.co/rows?" + q)["rows"]]


# ---------- fetch ----------

def fetch():
    items = []
    d = EVAL / "sroie"; d.mkdir(parents=True, exist_ok=True)
    for i, row in enumerate(hf_rows("jsdnrs/ICDAR2019-SROIE", "default", "train", 100, SAMPLE["sroie"])):
        f = d / f"{row['key']}.jpg"
        if not f.exists():
            f.write_bytes(http(row["image"]["src"], binary=True))
        e = row["entities"]
        truth = {"total": e.get("total"), "date": e.get("date"), "supplier": e.get("company")}
        items.append({"id": f"sroie-img-{i}", "set": "sroie image", "image": str(f), "truth": truth})
        items.append({"id": f"sroie-txt-{i}", "set": "sroie OCR text", "text": "\n".join(row["words"]), "truth": truth})
    d = EVAL / "cord"; d.mkdir(exist_ok=True)
    for i, row in enumerate(hf_rows("naver-clova-ix/cord-v2", "default", "test", 0, SAMPLE["cord"])):
        f = d / f"cord-{i}.jpg"
        if not f.exists():
            f.write_bytes(http(row["image"]["src"], binary=True))
        gt = json.loads(row["ground_truth"])["gt_parse"]
        total = gt.get("total", {})
        total = total[0] if isinstance(total, list) else total
        items.append({"id": f"cord-{i}", "set": "cord image", "image": str(f),
                      "truth": {"total": total.get("total_price"), "thousands": True}})
    d = EVAL / "invoices"; d.mkdir(exist_ok=True)
    for i, row in enumerate(hf_rows("katanaml-org/invoices-donut-data-v1", "default", "test", 0, SAMPLE["invoices"])):
        f = d / f"invoice-{i}.jpg"
        if not f.exists():
            f.write_bytes(http(row["image"]["src"], binary=True))
        gt = json.loads(row["ground_truth"])["gt_parse"]
        items.append({"id": f"invoice-{i}", "set": "invoice image", "image": str(f),
                      "truth": {"total": gt.get("summary", {}).get("total_gross_worth"),
                                "date": gt.get("header", {}).get("invoice_date"), "date_format": "mdy",
                                "supplier": gt.get("header", {}).get("seller"), "decimal_comma": True}})
    d = EVAL / "invoice2data"; d.mkdir(exist_ok=True)
    listing = http("https://api.github.com/repos/invoice-x/invoice2data/contents/tests/compare")
    names = {x["name"]: x["download_url"] for x in listing}
    for name, url in sorted(names.items()):
        if name.endswith(".pdf") and name[:-4] + ".json" in names:
            f = d / name
            if not f.exists():
                f.write_bytes(http(url, binary=True))
            gt = http(names[name[:-4] + ".json"])
            gt = gt[0] if isinstance(gt, list) else gt
            items.append({"id": "i2d-" + name[:-4], "set": "invoice2data PDF", "pdf": str(f),
                          "truth": {"total": gt.get("amount"), "date": str(gt.get("date"))[:10],
                                    "supplier": gt.get("issuer"), "currency": gt.get("currency")}})
    for c in json.loads((t.HERE / "eval_cases.json").read_text()):
        items.append({"id": "edge-" + c["name"], "set": "edge cases", "text": c["text"], "truth": c["truth"],
                      "reference_date": c.get("reference_date")})
    (EVAL / "items.json").write_text(json.dumps(items, indent=1, ensure_ascii=False))
    sets = {}
    for it in items:
        sets[it["set"]] = sets.get(it["set"], 0) + 1
    print(sets)
    size = sum(f.stat().st_size for f in EVAL.rglob("*") if f.is_file())
    print(f"eval folder: {size / 1e6:.1f} MB")


# ---------- run ----------

def run_one(it):
    text, images, route = it.get("text", ""), [], "text"
    if "image" in it:
        blob = pathlib.Path(it["image"]).read_bytes()
        if len(blob) > t.MAX_IMAGE:
            blob = t.shrink(blob, ".jpg")
        images, route = [(blob, "image/jpeg")], "image"
    elif "pdf" in it:
        text, images, route = t.parts_of(pathlib.Path(it["pdf"]))
    body = t.clairic_body(text, images, it.get("reference_date"))
    out = {"id": it["id"], "route": route}
    if not (t.has_text(text) or images):
        out["error"] = "nothing to send"
        return out
    res = None
    for _ in range(3):
        res = t.post("/run/@cf/cloudflare/clairic", json.dumps(body).encode(), "application/json")
        if res.get("success"):
            break
    if not res.get("success"):
        out["error"] = str(res.get("errors"))[:300]
        return out
    r = res["result"]
    out["answers"] = {k: {"value": v.get("value"), "confidence": v.get("confidence"), "p_null": v.get("p_null")}
                      for k, v in r.get("answers", {}).items()}
    out["tokens"] = r.get("usage", {}).get("input_tokens")
    out["truncated"] = r.get("truncated")
    return out


def run():
    t.env()  # exit early if the credentials are missing
    items = json.loads((EVAL / "items.json").read_text())
    done = {json.loads(l)["id"] for l in RESULTS.read_text().splitlines()} if RESULTS.exists() else set()
    todo = [it for it in items if it["id"] not in done]
    print(f"{len(todo)} to run, {len(done)} already done", flush=True)
    with RESULTS.open("a") as fh, concurrent.futures.ThreadPoolExecutor(4) as pool:
        for n, out in enumerate(pool.map(run_one, todo), 1):
            fh.write(json.dumps(out, ensure_ascii=False) + "\n")
            fh.flush()
            if n % 20 == 0:
                print(f"  {n}/{len(todo)}", flush=True)
    print("done")


# ---------- score ----------

def number(s, thousands=False, decimal_comma=False):
    """Parse a ground-truth amount string."""
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return float(s)
    s = re.sub(r"[^\d.,\-]", "", str(s))
    if not re.search(r"\d", s):
        return None
    if thousands:  # Indonesian receipts: every dot or comma is a thousands separator
        return float(re.sub(r"[.,]", "", s))
    if decimal_comma:
        s = s.replace(".", "").replace(",", ".")
    elif "," in s and "." in s:
        s = s.replace(",", "")
    elif "," in s and re.search(r",\d{2}$", s):
        s = s.replace(",", ".")
    else:
        s = s.replace(",", "")
    try:
        return float(s)
    except ValueError:
        return None


DATE_FORMATS = ["%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y", "%d/%m/%y", "%d-%m-%y", "%d.%m.%y", "%d %b %Y",
                "%d %B %Y", "%d-%b-%Y", "%d-%b-%y", "%d %b %y", "%b %d, %Y", "%B %d, %Y", "%Y/%m/%d", "%d%b%Y",
                "%d %b. %Y", "%Y%m%d"]


def date(s, fmt=None):
    if not s or s == "None":
        return None
    s = str(s).strip()
    for f in (["%m/%d/%Y"] if fmt == "mdy" else DATE_FORMATS):
        for cand in (s, s.split(" ")[0], " ".join(s.split(" ")[:3])):
            try:
                return datetime.datetime.strptime(cand.strip().title() if "%b" in f or "%B" in f else cand.strip(), f).date().isoformat()
            except ValueError:
                pass
    return None


STOP = {"sdn", "bhd", "ltd", "limited", "inc", "llc", "gmbh", "co", "the", "plc", "s", "a", "pte", "and"}


def words(s):
    return {w for w in re.findall(r"[a-z0-9]+", str(s or "").lower()) if w not in STOP}


def supplier_ok(answer, truth):
    a, b = words(answer), words(truth)
    return bool(a) and bool(b) and len(a & b) / len(a) >= 0.5


CURRENCY = {"gbp": {"£", "gbp"}, "usd": {"$", "us$", "usd"}, "eur": {"€", "eur"}, "inr": {"₹", "inr", "rs", "rs."},
            "pln": {"zł", "pln"}, "jpy": {"¥", "jpy", "円"}, "chf": {"chf"}, "aud": {"a$", "aud", "$"},
            "cad": {"c$", "cad", "$"}, "sek": {"kr", "sek"}}


def currency_ok(answer, truth):
    a = str(answer or "").strip().lower()
    return a in CURRENCY.get(str(truth).lower(), {str(truth).lower()})


def score():
    items = {it["id"]: it for it in json.loads((EVAL / "items.json").read_text())}
    results = [json.loads(l) for l in RESULTS.read_text().splitlines()]
    table, fails, gate = {}, [], []
    for r in results:
        it = items[r["id"]]
        tr, row = it["truth"], table.setdefault(it["set"], {})

        def tally(field, ok):
            c = row.setdefault(field, [0, 0])
            c[0] += bool(ok)
            c[1] += 1

        if "error" in r:
            tally("errors", False)
            fails.append((it["set"], r["id"], "ERROR", r["error"][:120]))
            continue
        a = r["answers"]
        if "total" in tr:
            want, got = number(tr["total"], tr.get("thousands"), tr.get("decimal_comma")), a["total"]["value"]
            if tr.get("expect_null"):
                ok = got is None
                tally("null when not a receipt", ok)
            elif want is not None:
                ok = got is not None and abs(float(got) - want) < 0.006
                tally("total", ok)
                gate.append((a["total"]["confidence"] or 0, ok, it["set"]))
                if not ok and got is not None and want and abs(float(got) * 1000 - want) < 1:
                    tally("total wrong by x1000", True)
            else:
                ok = True
            if not ok:
                fails.append((it["set"], r["id"], "total", f"want {tr['total']!r} got {got!r} conf {a['total']['confidence']}"))
        if tr.get("date"):
            want = date(tr["date"], tr.get("date_format"))
            if want:
                got = a["date"]["value"]
                ok = got == want
                ambiguous = tr.get("date_format") == "mdy" and int(want[8:]) <= 12 and want[5:7] != want[8:]
                tally("date (ambiguous US format)" if ambiguous else "date", ok)
                if not ok:
                    fails.append((it["set"], r["id"], "date", f"want {want} ({tr['date']!r}) got {got!r}"))
        if tr.get("supplier"):
            ok = supplier_ok(a["supplier"]["value"], tr["supplier"])
            tally("supplier", ok)
            if not ok:
                fails.append((it["set"], r["id"], "supplier", f"want {tr['supplier'][:40]!r} got {a['supplier']['value']!r}"))
        if tr.get("currency"):
            ok = currency_ok(a["currency"]["value"], tr["currency"])
            tally("currency", ok)
            if not ok:
                fails.append((it["set"], r["id"], "currency", f"want {tr['currency']!r} got {a['currency']['value']!r}"))
    print("\nACCURACY (correct / scored)")
    for name, row in table.items():
        print(f"  {name:20}", "  ".join(f"{k}: {v[0]}/{v[1]}" for k, v in row.items()))
    print("\nCONFIDENCE GATE ON THE TOTAL (all sets)")
    for th in (0.5, 0.7, 0.8, 0.9, 0.95):
        kept = [ok for c, ok, _ in gate if c >= th]
        wrong = len(kept) - sum(kept)
        print(f"  conf >= {th}: keeps {len(kept)}/{len(gate)}, of which wrong {wrong}"
              f" ({(100 * wrong / len(kept)) if kept else 0:.1f}%)")
    tok = [r["tokens"] for r in results if r.get("tokens")]
    print(f"\nTOKENS: {sum(tok):,} total over {len(tok)} calls, mean {sum(tok) // max(len(tok), 1):,}")
    print(f"\nFAILURES ({len(fails)})")
    for f in fails:
        print("  ", " | ".join(f))


def check():
    """Offline self-check: no network, no credentials."""
    fields = json.loads((t.HERE.parent / "src" / "read" / "fields.json").read_text())
    body = t.clairic_body("x", [(b"img", "image/png")], "2026-11-15")
    assert body["fields"] == fields and body["model"] == "clairic" and body["state"] == "x"
    assert body["images"][0]["content_type"] == "image/png" and body["reference_date"] == "2026-11-15"
    bare = t.clairic_body("x", [])
    assert set(bare) == {"model", "state", "fields"}, bare.keys()
    print("ok: request carries the fields from src/read/fields.json")


COMMANDS = {"fetch": fetch, "run": run, "score": score, "check": check}

if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        sys.exit(__doc__)
    COMMANDS[sys.argv[1]]()
