from apscheduler.schedulers.background import BackgroundScheduler
from backend.core.promotion import promote_memories, decay_confidence, prune_stale
from backend.agents.curator_agent import run_curator

scheduler = BackgroundScheduler()


def run_promotion_job():
    print("\n⏰ [Scheduled] Running promotion engine...")
    try:
        promote_memories(user_id="default")
    except Exception as e:
        print(f"❌ Promotion job error: {e}")


def run_decay_job():
    print("\n⏰ [Scheduled] Running decay engine...")
    try:
        decay_confidence(user_id="default")
    except Exception as e:
        print(f"❌ Decay job error: {e}")


def run_pruning_job():
    print("\n⏰ [Scheduled] Running pruning engine...")
    try:
        prune_stale(user_id="default")
    except Exception as e:
        print(f"❌ Pruning job error: {e}")


def run_curator_job():
    print("\n⏰ [Scheduled] Running curator...")
    try:
        run_curator(user_id="default")
    except Exception as e:
        print(f"❌ Curator job error: {e}")


def start_scheduler():
    # Promotion every 1 hour
    scheduler.add_job(run_promotion_job, 'interval', hours=1, id='promotion')

    # Decay every 6 hours
    scheduler.add_job(run_decay_job, 'interval', hours=6, id='decay')

    # Pruning every 12 hours
    scheduler.add_job(run_pruning_job, 'interval', hours=12, id='pruning')

    # Curator daily
    scheduler.add_job(run_curator_job, 'interval', hours=24, id='curator')

    scheduler.start()
    print("✅ Scheduler started — promotion (1h), decay (6h), pruning (12h), curator (24h)")


def stop_scheduler():
    scheduler.shutdown()