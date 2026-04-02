"""
Phila gate fine-tuning script.
Runs on Vast.ai RTX 4090 (or any 16GB+ VRAM GPU).
Reads /workspace/train.jsonl, fine-tunes llama3.2:3b via QLoRA, exports GGUF.

Usage: python3 finetune.py [--data /workspace/train.jsonl] [--out /workspace/phila-ft]
"""
import argparse
import json
import os
import sys
from pathlib import Path


def is_bfloat16_supported() -> bool:
    import torch
    return torch.cuda.is_bf16_supported()


def load_dataset(path: str):
    from datasets import Dataset
    examples = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                examples.append(json.loads(line))
    print(f"Loaded {len(examples)} training examples from {path}")
    return Dataset.from_list(examples)


def format_examples(dataset, tokenizer):
    def fmt(ex):
        # apply_chat_template converts messages[] to a single training string
        text = tokenizer.apply_chat_template(
            ex["messages"],
            tokenize=False,
            add_generation_prompt=False,
        )
        return {"text": text}

    return dataset.map(fmt, remove_columns=dataset.column_names)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default="/workspace/train.jsonl")
    parser.add_argument("--out", default="/workspace/phila-ft")
    args = parser.parse_args()

    print("=== Phila gate fine-tune: QLoRA + Unsloth ===")
    print(f"Data: {args.data}")
    print(f"Output: {args.out}")

    # Verify data file exists
    if not os.path.exists(args.data):
        sys.exit(f"ERROR: data file not found: {args.data}")

    import torch
    print(f"CUDA available: {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"GPU: {torch.cuda.get_device_name(0)}")
        print(f"VRAM: {torch.cuda.get_device_properties(0).total_memory / 1e9:.1f} GB")

    from unsloth import FastLanguageModel
    from trl import SFTTrainer
    from transformers import TrainingArguments

    print("\n=== Loading base model (4-bit) ===")
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name="unsloth/Llama-3.2-3B-Instruct",
        max_seq_length=2048,
        load_in_4bit=True,
        dtype=None,  # auto-detect
    )

    print("\n=== Adding LoRA adapters (r=16) ===")
    model = FastLanguageModel.get_peft_model(
        model,
        r=16,
        lora_alpha=16,
        lora_dropout=0,
        bias="none",
        use_gradient_checkpointing="unsloth",
        target_modules=[
            "q_proj", "k_proj", "v_proj", "o_proj",
            "gate_proj", "up_proj", "down_proj",
        ],
    )

    print("\n=== Loading training data ===")
    raw_dataset = load_dataset(args.data)
    dataset = format_examples(raw_dataset, tokenizer)
    print(f"Formatted {len(dataset)} examples")
    # Spot-check first example
    print("Sample (first 200 chars):", dataset[0]["text"][:200])

    print("\n=== Training ===")
    use_bf16 = is_bfloat16_supported()
    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=dataset,
        dataset_text_field="text",
        max_seq_length=2048,
        dataset_num_proc=2,
        args=TrainingArguments(
            per_device_train_batch_size=2,
            gradient_accumulation_steps=4,
            num_train_epochs=3,
            learning_rate=2e-4,
            warmup_steps=10,
            fp16=not use_bf16,
            bf16=use_bf16,
            logging_steps=20,
            output_dir="/workspace/checkpoints",
            report_to="none",
            save_strategy="no",
        ),
    )

    trainer_stats = trainer.train()
    print(f"\nTraining complete. Runtime: {trainer_stats.metrics['train_runtime']:.0f}s")
    print(f"Train loss: {trainer_stats.metrics['train_loss']:.4f}")

    print("\n=== Exporting to GGUF (q4_k_m) ===")
    # This merges adapter into base model at FP16, then quantizes to GGUF.
    # DO NOT import the raw adapter into Ollama - it produces garbage output silently.
    model.save_pretrained_gguf(args.out, tokenizer, quantization_method="q4_k_m")

    # Find the generated files
    out_dir = Path(args.out).parent
    gguf_files = list(out_dir.glob("phila-ft*.gguf"))
    modelfile_candidates = [
        out_dir / "Modelfile",
        out_dir / f"{Path(args.out).name}-q4_k_m.gguf",
    ]

    print("\n=== Output files ===")
    for f in sorted(out_dir.iterdir()):
        if f.name.startswith("phila-ft") or f.name == "Modelfile":
            size_mb = f.stat().st_size / 1e6
            print(f"  {f}: {size_mb:.1f} MB")

    # Write a completion marker
    marker = {
        "status": "complete",
        "train_runtime_s": trainer_stats.metrics["train_runtime"],
        "train_loss": trainer_stats.metrics["train_loss"],
        "gguf_files": [str(f) for f in gguf_files],
    }
    with open("/workspace/done.json", "w") as f:
        json.dump(marker, f, indent=2)
    print("\nCompletion marker written to /workspace/done.json")


if __name__ == "__main__":
    main()
