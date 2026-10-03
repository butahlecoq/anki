"""Emit a reproducible new-card FSRS reference from official Anki 26.9.3.

Run with: uv run --with anki==26.9.3 python scripts/verify-scheduler-oracle.py
This uses only a temporary collection and synthetic note; no account or network.
"""

from datetime import datetime, timedelta, timezone
from importlib.metadata import version
import json
from pathlib import Path
from tempfile import TemporaryDirectory

from anki.collection import Collection
from anki.deck_config_pb2 import UpdateDeckConfigsRequest, UpdateDeckConfigsMode
from anki.scheduler_pb2 import CardAnswer


ANKI_VERSION = "26.9.3"
CARD_ID = 1234567890000


def verify_selected_deck_limits(path: Path) -> dict[str, int]:
    collection = Collection(str(path))
    try:
        parent_config = collection.decks.config_dict_for_deck_id(1)
        parent_config["new"]["perDay"] = 1
        collection.decks.update_config(parent_config)

        child = collection.decks.add_normal_deck_with_name("Default::Child")
        child_config_id = collection.decks.add_config_returning_id(
            "Child limit", clone_from=collection.decks.config_dict_for_deck_id(1)
        )
        child_config = collection.decks.get_config(child_config_id)
        child_config["new"]["perDay"] = 2
        collection.decks.update_config(child_config)
        child_deck = collection.decks.get(child.id)
        collection.decks.set_config_id_for_deck_dict(child_deck, child_config_id)
        collection.decks.save(child_deck)

        for offset in range(3):
            note = collection.new_note(collection.models.by_name("Basic"))
            note.fields = [f"child {offset}", f"子{offset}"]
            collection.add_note(note, child.id)

        collection.decks.select(1)
        parent_queue = collection.sched.get_queued_cards(fetch_limit=100)
        # Select the child explicitly for the second gather; Anki ignores the
        # parent cap unless Limits Start From The Top is enabled.
        collection.decks.select(child.id)
        child_queue = collection.sched.get_queued_cards(fetch_limit=100)
        result = {
            "selectedParentNewCount": parent_queue.new_count,
            "selectedParentGatheredCards": len(parent_queue.cards),
            "selectedChildNewCount": child_queue.new_count,
            "selectedChildGatheredCards": len(child_queue.cards),
        }
        assert result == {
            "selectedParentNewCount": 1,
            "selectedParentGatheredCards": 1,
            "selectedChildNewCount": 2,
            "selectedChildGatheredCards": 2,
        }, result
        return result
    finally:
        collection.close()


def verify_default_queue_mixing(path: Path) -> dict[str, object]:
    collection = Collection(str(path))
    try:
        config = collection.decks.config_dict_for_deck_id(1)
        assert config["newMix"] == 0
        assert config["interdayLearningMix"] == 0
        card_ids = []
        for offset in range(7):
            note = collection.new_note(collection.models.by_name("Basic"))
            note.fields = [f"mix {offset}", f"混合{offset}"]
            collection.add_note(note, 1)
            card_ids.append(int(collection.db.scalar("select id from cards where nid = ?", note.id)))

        today = collection.sched.today
        for card_id in card_ids[2:]:
            collection.db.execute(
                "update cards set type=2, queue=2, due=?, ivl=10 where id=?",
                today,
                card_id,
            )

        queued = collection.sched.get_queued_cards(fetch_limit=100)
        order = ["new" if card.card.ctype == 0 else "review" for card in queued.cards]
        assert order == ["review", "review", "new", "review", "review", "new", "review"], order
        return {"newMix": config["newMix"], "interdayLearningMix": config["interdayLearningMix"], "queueOrder": order}
    finally:
        collection.close()


