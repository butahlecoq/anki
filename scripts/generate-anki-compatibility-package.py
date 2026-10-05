"""Generate a small, private-terms Anki 26.09.3 compatibility package.

Run from the repository root with:
  uv run --with anki==26.09.3 python scripts/generate-anki-compatibility-package.py

The output contains only synthetic Kiroku-authored text and generated media and
is written under ignored .runtime/; it is not a redistributable fixture.
"""

from __future__ import annotations

import argparse
from hashlib import sha256
from importlib.metadata import version
import json
from pathlib import Path
import tempfile

from anki.collection import Collection


ANKI_RELEASE = "26.09.3"
ANKI_SOURCE_COMMIT = "29bb700"
OUTPUT = Path(".runtime/compatibility/anki-26.09.3.colpkg")


def generated_wav() -> bytes:
    samples = 800
    output = bytearray(54 + samples)

    def text(offset: int, value: str) -> None:
        output[offset : offset + len(value)] = value.encode("ascii")

    text(0, "RIFF")
    output[4:8] = (len(output) - 8).to_bytes(4, "little")
    text(8, "WAVE")
    text(12, "fmt ")
    output[16:20] = (16).to_bytes(4, "little")
    output[20:22] = (1).to_bytes(2, "little")
    output[22:24] = (1).to_bytes(2, "little")
    output[24:28] = (8000).to_bytes(4, "little")
    output[28:32] = (8000).to_bytes(4, "little")
    output[32:34] = (1).to_bytes(2, "little")
    output[34:36] = (8).to_bytes(2, "little")
    text(36, "JUNK")
    output[40:44] = (1).to_bytes(4, "little")
    output[44] = 1
    text(46, "data")
    output[50:54] = samples.to_bytes(4, "little")
    output[54:] = bytes([128] * samples)
    return bytes(output)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    if version("anki") != "26.9.3":
        raise SystemExit(f"Expected official Anki Python package {ANKI_RELEASE}; found {version('anki')}.")

    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="kiroku-anki-corpus-") as temporary:
        collection = Collection(str(Path(temporary) / "source.anki2"))
        try:
            source_deck = collection.decks.id("Kiroku Corpus::Source")
            notetype = collection.models.new("Kiroku corpus reverse card")
            collection.models.add_field(notetype, collection.models.new_field("Front"))
            collection.models.add_field(notetype, collection.models.new_field("Back"))
            collection.models.add_field(notetype, collection.models.new_field("Audio"))

            forward = collection.models.new_template("Forward")
            forward["qfmt"] = "{{Front}}<br>{{Audio}}"
            forward["afmt"] = "{{FrontSide}}<hr>{{Back}}"
            collection.models.add_template(notetype, forward)
            reverse = collection.models.new_template("Reverse")
            reverse["qfmt"] = "{{Back}}"
            reverse["afmt"] = "{{Front}}"
            collection.models.add_template(notetype, reverse)
            notetype["css"] = ".card { font-family: sans-serif; }"
            collection.models.add(notetype)

            wav = generated_wav()
            collection.media.write_data("generated-tone.wav", wav)
            content = [("猫", "ねこ", "[sound:generated-tone.wav]"), ("犬", "いぬ", "[sound:generated-tone.wav]")]
            for front, back, audio in content:
                note = collection.new_note(notetype)
                note["Front"] = front
                note["Back"] = back
                note["Audio"] = audio
                collection.add_note(note, source_deck)

            filtered = collection.sched.get_or_create_filtered_deck(0)
            filtered.name = "Kiroku Corpus::Filtered Practice"
            del filtered.config.search_terms[:]
            term = filtered.config.search_terms.add()
            term.search = 'deck:"Kiroku Corpus::Source" is:new'
            term.limit = 20
            collection.sched.add_or_update_filtered_deck(filtered)
            filtered_id = collection.decks.id(filtered.name, create=False)
            if filtered_id is None:
                raise RuntimeError("The official Anki engine did not create the filtered deck.")
            collection.sched.rebuild_filtered_deck(filtered_id)
            filtered_card_count = collection.db.scalar(
                "select count() from cards where did = ? and odid = ?", filtered_id, source_deck
            )
            collection.export_collection_package(str(output), include_media=True, legacy=False)
        finally:
            collection.close()

    manifest = {
        "format": "colpkg",
        "ankiRelease": ANKI_RELEASE,
        "ankiSourceCommit": ANKI_SOURCE_COMMIT,
        "ankiPythonDistributionVersion": version("anki"),
        "command": "uv run --with anki==26.09.3 python scripts/generate-anki-compatibility-package.py",
        "source": "Official Anki Python package and collection exporter at the pinned release; package authored for Kiroku tests.",
        "contentLicense": "CC0-1.0 (Kiroku-authored synthetic Japanese text and generated tone only).",
        "redistribution": "Do not commit or redistribute the generated .colpkg. It is ephemeral and regenerated on demand.",
        "notes": [{"front": front, "back": back} for front, back, _audio in content],
        "sourceDeck": "Kiroku Corpus::Source",
        "filteredDeck": {"name": "Kiroku Corpus::Filtered Practice", "cardCount": filtered_card_count, "originDeck": "Kiroku Corpus::Source"},
        "media": [{"name": "generated-tone.wav", "sha256": sha256(wav).hexdigest(), "byteLength": len(wav), "mimeType": "audio/wav"}],
        "sha256": sha256(output.read_bytes()).hexdigest(),
        "byteLength": output.stat().st_size,
    }
    output.with_suffix(".json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "release": ANKI_RELEASE, "bytes": manifest["byteLength"], "sha256": manifest["sha256"]}))


if __name__ == "__main__":
    main()
