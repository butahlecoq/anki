"""Independent package checks with official Anki. Uses only synthetic fixtures.

Generate fixtures: KIROKU_NATIVE_EXPORT_FIXTURE=1 npx vitest run src/anki-export.test.ts
Run with a Python environment containing the official `anki` package:
python scripts/verify-anki-export.py runtime/export-interop
"""
import hashlib
import json
import math
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

from anki.collection import Collection
from anki.import_export_pb2 import ImportAnkiPackageRequest


def verify(package: Path) -> dict:
    expected = json.loads(package.with_suffix('.json').read_text(encoding='utf-8'))
    with TemporaryDirectory(prefix='kiroku-export-interop-') as temporary:
        col = Collection(str(Path(temporary) / 'collection.anki2'))
        try:
            request = ImportAnkiPackageRequest(package_path=str(package.resolve()))
            request.options.with_scheduling = True
            col.import_anki_package(request)
            assert col.note_count() == len(expected['notes'])
            assert col.card_count() == len(expected['cards'])
            for source in expected['notes']:
                note = col.get_note(source['id'])
                assert note.guid == source['guid']
                assert note.fields == source['flds'].split('\x1f')
                assert sorted(note.tags) == sorted(source['tags'].split())
                assert note.mid == source['mid']
            for source in expected['cards']:
                card = col.get_card(source['id'])
                # Native package imports match/create decks by name and can
                # assign a new numeric deck ID; compare its meaning.
                expected_deck = next(deck['name'] for deck in expected['decks'] if deck['id'] == source['did'])
                assert col.decks.get(card.did)['name'] == expected_deck
                for key in ['nid', 'ord', 'type', 'queue', 'ivl', 'reps', 'lapses', 'flags']:
                    assert getattr(card, key) == source[key], (key, getattr(card, key), source[key])
                if source['data']:
                    memory = json.loads(source['data'])
                    native_memory = json.loads(col.db.scalar('select data from cards where id = ?', card.id))
                    for key in ['s', 'd']:
                        if key in memory:
                            # Anki normalizes FSRS memory to three decimals.
                            assert math.isclose(native_memory[key], memory[key], rel_tol=1e-6, abs_tol=0.00051), (key, native_memory[key], memory[key])
                assert card.question(), 'Native Anki could not render a question'
                assert card.answer(), 'Native Anki could not render an answer'
            actual_reviews = col.db.all('select id,cid,ease,ivl,lastIvl,factor,time,type from revlog order by id')
            expected_reviews = [[r[k] for k in ['id', 'cid', 'ease', 'ivl', 'lastIvl', 'factor', 'time', 'type']] for r in sorted(expected['reviews'], key=lambda r: r['id'])]
            assert actual_reviews == expected_reviews, (actual_reviews, expected_reviews)
            for field in expected['fields']:
                model = col.models.get(field['ntid'])
                assert model['flds'][field['ord']]['name'] == field['name']
            for media in expected['media']:
                stored = Path(col.media.dir()) / media['name']
                assert hashlib.sha256(stored.read_bytes()).hexdigest() == media['digest']
            return {'package': package.name, 'notes': col.note_count(), 'cards': col.card_count(), 'reviews': len(actual_reviews), 'media': len(expected['media']), 'result': 'passed'}
        finally:
            col.close()


if __name__ == '__main__':
    fixtures = Path(sys.argv[1] if len(sys.argv) > 1 else 'runtime/export-interop')
    packages = sorted(fixtures.glob('*.apkg'))
    assert packages, 'Generate the synthetic export fixtures first'
    print(json.dumps([verify(package) for package in packages], indent=2))
