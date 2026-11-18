# Reader regression eval

This eval scores the Clairic model against public, labelled receipt and invoice datasets. It catches a drop in reading quality before the Worker ships it.

The eval and the Worker read the same field instructions from `src/read/fields.json`.

## Run it

1. Set `CLOUDFLARE_API_TOKEN` (Workers AI permission) and `CLOUDFLARE_ACCOUNT_ID` in your shell. The scripts read only these two variables.
2. `python3 eval/clairic_eval.py fetch` downloads the datasets into `eval/eval/`. It is free and git ignores the folder.
3. `python3 eval/clairic_eval.py run` sends every item to Clairic. A full run costs about $0.10 of Workers AI. The run can resume after a stop.
4. `python3 eval/clairic_eval.py score` prints the accuracy tables and the failures.

`python3 eval/clairic_eval.py check` runs offline. It confirms the request carries exactly the fields in `src/read/fields.json`.

## When to rerun

Rerun after a change to:

- the Clairic model or its version,
- the field instructions in `src/read/fields.json`,
- the text extraction (`toMarkdown` options, or how the Worker builds `state`).

## Expected scores

From the 2026-11-15 run:

- SROIE images: 40 of 40 totals.
- SROIE text: 40 of 40.
- invoice2data: 10 of 10.
- Edge cases: 19 of 20.

The repo copy was run on 2026-11-15 after the move and gave the same four totals. The run used 1,292,530 tokens over 153 calls, about $0.13.

On 2026-11-18 the PDF text got a line break where a digit is followed directly by a capitalised word (`splitJoinedBlocks` in `src/read/pdf.ts`, mirrored in `clairic_test.py`). The 11 invoice2data PDFs were run again: total 10 of 10, date 9 of 11 and currency 9 of 11 as before; supplier 4 of 11, was 5 of 11 (`SammyMaystoneLinesTest` changed).

The eval also scores two image sets that have no pass mark: CORD phone photos (12 of 19 totals; the misses are Indonesian thousands separators) and invoice page images (19 of 20 totals). The Worker's confidence gate covers these: at confidence 0.7 or more, 2 of 122 totals were wrong.

## Where the eval differs from the Worker

- The eval calls the Workers AI REST API. The Worker uses the `AI` binding.
- The eval has no Images binding. It resizes images with macOS `sips`, so it needs a Mac.
- The eval converts PDFs with the REST `tomarkdown` endpoint, not the binding.
- The eval sends the model path `@cf/cloudflare/clairic` in the URL. The Worker takes it from `CLAIRIC_MODEL`.
- The eval sends an empty `state` with an image. The Worker sends the email subject and body.
- The eval sends `reference_date` only for edge cases that set one.
- The eval does not score `date_text`.
