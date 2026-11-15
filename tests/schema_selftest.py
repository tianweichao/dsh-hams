#!/usr/bin/env python3
"""HAMS 表结构自测：把 docs/schema-2026-11-14.sql 建在内存库里，逐条验证库级不变量。

只使用 Python 标准库与内存 SQLite，不启动 DSH、不读写 $DSH_HOME、不产生任何文件。
用法：python3 tests/schema_selftest.py        （全部通过退出码 0）

每个「应被拒绝」的写入如标了 guard，会再做一次反向验证：临时拿掉该触发器或索引后，
同一条写入必须成功。这样可以确认拦住它的确实是这条规则，而不是别的巧合。
"""
import pathlib
import sqlite3
import sys

SCHEMA = pathlib.Path(__file__).resolve().parent.parent / "docs" / "schema-2026-11-14.sql"
T0 = 1_800_000_000_000
HOUR = 3_600_000


def fresh():
    db = sqlite3.connect(":memory:", isolation_level=None)
    db.execute("PRAGMA foreign_keys = ON")
    db.executescript(SCHEMA.read_text(encoding="utf-8"))
    m = "INSERT INTO member (id, kind, name, role, owner_human_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
    db.execute(m, ("h_wang", "human", "王", "observer", None, T0, T0))
    db.execute(m, ("h_li", "human", "李", "observer", None, T0, T0))
    db.execute(m, ("b_check", "bot", "复查助手", "executor", "h_wang", T0, T0))
    db.execute(m, ("b_ledger", "bot", "台账助手", "executor", "h_wang", T0, T0))
    db.execute(m, ("b_coord", "bot", "运营协调", "coordinator", "h_wang", T0, T0))
    db.execute("INSERT INTO asset (id, external_system, external_id, display_name) VALUES ('a1','bms','BT-20871','电池 BT-20871')")
    db.execute("INSERT INTO work_template (id, key, name, domain, category) VALUES ('tpl','battery_alert_tracking','电池告警追踪','安全','安全响应')")
    db.execute("INSERT INTO work_template_version (id, template_id, version, status) VALUES ('tv1','tpl',1,'published')")
    db.execute("INSERT INTO project (id, name, type, status, owner_human_id, goal_text, created_at, updated_at) "
               "VALUES ('p1','电池资产持续运营','continuous','active','h_wang','g',?,?)", (T0, T0))
    return db


def mk_wi(db, wid, status="ready", **kw):
    cols = dict(id=wid, project_id="p1", template_version_id="tv1", asset_id="a1", domain="安全",
                category="安全响应", title="BT-20871 过放告警", status=status, owner_human_id="h_wang",
                created_by="system", created_at=T0, updated_at=T0)
    cols.update(kw)
    names = ", ".join(cols)
    db.execute(f"INSERT INTO work_item ({names}) VALUES ({', '.join('?' * len(cols))})", tuple(cols.values()))


def mk_thread(db, tid, wid, gen, session, member="b_check", status="active"):
    db.execute("INSERT INTO work_item_thread (id, work_item_id, generation, session_id, member_id, member_version, status, opened_at) "
               "VALUES (?,?,?,?,?,3,?,?)", (tid, wid, gen, session, member, status, T0))


def mk_run(db, rid, wid, tid, fence, epoch=1, status="queued", member="b_check", runtime_epoch=1):
    db.execute("INSERT INTO task_run (id, work_item_id, thread_id, member_id, member_version, execution_epoch, runtime_epoch, "
               "fence, trigger, status, created_at) VALUES (?,?,?,?,3,?,?,?,'check',?,?)",
               (rid, wid, tid, member, epoch, runtime_epoch, fence, status, T0))


def mk_evidence(db, eid, wid, kind="reading", by="b_check"):
    db.execute("INSERT INTO evidence (id, work_item_id, kind, ref, content_hash, observed_at, captured_at, captured_by) "
               "VALUES (?,?,?,?,?,?,?,?)", (eid, wid, kind, f"evidence/{eid}", f"hash-{eid}", T0, T0 + 1, by))


