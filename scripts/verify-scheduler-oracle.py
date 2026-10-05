"""Emit a reproducible new-card FSRS reference from official Anki 26.9.3.

Run with: uv run --with anki==26.9.3 python scripts/verify-scheduler-oracle.py
This uses only a temporary collection and synthetic note; no account or network.
"""

from datetime import datetime, timedelta, timezone
from importlib.metadata import version
import argparse
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import time

from anki.collection import Collection
from anki.deck_config_pb2 import UpdateDeckConfigsRequest, UpdateDeckConfigsMode
from anki.scheduler_pb2 import CardAnswer


ANKI_VERSION = "26.9.3"
CARD_ID = 1234567890000
MATRIX_CARD_ID = CARD_ID + 10_000


def verify_persisted_state_grade_matrix(collection: Collection) -> list[dict[str, object]]:
    """Answer deterministic synthetic cards in each FSRS state and report durable rows."""
    # A fixed timestamp makes the native persisted-state matrix reproducible;
    # identifiers, review counts, profile settings and the RNG are fixed too.
    base_answer_at = datetime(2026, 10, 5, 4, 15, tzinfo=timezone.utc)
    answer_at = base_answer_at
    answer_millis = int(answer_at.timestamp() * 1000)
    today = collection.sched.today
    state_setup = {
        "New": (0, 0, 1, 0, 0, 0, 0),
        "Learning": (1, 1, int(answer_at.timestamp()) - 60, 0, 0, 0, 1001),
        "Review": (2, 2, today - 8, 8, 2, 0, 0),
        "Relearning": (3, 1, int(answer_at.timestamp()) - 60, 8, 2, 1, 1001),
    }
    grades = {
        "Again": CardAnswer.AGAIN,
        "Hard": CardAnswer.HARD,
        "Good": CardAnswer.GOOD,
        "Easy": CardAnswer.EASY,
    }
    outcomes: list[dict[str, object]] = []

    for state_name, (card_type, queue, due, interval, reps, lapses, left) in state_setup.items():
        for grade_name, grade in grades.items():
            answer_at = base_answer_at + timedelta(milliseconds=len(outcomes))
            answer_millis = int(answer_at.timestamp() * 1000)
            note = collection.new_note(collection.models.by_name("Basic"))
            note.fields = [f"matrix {state_name} {grade_name}", "synthetic"]
            collection.add_note(note, 1)
            generated_id = collection.db.scalar("select id from cards where nid = ?", note.id)
            card_id = MATRIX_CARD_ID + len(outcomes)
            collection.db.execute(
                "update cards set id=?, type=?, queue=?, due=?, ivl=?, reps=?, lapses=?, left=?, usn=-1 where id=?",
                card_id, card_type, queue, due, interval, reps, lapses, left, generated_id,
            )
            native_card = collection.get_card(card_id)
            native_card.start_timer()
            states = collection._backend.get_scheduling_states(card_id)
            preview_labels = [
                label.replace("\u2068", "").replace("\u2069", "")
                for label in collection.sched.describe_next_states(states)
            ]
            answer = collection.sched.build_answer(card=native_card, states=states, rating=grade)
            answer.answered_at_millis = answer_millis
            collection.sched.answer_card(answer)

            persisted = collection.db.first(
                "select type, queue, due, ivl, reps, lapses, data from cards where id = ?", card_id
            )
            review = collection.db.first(
                "select ease, ivl, lastIvl, type from revlog where cid = ? order by id desc limit 1", card_id
            )
            assert persisted is not None and review is not None, (state_name, grade_name)
            outcomes.append({
                "before": state_name,
                "grade": grade_name,
                "answeredAt": answer_at.isoformat(),
                "previewLabels": preview_labels,
                "card": {
                    "type": persisted[0], "queue": persisted[1], "due": persisted[2],
                    "intervalDays": persisted[3], "reps": persisted[4], "lapses": persisted[5],
                    "data": persisted[6],
                },
                "review": {
                    "grade": review[0], "intervalDays": review[1],
                    "previousIntervalDays": review[2], "type": review[3],
                },
            })
    assert len(outcomes) == 16
    return outcomes


def write_persisted_matrix_fixture(outcomes: list[dict[str, object]]) -> None:
    """Write the stable subset used by app tests; absolute due dates are omitted."""
    matrix = []
    for outcome in outcomes:
        card = outcome["card"]
        data = json.loads(card["data"] or "{}")
        matrix.append({
            "before": outcome["before"],
            "grade": outcome["grade"],
            "previewLabels": outcome["previewLabels"],
            "queue": card["queue"],
            "card": {
                "type": card["type"], "queue": card["queue"],
                "intervalDays": card["intervalDays"], "reps": card["reps"],
                "lapses": card["lapses"], "stability": data.get("s", 0),
                "difficulty": data.get("d", 0),
            },
            "review": outcome["review"],
        })
    target = Path(__file__).parent.parent / "tests" / "fixtures" / "anki-26.9.3-scheduler-matrix.json"
    target.write_text(json.dumps({
        "ankiVersion": ANKI_VERSION, "scheduler": "V3", "algorithm": "FSRS-6",
        "reviewedAt": outcomes[0]["answeredAt"], "matrix": matrix,
    }, indent=2) + "\n", encoding="utf-8")


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


