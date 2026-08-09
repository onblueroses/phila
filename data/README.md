# Fine-tuning data

The fine-tuning corpora are not kept in this repository. `CHECKSUMS.sha256` records the SHA-256 of every file that the pipeline produces, so a regenerated copy can be checked against the one used for the results in [FINDINGS.md](../FINDINGS.md).

## Why they are not here

The v3 corpus is built partly from third-party sources that this repository cannot redistribute under its own license:

| Source | Files | Terms |
|---|---|---|
| AMI Meeting Corpus | `v3-finetune/ami-raw.json`, `v3-finetune/gate-ami.jsonl` | CC BY 4.0. Redistribution requires attribution, which a blanket MIT header does not give. |
| Television transcripts | `v3-finetune/friends-raw.json`, `v3-finetune/gate-friends*.jsonl` | Copyrighted. Used here to transform multi-speaker dialogue into gate-decision examples; not redistributable. |
| Model-generated | `v3-finetune/adversarial-opus*`, `gate-synthetic*`, `gate-opus-independent*`, `memory-*` | Generated for this project. |

`train-v3.jsonl` merges all of the above. `compile-train-v4.ts` reads `train-v3.jsonl`, and `compile-train-v5.ts` reads `train-v4.jsonl`, so every later generation inherits the same constraint. The compiled sets that were held out for the same reason are `research/finetune-data/phila-ft-v4.1-train.jsonl` and `phila-ft-v5-train.jsonl`; the three `v4.1-*.jsonl` files beside them are generated for this project and remain in the repository.

The MIT license at the repository root covers the code. It does not, and cannot, cover the third-party material above.

## Regenerating

```bash
bash research/v3-finetune/run-all-generators.sh   # v3 gate + memory corpora
npx tsx research/compile-train-v4.ts              # v4 from v3
npx tsx research/compile-train-v5.ts              # v5 from v4
sha256sum -c data/CHECKSUMS.sha256                # verify against the published run
```

The generators need an OpenRouter key (`research/v3-finetune/openrouter-client.ts`). The AMI and transcript inputs must be obtained from their own sources; the transformers in `research/v3-finetune/` expect the raw JSON shapes documented there.

Model-generated portions will not reproduce byte-for-byte across runs, so expect checksum mismatches on those files and matches on the deterministic transforms.