def main() -> None:
    actual_version = version("anki")
    assert actual_version == ANKI_VERSION, (actual_version, ANKI_VERSION)

    with TemporaryDirectory(prefix="kiroku-scheduler-oracle-") as directory:
        collection = Collection(str(Path(directory) / "oracle.anki2"))
        try:
            update = collection.decks.get_deck_configs_for_update(1)
            for entry in update.all_config:
                config = entry.config.config
                config.ClearField("fsrs_params_6")
                config.fsrs_params_6.extend(update.defaults.config.fsrs_params_6)
            request = UpdateDeckConfigsRequest(
                target_deck_id=1,
                mode=UpdateDeckConfigsMode.UPDATE_DECK_CONFIGS_MODE_NORMAL,
                fsrs=True,
            )
            for entry in update.all_config:
                request.configs.add().CopyFrom(entry.config)
            request.limits.CopyFrom(update.current_deck.limits)
            request.fsrs_health_check = update.fsrs_health_check
            collection.decks.update_deck_configs(request)
            collection.fsrs_short_term_with_steps_enabled = True

            config = collection.decks.config_dict_for_deck_id(1)
            rollover_hour = collection.conf.get("rollover", 4)
            assert len(config["fsrsParams6"]) == len(update.defaults.config.fsrs_params_6) == 21, config["fsrsParams6"]
            assert all(
                abs(actual - expected) < 0.00001
                for actual, expected in zip(config["fsrsParams6"], update.defaults.config.fsrs_params_6)
            )
            assert config["desiredRetention"] == 0.9
            assert config["new"]["delays"] == [1.0, 10.0]
            assert config["lapse"]["delays"] == [10.0]
            assert config["new"]["perDay"] == 20
            assert config["rev"]["perDay"] == 200
            assert rollover_hour == 4, rollover_hour

            easy_days_by_id = {}
            labels = []
            review_days_by_grade = {"Again": [], "Hard": [], "Good": [], "Easy": []}
            first_review_labels = []
            first_review_days = {}
            for offset in range(512):
                note = collection.new_note(collection.models.by_name("Basic"))
                note.fields = [f"猫{offset}", "cat"]
                collection.add_note(note, 1)
                generated_id = collection.db.scalar("select id from cards where nid = ?", note.id)
                card_id = CARD_ID + offset
                collection.db.execute("update cards set id = ? where id = ?", card_id, generated_id)
                states = collection._backend.get_scheduling_states(card_id)
                current_labels = [label.replace("\u2068", "").replace("\u2069", "") for label in collection.sched.describe_next_states(states)]
                if offset == 0:
                    labels = current_labels
                easy_days_by_id[card_id] = states.easy.normal.review.scheduled_days

                card = collection.get_card(card_id)
                card.start_timer()
                answer = collection.sched.build_answer(card=card, states=states, rating=CardAnswer.EASY)
                answer.answered_at_millis = int((datetime.now(timezone.utc) - timedelta(days=8)).timestamp() * 1000)
                collection.sched.answer_card(answer)
                review_states = collection._backend.get_scheduling_states(card_id)
                review_labels = [label.replace("\u2068", "").replace("\u2069", "") for label in collection.sched.describe_next_states(review_states)]
                if offset == 0:
                    first_review_labels = review_labels
                for grade in review_days_by_grade:
                    choice_state = getattr(review_states, grade.lower()).normal.review
                    review_days_by_grade[grade].append(choice_state.scheduled_days)
                    if offset == 0:
                        first_review_days[grade] = choice_state.scheduled_days

            review_ranges = {
                grade: {"min": min(days), "max": max(days)}
                for grade, days in review_days_by_grade.items()
                if days
            }

            easy_days = easy_days_by_id[CARD_ID]
            easy_range = {"min": min(easy_days_by_id.values()), "max": max(easy_days_by_id.values())}

            assert labels[:3] == ["<1m", "<6m", "<10m"], labels
            assert easy_days == 8, easy_days
            assert easy_range == {"min": 6, "max": 10}, easy_range
            assert first_review_labels == ["<10m", "28d", "1.3mo", "2.2mo"], first_review_labels
            selected_deck_limits = verify_selected_deck_limits(Path(directory) / "queue-oracle.anki2")
            default_queue_mixing = verify_default_queue_mixing(Path(directory) / "mixing-oracle.anki2")
            print(json.dumps({
                "ankiVersion": actual_version,
                "scheduler": "V3",
                "algorithm": "FSRS-6",
                "fsrsParams6": config["fsrsParams6"],
                "desiredRetention": config["desiredRetention"],
                "learningStepsMinutes": config["new"]["delays"],
                "relearningStepsMinutes": config["lapse"]["delays"],
                "dailyNewLimit": config["new"]["perDay"],
                "dailyReviewLimit": config["rev"]["perDay"],
                "studyDayRolloverHour": rollover_hour,
                "nativeCardId": CARD_ID,
                "newCardChoices": labels,
                "easyScheduledDays": easy_days,
                "nativeEasyIntervalRangeFor64CardIds": easy_range,
                "firstGraduatedCardReviewChoices": first_review_labels,
                "firstGraduatedCardReviewScheduledDays": first_review_days,
                "nativeReviewIntervalRangesFor512CardIds": review_ranges,
                "nativeSelectedDeckLimits": selected_deck_limits,
                "nativeDefaultQueueMixing": default_queue_mixing,
            }, indent=2))
        finally:
            collection.close()


if __name__ == "__main__":
    main()