def verify_review_limit_shares_capacity_with_new(path: Path) -> dict[str, object]:
    collection = Collection(str(path))
    try:
        config = collection.decks.config_dict_for_deck_id(1)
        config["rev"]["perDay"] = 2
        config["new"]["perDay"] = 20
        collection.decks.update_config(config)
        update = collection.decks.get_deck_configs_for_update(1)
        assert update.new_cards_ignore_review_limit is False

        card_ids = []
        for offset in range(4):
            note = collection.new_note(collection.models.by_name("Basic"))
            note.fields = [f"limit {offset}", f"上限{offset}"]
            collection.add_note(note, 1)
            card_ids.append(int(collection.db.scalar("select id from cards where nid = ?", note.id)))

        today = collection.sched.today
        collection.db.execute(
            "update cards set type=2, queue=2, due=?, ivl=10 where id=?",
            today,
            card_ids[0],
        )
        partial = collection.sched.get_queued_cards(fetch_limit=100)
        assert (partial.review_count, partial.new_count) == (1, 1), (partial.review_count, partial.new_count)

        collection.db.execute(
            "update cards set type=2, queue=2, due=?, ivl=10 where id=?",
            today,
            card_ids[1],
        )
        full = collection.sched.get_queued_cards(fetch_limit=100)
        assert (full.review_count, full.new_count) == (2, 0), (full.review_count, full.new_count)

        config["rev"]["perDay"] = 0
        collection.decks.update_config(config)
        zero = collection.sched.get_queued_cards(fetch_limit=100)
        assert (zero.review_count, zero.new_count, len(zero.cards)) == (0, 0, 0)
        return {
            "reviewLimit": 2,
            "oneDueReview": {"reviews": partial.review_count, "new": partial.new_count},
            "limitReached": {"reviews": full.review_count, "new": full.new_count},
            "zeroReviewLimit": {"reviews": zero.review_count, "new": zero.new_count},
        }
    finally:
        collection.close()


def verify_selected_parent_review_limit(path: Path) -> dict[str, int]:
    collection = Collection(str(path))
    try:
        parent_config = collection.decks.config_dict_for_deck_id(1)
        parent_config["new"]["perDay"] = 20
        parent_config["rev"]["perDay"] = 2
        collection.decks.update_config(parent_config)

        child = collection.decks.add_normal_deck_with_name("Default::Child")
        child_config_id = collection.decks.add_config_returning_id(
            "Child capacity", clone_from=collection.decks.config_dict_for_deck_id(1)
        )
        child_config = collection.decks.get_config(child_config_id)
        child_config["new"]["perDay"] = 10
        child_config["rev"]["perDay"] = 10
        collection.decks.update_config(child_config)
        child_deck = collection.decks.get(child.id)
        collection.decks.set_config_id_for_deck_dict(child_deck, child_config_id)
        collection.decks.save(child_deck)

        for offset in range(3):
            note = collection.new_note(collection.models.by_name("Basic"))
            note.fields = [f"nested {offset}", f"親{offset}"]
            collection.add_note(note, child.id)

        collection.decks.select(1)
        parent_queue = collection.sched.get_queued_cards(fetch_limit=100)
        collection.decks.select(child.id)
        child_queue = collection.sched.get_queued_cards(fetch_limit=100)
        result = {
            "selectedParentNewCount": parent_queue.new_count,
            "selectedParentReviewCount": parent_queue.review_count,
            "selectedChildNewCount": child_queue.new_count,
            "selectedChildReviewCount": child_queue.review_count,
        }
        assert result == {
            "selectedParentNewCount": 2,
            "selectedParentReviewCount": 0,
            "selectedChildNewCount": 3,
            "selectedChildReviewCount": 0,
        }, result
        return result
    finally:
        collection.close()


