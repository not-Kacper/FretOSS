import datetime
from fsrs import Scheduler, Card, Rating

s = Scheduler()
c = Card()

print("Initial Card state:", c.__dict__)
now = datetime.datetime.now(datetime.timezone.utc)
good_card, review_log = s.review_card(c, Rating.Good, review_datetime=now)
print("After Good state:", good_card.__dict__)
print("Review log:", review_log.to_dict())

# Test dictionary conversion
import dataclasses
if dataclasses.is_dataclass(good_card):
    print("Dataclass asdict:", dataclasses.asdict(good_card))
else:
    print("Has to_dict?", hasattr(good_card, "to_dict"))
