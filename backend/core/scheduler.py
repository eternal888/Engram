from apscheduler.schedulers.background import BackgroundScheduler
from backend.core.promotion import promote_memories, decay_confidence, prune_stale
from backend.agents.curator_agent import run_curator
from backend.agents.consolidation_agent import run_consolidation

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


def run_consolidation_job():
    print("\n⏰ [Scheduled] Running consolidation...")
    try:
        run_consolidation(user_id="default")
    except Exception as e:
        print(f"❌ Consolidation job error: {e}")


def start_scheduler():
    scheduler.add_job(run_promotion_job, 'interval', hours=1, id='promotion')
    scheduler.add_job(run_decay_job, 'interval', hours=6, id='decay')
    scheduler.add_job(run_pruning_job, 'interval', hours=12, id='pruning')
    scheduler.add_job(run_curator_job, 'interval', hours=24, id='curator')
    scheduler.add_job(run_consolidation_job, 'interval', hours=24, id='consolidation')

    scheduler.start()
    print("✅ Scheduler started — promotion (1h), decay (6h), pruning (12h), curator (24h), consolidation (24h)")


def stop_scheduler():
    scheduler.shutdown()