#!/usr/bin/env python3
"""
faster-whisper transcription sidecar.

Usage:
    python transcribe.py <audio_file> [--model base.en] [--language en]

Stdout: one JSON line — {"segments": [...]} on success, {"error": "..."} on failure
Stderr: progress lines  — {"progress": 0.0..1.0}
"""

import sys
import json
import argparse
import os


def progress(value: float) -> None:
    print(json.dumps({"progress": round(value, 3)}), file=sys.stderr, flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_file")
    parser.add_argument("--model", default="base.en")
    parser.add_argument("--language", default=None)
    args = parser.parse_args()

    if not os.path.exists(args.audio_file):
        print(json.dumps({"error": f"File not found: {args.audio_file}"}), flush=True)
        sys.exit(1)

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(
            json.dumps({
                "error": (
                    "faster-whisper is not installed.\n"
                    "Run:  pip install faster-whisper\n"
                    "Then restart the app."
                )
            }),
            flush=True,
        )
        sys.exit(1)

    progress(0.0)

    # faster-whisper doesn't support Apple MPS; CPU + int8 is fast enough
    model = WhisperModel(
        args.model,
        device="cpu",
        compute_type="int8",
        download_root=os.path.expanduser("~/.cache/video-editor/whisper-models"),
    )

    progress(0.05)

    segments_iter, info = model.transcribe(
        args.audio_file,
        word_timestamps=True,
        language=args.language,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
    )

    total_duration = info.duration if info.duration and info.duration > 0 else None
    words = []

    for segment in segments_iter:
        if total_duration:
            progress(0.05 + 0.93 * min(segment.start / total_duration, 1.0))

        if segment.words:
            for w in segment.words:
                text = w.word.strip()
                if not text:
                    continue
                words.append({
                    "start": round(w.start, 3),
                    "end": round(w.end, 3),
                    "text": text,
                    "confidence": round(float(w.probability), 4),
                })

    progress(1.0)
    print(json.dumps({"segments": words}), flush=True)


if __name__ == "__main__":
    main()