def verify_sibling_bury_categories(path: Path) -> dict[str, int]:
    collection = Collection(str(path))
    try:
        note = collection.new_note(collection.models.by_name("Cloze"))
        note.fields = ["{{c1::one}} {{c2::two}}", ""]
        collection.add_note(note, 1)
        card_ids = [int(row[0]) for row in collection.db.all("select id from cards where nid = ? order by ord", note.id)]
        assert len(card_ids) == 2, card_ids
        today = collection.sched.today
        config = collection.decks.config_dict_for_deck_id(1)

        config["rev"]["bury"] = True
        config["buryInterdayLearning"] = False
        collection.decks.update_config(config)
        for card_id in card_ids:
            collection.db.execute("update cards set type=2, queue=2, due=?, ivl=10 where id=?", today, card_id)
        review_queue = collection.sched.get_queued_cards(fetch_limit=100)
        assert review_queue.review_count == 1, review_queue.review_count

        config["rev"]["bury"] = False
        config["buryInterdayLearning"] = True
        collection.decks.update_config(config)
        for card_id in card_ids:
            collection.db.execute("update cards set type=1, queue=3, due=? where id=?", today, card_id)
        interday_queue = collection.sched.get_queued_cards(fetch_limit=100)
        assert interday_queue.learning_count == 1, interday_queue.learning_count

        config["rev"]["bury"] = True
        collection.decks.update_config(config)
        due_seconds = int(time.time()) - 60
        for card_id in card_ids:
            collection.db.execute("update cards set type=1, queue=1, due=? where id=?", due_seconds, card_id)
        intraday_queue = collection.sched.get_queued_cards(fetch_limit=100)
        assert intraday_queue.learning_count == 2, intraday_queue.learning_count

        return {
            "buriedReviewSiblings": 2 - review_queue.review_count,
            "buriedInterdayLearningSiblings": 2 - interday_queue.learning_count,
            "intradayLearningSiblingsKept": intraday_queue.learning_count,
        }
    finally:
        collection.close()


def verify_mixed_sibling_bury_precedence(path: Path) -> list[str]:
    collection = Collection(str(path))
    try:
        note = collection.new_note(collection.models.by_name("Cloze"))
        note.fields = ["{{c1::one}} {{c2::two}} {{c3::three}} {{c4::four}}", ""]
        collection.add_note(note, 1)
        card_ids = [int(row[0]) for row in collection.db.all("select id from cards where nid = ? order by ord", note.id)]
        assert len(card_ids) == 4, card_ids
        config = collection.decks.config_dict_for_deck_id(1)
        config["new"]["bury"] = True
        config["rev"]["bury"] = True
        config["buryInterdayLearning"] = True
        collection.decks.update_config(config)
        today = collection.sched.today
        due_seconds = int(time.time()) - 60
        categories = ["intraday", "interday", "review", "new"]
        winners = []

        for winner_index, winner in enumerate(categories):
            for index, card_id in enumerate(card_ids):
                category = categories[index]
                if category == "intraday":
                    collection.db.execute("update cards set type=1, queue=1, due=? where id=?", due_seconds, card_id)
                elif category == "interday":
                    collection.db.execute("update cards set type=1, queue=3, due=? where id=?", today, card_id)
                elif category == "review":
                    collection.db.execute("update cards set type=2, queue=2, due=?, ivl=10 where id=?", today, card_id)
                else:
                    collection.db.execute("update cards set type=0, queue=0, due=? where id=?", index + 1, card_id)
                if index < winner_index:
                    collection.db.execute("update cards set queue=-1 where id=?", card_id)

            queue = collection.sched.get_queued_cards(fetch_limit=100)
            total = queue.learning_count + queue.review_count + queue.new_count
            assert total == 1 and len(queue.cards) == 1, (winner, queue.learning_count, queue.review_count, queue.new_count, queue.cards)
            queued_card_id = int(queue.cards[0].card.id)
            assert queued_card_id == card_ids[winner_index], (winner, queued_card_id, card_ids[winner_index])
            winners.append(winner)

        return winners
    finally:
        collection.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write-matrix-fixture", action="store_true", help="refresh the checked-in normalized matrix used by client parity tests")
    args = parser.parse_args()
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
            review_limit_sharing = verify_review_limit_shares_capacity_with_new(Path(directory) / "limit-sharing-oracle.anki2")
            selected_parent_review_limit = verify_selected_parent_review_limit(Path(directory) / "parent-review-limit-oracle.anki2")
            sibling_bury_categories = verify_sibling_bury_categories(Path(directory) / "sibling-bury-oracle.anki2")
            mixed_sibling_bury_precedence = verify_mixed_sibling_bury_precedence(Path(directory) / "mixed-sibling-bury-oracle.anki2")
            persisted_state_grade_matrix = verify_persisted_state_grade_matrix(collection)
            if args.write_matrix_fixture:
                write_persisted_matrix_fixture(persisted_state_grade_matrix)
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
                "nativeEasyIntervalsForFirst64CardIds": [easy_days_by_id[CARD_ID + offset] for offset in range(64)],
                "nativeEasyIntervalRangeFor64CardIds": easy_range,
                "firstGraduatedCardReviewChoices": first_review_labels,
                "firstGraduatedCardReviewScheduledDays": first_review_days,
                "nativeReviewIntervalRangesFor512CardIds": review_ranges,
                "nativeSelectedDeckLimits": selected_deck_limits,
                "nativeDefaultQueueMixing": default_queue_mixing,
                "nativeReviewLimitSharing": review_limit_sharing,
                "nativeSelectedParentReviewLimit": selected_parent_review_limit,
                "nativeSiblingBuryCategories": sibling_bury_categories,
                "nativeMixedSiblingBuryPrecedence": mixed_sibling_bury_precedence,
                "nativePersistedStateGradeMatrix": persisted_state_grade_matrix,
            }, indent=2))
        finally:
            collection.close()


if __name__ == "__main__":
    main()