def mk_approval(db, aid, wid, revision, epoch=1, ehash="H1", approver="h_wang", requested_by="b_check"):
    db.execute("INSERT INTO approval (id, subject_kind, subject_id, subject_revision, execution_epoch, evidence_set_hash, "
               "criteria_ref, reason_text, requested_by, requested_channel, approver_id, expires_at, created_at) "
               "VALUES (?,'work_item_close',?,?,?,?,'tv1','复查通过',?,'tool',?,?,?)",
               (aid, wid, revision, epoch, ehash, requested_by, approver, T0 + 4 * HOUR, T0))


APPROVE = ("UPDATE approval SET status='approved', decided_by=?, decided_channel='ui', decided_at=? WHERE id=?")
CLOSE = "UPDATE work_item SET status='completed', revision=revision+1, completed_at=? WHERE id=?"


def one(db, sql, params=()):
    return db.execute(sql, params).fetchone()[0]


def denied(db, sql, params=(), guard=None, guard_kind="TRIGGER"):
    """断言写入被库拒绝；给了 guard 时，再断言拿掉 guard 后同一写入会成功。"""
    try:
        db.execute(sql, params)
    except sqlite3.IntegrityError as e:
        msg = str(e)
    else:
        raise AssertionError(f"应被拒绝但成功了：{sql}")
    if guard:
        db.execute("SAVEPOINT mutation")
        try:
            db.execute(f"DROP {guard_kind} {guard}")
            try:
                db.execute(sql, params)
            except sqlite3.IntegrityError as e:
                raise AssertionError(f"拿掉 {guard} 后仍被拒绝（{e}），该用例没有单独验证到这条规则：{sql}")
        finally:
            db.execute("ROLLBACK TO mutation")
            db.execute("RELEASE mutation")
    return msg


# ───────────────────────── 用例 ─────────────────────────

