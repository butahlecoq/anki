"""Verify default learning-queue repetition with official Anki 26.9.3.

Run: uv run --with anki==26.9.3 python scripts/verify-learning-queue-oracle.py
Uses a temporary synthetic collection; verifies queue behavior, not FSRS intervals.
"""

import json
import time
from importlib.metadata import version
from pathlib import Path
from tempfile import TemporaryDirectory
from anki.collection import Collection
from anki.scheduler_pb2 import CardAnswer

assert version('anki') == '26.9.3', 'Use the pinned official Anki 26.9.3 wheel.'
with TemporaryDirectory() as directory:
    collection = Collection(str(Path(directory) / 'synthetic.anki2'))
    note = collection.new_note(collection.models.by_name('Basic'))
    note.fields = ['synthetic learning card', 'synthetic answer']
    collection.add_note(note, 1)
    collection.decks.select(1)
    card = collection.sched.getCard()
    states = collection._backend.get_scheduling_states(card.id)
    labels = collection.sched.describe_next_states(states)
    answer = collection.sched.build_answer(card=card, states=states, rating=CardAnswer.HARD)
    collection.sched.answer_card(answer)
    stored = collection.get_card(card.id)
    repeated = collection.sched.getCard()
    result = {'learnAheadSeconds': collection.get_preferences().scheduling.learn_ahead_secs,
              'labels': list(labels), 'hardDelaySeconds': stored.due - int(time.time()),
              'repeatedCardId': repeated.id if repeated else None,
              'sameCard': repeated is not None and repeated.id == card.id}
    collection.close()
    assert result['sameCard'], result
    assert result['learnAheadSeconds'] == 1200, result
    assert 0 < result['hardDelaySeconds'] <= 1200, result
    print(json.dumps(result))