def t01_schema_builds_clean(db):
    assert db.execute("PRAGMA foreign_key_check").fetchall() == []
    assert one(db, "PRAGMA integrity_check") == "ok"
    tables = one(db, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    triggers = one(db, "SELECT count(*) FROM sqlite_master WHERE type='trigger'")
    assert tables == 57 and triggers == 32, (tables, triggers)


def t02_dedupe_blocks_open_duplicate_only(db):
    key = "alert:BT-20871:overdischarge"
    mk_wi(db, "w1", dedupe_key=key)
    denied(db, "INSERT INTO work_item (id, domain, category, title, owner_human_id, created_by, created_at, updated_at, dedupe_key) "
               "VALUES ('w2','安全','安全响应','重复','h_wang','system',0,0,?)", (key,), guard="uq_wi_dedupe", guard_kind="INDEX")
    # 第一单结束后，同一电池再次过放必须能新建（30 天内第二次过放）
    db.execute("UPDATE work_item SET status='cancelled', execution_epoch=execution_epoch+1, revision=revision+1 WHERE id='w1'")
    mk_wi(db, "w3", dedupe_key=key)
    assert one(db, "SELECT count(*) FROM work_item WHERE dedupe_key=?", (key,)) == 2


def t03_inbox_same_external_event_once(db):
    ins = ("INSERT INTO event_inbox (id, connector, external_event_id, asset_id, event_type, payload_ref, payload_hash, occurred_at, received_at) "
           "VALUES (?,'bms','evt-8871','a1','overdischarge','p','h',0,0)")
    db.execute(ins, ("e1",))
    for i in range(9):
        denied(db, ins, (f"e{i + 2}",))
    assert one(db, "SELECT count(*) FROM event_inbox") == 1


def t04_proposal_dedupe_without_work_item(db):
    ins = ("INSERT INTO proposal (id, subject_key, project_id, kind, dedupe_key, proposed_by, decider_id, title, body, rationale_json, created_at) "
           "VALUES (?,'project:p1','p1','create_task','recount:offline-12','b_coord','h_wang','补盘 12 台','b','{}',0)")
    db.execute(ins, ("pr1",))
    denied(db, ins, ("pr2",), guard="uq_proposal_open", guard_kind="INDEX")
    db.execute("INSERT INTO decision (id, proposal_id, decided_by, decision, channel, note, created_at) VALUES ('d1','pr1','h_wang','reject','ui','成本太高',1)")
    db.execute("UPDATE proposal SET status='rejected', revision=revision+1 WHERE id='pr1'")
    db.execute(ins, ("pr3",))  # 旧提议已结束，同一意图可以再提


def t05_private_memory_unique(db):
    ins = ("INSERT INTO member_memory (id, member_id, scope, key, value, source_kind, created_at) VALUES (?,'b_check','private','k','v','run',0)")
    db.execute(ins, ("m1",))
    denied(db, ins, ("m2",))
    denied(db, "INSERT INTO member_memory (id, member_id, scope, scope_ref, key, value, source_kind, created_at) "
               "VALUES ('m3','b_check','project','p1','k','v','run',0)")  # 项目层写入必须带来源


def t06_authority_only_for_humans(db):
    grant = "INSERT INTO member_permission (member_id, capability, scope, granted_by, granted_at) VALUES (?,?,?,'h_wang',0)"
    db.execute(grant, ("b_check", "evidence.write", "domain:安全"))
    denied(db, grant, ("b_check", "approval.decide", "global"), guard="trg_bot_no_human_capability")
    denied(db, grant, ("h_li", "evidence.write", "domain:安全"), guard="trg_member_permission_bot_only")
    db.execute("INSERT INTO position (id, name) VALUES ('pos_ops','资产运营岗')")
    db.execute("INSERT INTO member_position (member_id, position_id, starts_at, assigned_by) VALUES ('h_wang','pos_ops',0,'h_wang')")
    denied(db, "INSERT INTO member_position (member_id, position_id, starts_at, assigned_by) VALUES ('b_check','pos_ops',0,'h_wang')",
           guard="trg_member_position_human_only")
    denied(db, "INSERT INTO hams_user (id, member_id, login, display_name, auth_source, external_id) VALUES ('u1','b_check','x','x','sso','x')",
           guard="trg_hams_user_human_only")
    denied(db, "INSERT INTO member (id, kind, name, created_at, updated_at) VALUES ('b_x','bot','无主 bot',0,0)")  # bot 必须有责任人


def t07_system_actor_can_write_timeline(db):
    mk_wi(db, "w1")
    db.execute("INSERT INTO work_item_event (id, work_item_id, kind, actor_id, actor_kind, revision, execution_epoch, created_at) "
               "VALUES ('ev1','w1','work.created','system','system',1,1,0)")
    db.execute("INSERT INTO audit_log (id, actor_id, actor_kind, channel, action, subject_kind, subject_id, correlation_id, created_at) "
               "VALUES ('au1','system','system','system','recover','task_run','r1','c1',0)")
    denied(db, "INSERT INTO member (id, kind, name, created_at, updated_at) VALUES ('system2','system','第二个系统',0,0)")
    denied(db, "UPDATE audit_log SET action='x' WHERE id='au1'", guard="trg_audit_no_update")
    denied(db, "DELETE FROM audit_log WHERE id='au1'", guard="trg_audit_no_delete")
    denied(db, "UPDATE work_item_event SET kind='x' WHERE id='ev1'", guard="trg_event_no_update")


def t08_transition_whitelist(db):
    mk_wi(db, "w1", status="ready", close_requires_approval=0)
    denied(db, "UPDATE work_item SET status='waiting_review', revision=revision+1 WHERE id='w1'", guard="trg_wi_transition_whitelist")
    denied(db, "UPDATE work_item SET status='active' WHERE id='w1'", guard="trg_wi_counters_monotonic")  # 没递增修订号
    db.execute("UPDATE work_item SET status='active', assignee_id='b_check', revision=revision+1 WHERE id='w1'")


def t09_pause_and_resume(db):
    mk_wi(db, "w1", status="waiting_check")
    denied(db, "UPDATE work_item SET status='paused', execution_epoch=execution_epoch+1, revision=revision+1 WHERE id='w1'")  # 没记暂停前状态
    denied(db, "UPDATE work_item SET status='paused', resume_state='waiting_check', revision=revision+1 WHERE id='w1'",
           guard="trg_wi_epoch_on_pause")
    db.execute("UPDATE work_item SET status='paused', resume_state='waiting_check', execution_epoch=execution_epoch+1, revision=revision+1 WHERE id='w1'")
    denied(db, "UPDATE work_item SET status='active', resume_state=NULL, execution_epoch=execution_epoch+1, revision=revision+1 WHERE id='w1'",
           guard="trg_wi_resume_target")
    db.execute("UPDATE work_item SET status='waiting_check', resume_state=NULL, execution_epoch=execution_epoch+1, revision=revision+1 WHERE id='w1'")
    assert db.execute("SELECT status, execution_epoch FROM work_item WHERE id='w1'").fetchone() == ("waiting_check", 3)


def t10_reassign_bumps_epoch(db):
    mk_wi(db, "w1", status="active", assignee_id="b_check")
    denied(db, "UPDATE work_item SET assignee_id='b_ledger', revision=revision+1 WHERE id='w1'", guard="trg_wi_epoch_on_reassign")
    db.execute("UPDATE work_item SET assignee_id='b_ledger', execution_epoch=execution_epoch+1, revision=revision+1 WHERE id='w1'")
    denied(db, "UPDATE work_item SET owner_human_id='b_check', revision=revision+1 WHERE id='w1'", guard="trg_wi_owner_human_upd")


def t11_close_needs_valid_approval(db):
    mk_wi(db, "w1", status="waiting_review", evidence_set_hash="H1", revision=7)
    denied(db, CLOSE, (T0 + HOUR, "w1"), guard="trg_wi_complete_guard")  # 没有审批
    mk_approval(db, "ap1", "w1", revision=7)
    denied(db, CLOSE, (T0 + HOUR, "w1"))  # 审批还在待决
    db.execute(APPROVE, ("h_wang", T0 + HOUR, "ap1"))
    db.execute(CLOSE, (T0 + HOUR, "w1"))
    assert one(db, "SELECT status FROM work_item WHERE id='w1'") == "completed"


def t12_evidence_change_after_approval_blocks_close(db):
    """审批通过后、关单前换了材料：旧批准不能再用来关单。"""
    mk_wi(db, "w1", status="waiting_review", evidence_set_hash="H1", revision=7)
    mk_approval(db, "ap1", "w1", revision=7)
    db.execute(APPROVE, ("h_wang", T0 + HOUR, "ap1"))
    mk_evidence(db, "e_new", "w1")  # 新证据 → 修订号 +1
    assert one(db, "SELECT revision FROM work_item WHERE id='w1'") == 8
    denied(db, CLOSE, (T0 + HOUR, "w1"), guard="trg_wi_complete_guard")


def t13_evidence_change_invalidates_pending_approval(db):
    mk_wi(db, "w1", status="waiting_review", evidence_set_hash="H1", revision=7)
    mk_approval(db, "ap1", "w1", revision=7)
    mk_evidence(db, "e_new", "w1")
    assert db.execute("SELECT status, invalidated_reason FROM approval WHERE id='ap1'").fetchone() == ("invalidated", "subject_changed")
    denied(db, APPROVE, ("h_wang", T0 + HOUR, "ap1"), guard="trg_approval_terminal")
    mk_approval(db, "ap2", "w1", revision=8, ehash="H2")  # 按新材料重新申请


def t14_only_designated_human_decides_via_ui_before_expiry(db):
    mk_wi(db, "w1", status="waiting_review", evidence_set_hash="H1", revision=7)
    mk_approval(db, "ap1", "w1", revision=7)
    denied(db, APPROVE, ("b_check", T0 + HOUR, "ap1"), guard="trg_approval_decision_guard")   # bot
    denied(db, APPROVE, ("h_li", T0 + HOUR, "ap1"), guard="trg_approval_decision_guard")      # 不是指定审批人
    denied(db, APPROVE, ("h_wang", T0 + 5 * HOUR, "ap1"), guard="trg_approval_decision_guard")  # 已过期
    denied(db, "UPDATE approval SET status='approved', decided_by='h_wang', decided_channel='tool', decided_at=? WHERE id='ap1'", (T0 + HOUR,))
    denied(db, "UPDATE approval SET status='returned', decided_by='h_wang', decided_channel='ui', decided_at=? WHERE id='ap1'", (T0 + HOUR,))  # 退回必须写原因
    db.execute("UPDATE approval SET status='expired' WHERE id='ap1'")  # 到期只失效
    denied(db, APPROVE, ("h_wang", T0 + HOUR, "ap1"), guard="trg_approval_terminal")
    denied(db, "INSERT INTO approval (id, subject_kind, subject_id, subject_revision, reason_text, requested_by, requested_channel, approver_id, expires_at, created_at) "
               "VALUES ('ap3','work_item_close','w1',7,'r','b_check','tool','b_ledger',1,0)", guard="trg_approval_approver_human_ins")


def t15_one_pending_approval_per_subject(db):
    mk_wi(db, "w1", status="waiting_review", revision=7)
    mk_approval(db, "ap1", "w1", revision=7)
    denied(db, "INSERT INTO approval (id, subject_kind, subject_id, subject_revision, reason_text, requested_by, requested_channel, approver_id, expires_at, created_at) "
               "VALUES ('ap2','work_item_close','w1',7,'r','b_check','tool','h_wang',1,0)", guard="uq_approval_pending", guard_kind="INDEX")


def t16_auto_close_needs_passed_check_on_same_evidence(db):
    mk_wi(db, "w1", status="waiting_review", close_requires_approval=0, evidence_set_hash="H1")
    denied(db, CLOSE, (T0, "w1"), guard="trg_wi_complete_guard")
    db.execute("INSERT INTO work_item_check (id, work_item_id, generation, execution_epoch, planned_due_at, status, evidence_set_hash, created_at) "
               "VALUES ('c1','w1',1,1,0,'passed','H0',0)")
    denied(db, CLOSE, (T0, "w1"))  # 复查通过时的证据集已不是现在这一版
    db.execute("UPDATE work_item_check SET evidence_set_hash='H1' WHERE id='c1'")
    db.execute(CLOSE, (T0, "w1"))


def t17_thread_generations_keep_history(db):
    mk_wi(db, "w1", status="active", assignee_id="b_check")
    mk_thread(db, "t1", "w1", 1, "sess-1")
    mk_run(db, "r1", "w1", "t1", fence=1, status="succeeded")
    denied(db, "INSERT INTO work_item_thread (id, work_item_id, generation, session_id, member_id, member_version, opened_at) "
               "VALUES ('t2','w1',2,'sess-2','b_check',4,0)", guard="uq_thread_current", guard_kind="INDEX")  # 同时只能有一条在用
    db.execute("UPDATE work_item_thread SET status='rotated', closed_at=1 WHERE id='t1'")
    mk_thread(db, "t2", "w1", 2, "sess-2")
    mk_run(db, "r2", "w1", "t2", fence=2, status="succeeded")
    denied(db, "INSERT INTO task_run (id, work_item_id, thread_id, member_id, member_version, execution_epoch, runtime_epoch, fence, trigger, created_at) "
               "VALUES ('r3','w1','t1','b_check',3,1,1,3,'check',0)", guard="trg_run_binds_current_thread")  # 旧代次不再接新运行
    # 历史运行仍指向它发生时的会话
    assert db.execute("SELECT t.session_id FROM task_run r JOIN work_item_thread t ON t.id = r.thread_id WHERE r.id='r1'").fetchone() == ("sess-1",)
    mk_wi(db, "w2")
    denied(db, "INSERT INTO work_item_thread (id, work_item_id, generation, session_id, member_id, member_version, opened_at) "
               "VALUES ('t9','w2',1,'sess-1','b_check',3,0)")  # 会话不得跨工作项复用


def t18_single_active_run_and_stale_epoch(db):
    mk_wi(db, "w1", status="active", assignee_id="b_check")
    mk_thread(db, "t1", "w1", 1, "sess-1")
    mk_run(db, "r1", "w1", "t1", fence=1, status="queued")
    denied(db, "INSERT INTO task_run (id, work_item_id, thread_id, member_id, member_version, execution_epoch, runtime_epoch, fence, trigger, created_at) "
               "VALUES ('r2','w1','t1','b_check',3,1,1,2,'check',0)", guard="uq_wi_active_run", guard_kind="INDEX")
    # 启动恢复：旧宿主代次里没开始的排队运行取消后重排，已开始的标孤儿交人处理；槽位随之释放
    db.execute("UPDATE task_run SET status='cancelled', error_kind='host_restart' WHERE runtime_epoch < 2 AND status='queued'")
    db.execute("UPDATE task_run SET status='orphaned' WHERE runtime_epoch < 2 AND status='running'")
    assert one(db, "SELECT count(*) FROM task_run WHERE status IN ('queued','running')") == 0
    mk_run(db, "r2", "w1", "t1", fence=2, runtime_epoch=2)
    db.execute("UPDATE task_run SET status='cancelled' WHERE id='r2'")
    denied(db, "INSERT INTO task_run (id, work_item_id, thread_id, member_id, member_version, execution_epoch, runtime_epoch, fence, trigger, created_at) "
               "VALUES ('r3','w1','t1','b_check',3,0,2,3,'check',0)", guard="trg_run_epoch_current")  # 携带旧执行代次
    denied(db, "INSERT INTO lease (work_item_id, holder_member_id, run_id, fence, runtime_epoch, lease_until, renewed_at) "
               "VALUES ('w1','h_li','r2',2,2,1,0)", guard="trg_lease_bot_only")


def t19_schedule_first_fire_and_double_trigger(db):
    db.execute("INSERT INTO schedule (id, owner_human_id, kind, spec, timezone, next_fire_at, created_at) "
               "VALUES ('s1','h_wang','cron','0 9 * * *','Asia/Shanghai',?,0)", (T0,))
    occ = "INSERT INTO schedule_occurrence (schedule_id, planned_at, fired_at) VALUES ('s1',?,?)"
    db.execute(occ, (T0, T0 + 5))            # 首次触发能落库（不依赖与 NULL 比较）
    denied(db, occ, (T0, T0 + 6))            # 宿主闹钟与 tick 同时命中，只算一次
    db.execute(occ, (T0 + 24 * HOUR, T0 + 30 * HOUR))  # 补跑：计划时间与实际时间分开记


def t20_decision_rules(db):
    db.execute("INSERT INTO proposal (id, subject_key, project_id, kind, dedupe_key, proposed_by, decider_id, title, body, rationale_json, created_at) "
               "VALUES ('pr1','project:p1','p1','create_task','k','b_coord','h_wang','t','b','{}',0)")
    db.execute("UPDATE proposal SET snoozed_until=?, revision=revision+1 WHERE id='pr1'", (T0 + HOUR,))  # 稍后再说：不产生决定
    dec = "INSERT INTO decision (id, proposal_id, decided_by, decision, channel, note, created_at) VALUES (?,?,?,?,?,?,1)"
    denied(db, dec, ("d0", "pr1", "h_wang", "reject", "ui", ""))                     # 驳回必须写原因
    denied(db, dec, ("d0", "pr1", "b_check", "accept", "ui", ""), guard="trg_decision_by_human")
    denied(db, dec, ("d0", "pr1", "h_wang", "accept", "tool", ""))                   # 只能走界面
    db.execute(dec, ("d1", "pr1", "h_wang", "accept", "ui", ""))
    denied(db, dec, ("d2", "pr1", "h_wang", "reject", "ui", "反悔"))                 # 一条提议只有一个终态决定
    denied(db, "INSERT INTO proposal (id, subject_key, kind, dedupe_key, proposed_by, decider_id, title, body, rationale_json, created_at) "
               "VALUES ('pr9','global','create_task','k2','h_li','h_wang','t','b','{}',0)", guard="trg_proposal_by_bot")


def t21_metric_without_source_is_unknown(db):
    db.execute("INSERT INTO project_target_version (id, project_id, version, goal_text, published_by, published_at) VALUES ('pv1','p1',1,'g','h_wang',0)")
    db.execute("INSERT INTO project_metric (id, project_id, version_id, name, direction, window_kind) VALUES ('mx','p1','pv1','维修 ROI','higher','month')")
    db.execute("INSERT INTO project_review (id, project_id, kind, period_start, period_end, target_version_id) VALUES ('rv1','p1','monthly',0,1,'pv1')")
    ins = "INSERT INTO project_review_metric (review_id, metric_id, actual_value, verdict) VALUES ('rv1','mx',?,?)"
    denied(db, ins, (0.0, "missed"), guard="trg_review_metric_unknown")   # 缺口径不许写 0
    denied(db, ins, (None, "met"))                                        # 缺数不许判达标
    db.execute(ins, (None, "unknown"))
    denied(db, "UPDATE project_target_version SET goal_text='x' WHERE id='pv1'", guard="trg_target_version_immutable")
    denied(db, "UPDATE project_review SET status='confirmed' WHERE id='rv1'")  # 确认必须有确认人


def t22_budget_day_and_week_are_separate(db):
    ins = "INSERT INTO project_budget (project_id, period_kind, period_start, metric, used, limit_value) VALUES ('p1',?,?,?,?,?)"
    db.execute(ins, ("day", "2026-11-14", "new_tasks", 9, 20))
    db.execute(ins, ("week", "2026-11-09", "proposals", 7, 25))
    db.execute(ins, ("day", "2026-11-15", "new_tasks", 0, 20))
    assert one(db, "SELECT used FROM project_budget WHERE period_kind='week' AND metric='proposals'") == 7  # 周额度不随日清零


def t23_evidence_is_append_only(db):
    mk_wi(db, "w1")
    mk_evidence(db, "e1", "w1", by="h_wang")
    denied(db, "UPDATE evidence SET content_hash='x' WHERE id='e1'", guard="trg_evidence_immutable")
    denied(db, "DELETE FROM evidence WHERE id='e1'", guard="trg_evidence_no_delete")
    db.execute("UPDATE evidence SET purged_at=1 WHERE id='e1'")          # 保留期满：只置标记，行与哈希保留
    db.execute("INSERT INTO member_version (id, member_id, version, prompt_digest, published_by, published_at) VALUES ('mv3','b_check',3,'d','h_wang',0)")
    denied(db, "UPDATE member_version SET model='x' WHERE id='mv3'", guard="trg_member_version_immutable")


def t24_outbox_and_receipt(db):
    ins = ("INSERT INTO outbox (id, action, payload_json, idempotency_key, requested_by, available_at, created_at) VALUES (?,'lark.notify','{}','k1','b_check',0,0)")
    db.execute(ins, ("o1",))
    denied(db, ins, ("o2",))
    for st in ("sending", "unknown", "confirmed"):
        db.execute("UPDATE outbox SET status=? WHERE id='o1'", (st,))
    rc = "INSERT INTO command_receipt (scope_key, command_id, principal_id, action, payload_hash, receipt_json, created_at) VALUES ('sk1',?,'h_wang','approval/decide','ph','{}',0)"
    db.execute(rc, ("c1",))
    denied(db, rc, ("c2",))


def main():
    cases = [(n, f) for n, f in sorted(globals().items()) if n.startswith("t") and n[1:3].isdigit() and callable(f)]
    failed = 0
    for name, fn in cases:
        try:
            fn(fresh())
            print(f"PASS  {name}")
        except Exception as e:  # noqa: BLE001 - 自测脚本需要汇总所有失败
            failed += 1
            print(f"FAIL  {name}: {type(e).__name__}: {e}")
    print(f"\n{len(cases) - failed}/{len(cases)} 通过 · SQLite {sqlite3.sqlite_version}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
