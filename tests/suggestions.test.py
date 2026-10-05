"""改写提议后端回归测试（FastAPI TestClient + 独立临时数据库）。

覆盖：
- 提交（POST /api/suggestions）：仅演出中（含暂停）的待发提示可提交；
  保存编号与原文快照、建议内容；不改提示、不改版本号；无需控制凭据；
  空内容 400、提示不存在 404、开场前 / 已完成 / 已发出目标 / 版本过期 409；
- 接受（POST /api/suggestions/{id}/accept）：受控制席保护；目标仍待发且
  内容等于原文快照才生效；"写入建议 + 标记已接受 + 版本 +1"同事务；
  接受当前提示重开核验轮次并重计自动计时，接受其他提示不重置；其他提示
  编辑 / 暂停 / 队首不变的重排不使提议失效；直接改写目标、目标已发出
  （手工 / 自动）、撤回、版本过期、提议已处理均 409 且提议与数据不变；
- 拒绝（POST /api/suggestions/{id}/reject）：仅标记已拒绝、不改版本；
  版本过期 / 已处理 409；受控制席保护；
- 交错：接受与确认 / 编辑同版本竞争最多一个成功；接受不覆盖已变内容；
  自动发出在接受前先到期时接受返回 409，提议保持待审；
- 持久化：刷新、重启保留；归档 / 重置 / 手工录入 / 以档案开新场清空，
  档案不含提议。

运行：python3 tests/suggestions.test.py
"""
import os
import sys
import tempfile

_tmp = tempfile.mkdtemp(prefix="cue-suggestion-test-")
os.environ["DB_PATH"] = os.path.join(_tmp, "cues.db")
os.environ["AUTO_WORKER"] = "0"  # 自动发出改为测试中手动驱动 auto_tick
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from fastapi.testclient import TestClient  # noqa: E402

import app.main as main  # noqa: E402

failures = 0


def check(cond, msg):
    global failures
    if cond:
        print("  ✓ " + msg)
    else:
        failures += 1
        print("  ✗ " + msg)


CUES3 = [
    {"number": "A1", "content": "灯光渐亮"},
    {"number": "A2", "content": "音乐起"},
    {"number": "A3", "content": "幕落"},
]


def setup_show(c, cues=None):
    r = c.post("/api/setup", json={"cues": cues or CUES3})
    assert r.status_code == 200, r.text
    return r.json()


def confirm(c, v):
    r = c.post("/api/confirm", json={"version": v})
    assert r.status_code == 200, r.text
    return r.json()


def suggest(c, v, cue_id, content):
    return c.post(
        "/api/suggestions",
        json={"version": v, "cue_id": cue_id, "content": content},
    )


def accept(c, v, sid, token=None):
    headers = {"X-Control-Token": token} if token else {}
    return c.post(
        f"/api/suggestions/{sid}/accept", json={"version": v}, headers=headers
    )


def reject(c, v, sid, token=None):
    headers = {"X-Control-Token": token} if token else {}
    return c.post(
        f"/api/suggestions/{sid}/reject", json={"version": v}, headers=headers
    )


def pending_by_id(state, cue_id):
    return next(p for p in state["pending"] if p["id"] == cue_id)


def test_submit_basic():
    with TestClient(main.app) as c:
        print("S1 提交：保存原文快照、不改提示与版本；暂停时可提交")
        s = setup_show(c)
        v = s["version"]
        id1, id2, _ = [p["id"] for p in s["pending"]]

        r = suggest(c, v, id2, "  音乐提前两小节起  ")
        check(r.status_code == 200, "对非当前待发提示提交成功")
        data = r.json()
        check(data["version"] == v, "提交不推进版本号")
        check(len(data["suggestions"]) == 1, "状态中返回提议列表")
        sug = data["suggestions"][0]
        check(sug["status"] == "pending" and sug["cue_id"] == id2, "新提议为待审核")
        check(sug["cue_number"] == "A2", "保存提交时编号快照")
        check(sug["original"] == "音乐起", "保存原文快照")
        check(sug["proposed"] == "音乐提前两小节起", "建议内容去除首尾空白后保存")
        check(pending_by_id(data, id2)["content"] == "音乐起", "提示内容未被修改")
        check(sug["base_version"] == v, "记录页面所见版本")

        # 暂停时仍可提交（暂停只禁止发出）
        r = c.post("/api/pause", json={"version": v, "paused": True})
        check(r.status_code == 200, "暂停")
        v = r.json()["version"]
        r = suggest(c, v, id1, "灯光慢亮")
        check(r.status_code == 200, "暂停期间可提交提议")
        check(r.json()["version"] == v, "暂停期间提交仍不改版本")


def test_submit_failures():
    main.DB_PATH = os.path.join(_tmp, "submit-fail.db")
    with TestClient(main.app) as c:
        print("S2 提交失败：空内容 400；开场前 / 已完成 / 目标已发 / 不存在 / 版本过期 409/404")
        s = c.get("/api/state").json()
        # 开场前
        r = suggest(c, s["version"], 1, "x")
        check(r.status_code == 409, "开场前提议返回 409")
        check(r.json()["state"]["version"] == s["version"], "409 附最新状态")

        s = setup_show(c)
        v = s["version"]
        id1 = s["pending"][0]["id"]

        r = suggest(c, v, id1, "   ")
        check(r.status_code == 400, "空白建议内容返回 400")
        check(c.get("/api/state").json()["version"] == v, "400 不改版本")

        r = suggest(c, v + 1, id1, "改")
        check(r.status_code == 409, "版本过期返回 409")
        check(r.json()["state"]["version"] == v, "409 附最新版本")

        r = suggest(c, v, 999999, "改")
        check(r.status_code == 404, "提示不存在返回 404")

        # 已发出目标
        s = confirm(c, v)
        v = s["version"]
        r = suggest(c, v, id1, "改")
        check(r.status_code == 409, "对已发提示提议返回 409")
        check(not s or len(c.get("/api/state").json()["suggestions"]) == 0,
              "失败均不写入提议")

        # 已完成（无待发）
        for cue_id in [p["id"] for p in s["pending"]]:
            s = confirm(c, v)
            v = s["version"]
        check(s["status"] == "done", "全部发出进入已完成")
        r = suggest(c, v, id1, "改")
        check(r.status_code == 409, "已完成时提议返回 409")


def test_accept_basic():
    main.DB_PATH = os.path.join(_tmp, "accept.db")
    with TestClient(main.app) as c:
        print("S3 接受：写入建议、标记已接受、版本 +1 一起完成；重复接受 409")
        s = setup_show(c)
        v = s["version"]
        id2 = s["pending"][1]["id"]
        r = suggest(c, v, id2, "音乐提前两小节起")
        sid = r.json()["suggestions"][0]["id"]
        check(r.json()["version"] == v, "提交后版本不变")

        r = accept(c, v, sid)
        check(r.status_code == 200, "接受成功")
        s = r.json()
        check(s["version"] == v + 1, "接受与版本 +1 一起保存")
        check(pending_by_id(s, id2)["content"] == "音乐提前两小节起",
              "建议内容已写入目标提示")
        sug = next(x for x in s["suggestions"] if x["id"] == sid)
        check(sug["status"] == "accepted", "提议标记为已接受")
        check(sug["original"] == "音乐起" and sug["proposed"] == "音乐提前两小节起",
              "接受后原文与建议仍可查看")

        r = accept(c, s["version"], sid)
        check(r.status_code == 409, "已接受的提议不能重复处理")
        r = reject(c, s["version"], sid)
        check(r.status_code == 409, "已接受的提议不能再拒绝")
        check(c.get("/api/state").json()["version"] == v + 1,
              "重复处理不改变版本与内容")


def test_reject_no_version_bump():
    main.DB_PATH = os.path.join(_tmp, "reject.db")
    with TestClient(main.app) as c:
        print("S4 拒绝：仅改为已拒绝，不改提示、不改版本")
        s = setup_show(c)
        v = s["version"]
        id1 = s["pending"][0]["id"]
        r = suggest(c, v, id1, "灯光全亮")
        sid = r.json()["suggestions"][0]["id"]

        r = reject(c, v, sid)
        check(r.status_code == 200, "拒绝成功")
        s = r.json()
        check(s["version"] == v, "拒绝不推进版本号")
        check(s["suggestions"][0]["status"] == "rejected", "提议已拒绝")
        check(pending_by_id(s, id1)["content"] == "灯光渐亮", "提示内容不变")

        r = reject(c, v, sid)
        check(r.status_code == 409, "已拒绝不能再次处理")
        r = accept(c, v, sid)
        check(r.status_code == 409, "已拒绝不能再接受")
        check(c.get("/api/state").json()["version"] == v, "重复处理版本不变")


def test_proposal_survives_other_changes():
    main.DB_PATH = os.path.join(_tmp, "survive.db")
    with TestClient(main.app) as c:
        print("S5 其他提示编辑 / 暂停 / 队首不变重排不使提议失效；重编号后仍可接受")
        s = setup_show(c)
        v = s["version"]
        id1, id2, id3 = [p["id"] for p in s["pending"]]
        r = suggest(c, v, id2, "音乐提前")
        sid = r.json()["suggestions"][0]["id"]

        # 编辑其他提示（A3）：版本推进，但提议仍可接受
        r = c.post("/api/edit", json={"version": v, "cue_id": id3, "content": "幕落（改）"})
        check(r.status_code == 200, "编辑其他提示")
        v = r.json()["version"]

        # 暂停 / 恢复（版本再 +2）
        r = c.post("/api/pause", json={"version": v, "paused": True})
        check(r.status_code == 200, "暂停")
        v = r.json()["version"]
        r = c.post("/api/pause", json={"version": v, "paused": False})
        check(r.status_code == 200, "恢复")
        v = r.json()["version"]

        # 队首不变的重排：交换 A2 与 A3（队首仍是 A1）
        r = c.post("/api/reorder", json={"version": v, "order": [id1, id3, id2]})
        check(r.status_code == 200, "不换队首的重排成功")
        v = r.json()["version"]

        r = accept(c, v, sid)
        check(r.status_code == 200, "交错其他操作后提议仍可接受")
        s = r.json()
        check(pending_by_id(s, id2)["content"] == "音乐提前", "建议写入目标")

        # 重编号后原文内容未变：提议仍按 cue_id 生效（列表显示提交时编号）
        s2 = setup_show(c)
        v2 = s2["version"]
        j2 = s2["pending"][1]["id"]
        r = suggest(c, v2, j2, "新建议")
        sid2 = r.json()["suggestions"][0]["id"]
        r = c.post("/api/edit", json={"version": v2, "cue_id": j2,
                                      "number": "B2", "content": "音乐起"})
        check(r.status_code == 200, "只改编号不改内容")
        v2 = r.json()["version"]
        r = accept(c, v2, sid2)
        check(r.status_code == 200, "编号变但内容仍等于原文快照：可接受")
        s2 = r.json()
        check(pending_by_id(s2, j2)["number"] == "B2", "接受只写内容，不回滚编号")
        check(next(x for x in s2["suggestions"] if x["id"] == sid2)["cue_number"] == "A2",
              "列表保留提交时编号快照")


def test_accept_target_invalidated():
    main.DB_PATH = os.path.join(_tmp, "invalid.db")
    with TestClient(main.app) as c:
        print("S6 接受失效：目标已直接改写 / 已发出（确认、撤回）返回 409 且提议不变")
        s = setup_show(c)
        v = s["version"]
        id1, id2, _ = [p["id"] for p in s["pending"]]

        # 目标内容被直接编辑改写
        r = suggest(c, v, id2, "建议 X")
        sid = r.json()["suggestions"][0]["id"]
        r = c.post("/api/edit", json={"version": v, "cue_id": id2, "content": "手工改写"})
        check(r.status_code == 200, "控制席直接改写目标")
        v2 = r.json()["version"]
        r = accept(c, v2, sid)
        check(r.status_code == 409, "内容不再等于原文快照：接受 409")
        check(pending_by_id(r.json()["state"], id2)["content"] == "手工改写",
              "409 不覆盖已变内容")
        check(r.json()["state"]["version"] == v2, "409 附最新状态")
        check(next(x for x in r.json()["state"]["suggestions"]
                   if x["id"] == sid)["status"] == "pending",
              "失效接受后提议仍为待审（不变）")

        # 目标已被确认发出
        r = suggest(c, v2, id1, "建议当前")
        sid_head = r.json()["suggestions"][-1]["id"]
        s = confirm(c, v2)
        v3 = s["version"]
        r = accept(c, v3, sid_head)
        check(r.status_code == 409, "目标已发出：接受 409")
        check(r.json()["state"]["version"] == v3, "版本与已发记录不变")
        check(next(x for x in r.json()["state"]["suggestions"]
                   if x["id"] == sid_head)["status"] == "pending",
              "目标发出后提议仍待审、不被半次处理")

        # 撤回末条后内容回到发出快照（与原文快照不同，因为原文是发出前内容；
        # 此例中内容相同，撤回后仍待发且内容等于快照，应可接受——验证撤回
        # 不破坏仍满足条件的提议）。用新场构造：提议 id1，确认 id1 后撤回。
        s = setup_show(c)
        v = s["version"]
        h = s["pending"][0]["id"]
        r = suggest(c, v, h, "撤回前建议")
        sid_w = r.json()["suggestions"][0]["id"]
        s = confirm(c, v)
        v = s["version"]
        check(s["status"] == "live", "发出首条后仍在演出中")
        r = accept(c, v, sid_w)
        check(r.status_code == 409, "撤回前（已发出）接受仍 409")
        r = c.post("/api/withdraw", json={"version": v, "cue_id": h})
        check(r.status_code == 200, "撤回末条")
        v = r.json()["version"]
        r = accept(c, v, sid_w)
        check(r.status_code == 200, "撤回后目标重新待发且内容仍等于原文快照：可接受")

        # 版本过期
        vv = c.get("/api/state").json()["version"]
        r = accept(c, vv - 1, 1)
        check(r.status_code == 409, "接受不存在的提议返回 409")
        r = reject(c, vv - 1, 1)
        check(r.status_code == 409, "拒绝不存在的提议返回 409")


def test_accept_verify_round_and_auto_timer():
    main.DB_PATH = os.path.join(_tmp, "verify-auto.db")
    with TestClient(main.app) as c:
        print("S7 接受当前提示：重开核验轮次并重计自动计时；接受其他提示不重置")
        # 核验只能在开场前启用：先重置回设置页，启用后再开场
        s = setup_show(c)
        r = c.post("/api/reset", json={})
        check(r.status_code == 200, "重置回开场前")
        v0 = r.json()["version"]
        r = c.post("/api/verify/enable", json={"version": v0})
        check(r.status_code == 200, "开场前启用核验")
        s = setup_show(c)
        v = s["version"]
        id1, id2, _ = [p["id"] for p in s["pending"]]
        check(s["verify"]["enabled"] and s["verify"]["round"] == 1, "新场第 1 轮核验")

        # 两工种对当前提示报就绪
        for dept in ("lighting", "sound"):
            r = c.post("/api/verify/report", json={
                "department": dept, "cue_id": id1, "round": 1, "ready": True})
            check(r.status_code == 200, f"{dept} 报就绪")
        check(c.get("/api/state").json()["verify"]["all_ready"] is True, "两工种就绪")

        # 对当前提示提交并接受提议：应重开轮次、清空就绪
        r = suggest(c, v, id1, "灯光大亮")
        sid = r.json()["suggestions"][0]["id"]
        r = accept(c, v, sid)
        check(r.status_code == 200, "接受当前提示的提议")
        s = r.json()
        check(s["verify"]["round"] == 2, "接受当前提示重开核验轮次（+1）")
        check(s["verify"]["lighting"] is None and s["verify"]["sound"] is None,
              "本轮就绪已清空")
        check(s["current"]["content"] == "灯光大亮", "建议已写入当前提示")

        # 接受其他提示：不重开轮次。两工种重新对第 2 轮报就绪后，对 id2 提议接受
        for dept in ("lighting", "sound"):
            c.post("/api/verify/report", json={
                "department": dept, "cue_id": id1, "round": 2, "ready": True})
        r = suggest(c, s["version"], id2, "音乐激昂")
        sid2 = r.json()["suggestions"][-1]["id"]
        r = accept(c, s["version"], sid2)
        check(r.status_code == 200, "接受其他待发提示的提议")
        s2 = r.json()
        check(s2["verify"]["round"] == 2 and s2["verify"]["all_ready"] is True,
              "接受其他提示不重开轮次、不清空就绪")

        # 自动计时：开启自动后接受当前提示应从完整间隔重新计时
        r = c.post("/api/auto", json={"version": s2["version"],
                                      "enabled": True, "interval": 60})
        check(r.status_code == 200, "开启自动发出（60 秒）")
        v3 = r.json()["version"]
        deadline_before = main._clock() + 60
        r = suggest(c, v3, id1, "灯光渐暗")
        sid3 = r.json()["suggestions"][-1]["id"]
        # 等待一小段时间让 deadline 临近，再接受：deadline 应被重置到新时刻
        import time as _time
        _time.sleep(0.05)
        r = accept(c, v3, sid3)
        check(r.status_code == 200, "接受当前提示（自动模式开启中）")
        with main.db() as conn:
            meta = conn.execute(
                "SELECT auto_deadline FROM meta WHERE id = 1").fetchone()
        check(meta["auto_deadline"] is not None
              and meta["auto_deadline"] > deadline_before + 0.04,
              "接受当前提示后自动计时从完整间隔重新计起")
        # 未到期：后台 tick 不发出
        check(main.auto_tick() is False, "重计后未到期，自动发出不触发")

        # 接受其他提示不重置计时
        with main.db() as conn:
            d0 = conn.execute(
                "SELECT auto_deadline FROM meta WHERE id = 1").fetchone()["auto_deadline"]
        r = c.get("/api/state").json()
        r2 = suggest(c, r["version"], id2, "音乐缓起")
        sid4 = r2.json()["suggestions"][-1]["id"]
        r = accept(c, r["version"], sid4)
        check(r.status_code == 200, "自动模式下接受其他提示")
        with main.db() as conn:
            d1 = conn.execute(
                "SELECT auto_deadline FROM meta WHERE id = 1").fetchone()["auto_deadline"]
        check(abs(d1 - d0) < 1e-6, "接受其他提示不重置自动计时")


def test_accept_interleave_auto_emit():
    main.DB_PATH = os.path.join(_tmp, "auto-race.db")
    with TestClient(main.app) as c:
        print("S8 自动发出与接受交错：自动先发则接受 409，提议保持待审；接受先成则 tick 落空")
        s = setup_show(c)
        v = s["version"]
        id1 = s["pending"][0]["id"]
        # 开启 1 秒自动发出
        r = c.post("/api/auto", json={"version": v, "enabled": True, "interval": 1})
        check(r.status_code == 200, "开启自动（1 秒）")
        v = r.json()["version"]
        r = suggest(c, v, id1, "新内容")
        sid = r.json()["suggestions"][0]["id"]

        # 等到期后让后台 tick 先发出
        import time as _time
        _time.sleep(1.05)
        check(main.auto_tick() is True, "到期自动发出一条")
        s = c.get("/api/state").json()
        check(s["current"] is None or s["current"]["id"] != id1, "首条已自动发出")
        check(s["version"] == v + 1, "自动发出推进版本")
        r = accept(c, v, sid)
        check(r.status_code == 409, "旧版本接受：409（自动先生效）")
        r = accept(c, s["version"], sid)
        check(r.status_code == 409, "即便用最新版本，目标已发出仍 409")
        check(next(x for x in c.get("/api/state").json()["suggestions"]
                   if x["id"] == sid)["status"] == "pending",
              "交错失败后提议保持待审，未留半次结果")


def test_same_version_competition():
    main.DB_PATH = os.path.join(_tmp, "race.db")
    with TestClient(main.app) as c:
        print("S9 同版本竞争：接受与确认 / 编辑最多一个成功")
        s = setup_show(c)
        v = s["version"]
        id1 = s["pending"][0]["id"]
        r = suggest(c, v, id1, "建议")
        sid = r.json()["suggestions"][0]["id"]

        r1 = accept(c, v, sid)
        r2 = c.post("/api/confirm", json={"version": v})
        codes = sorted([r1.status_code, r2.status_code])
        check(codes == [200, 409], "同版本接受与确认：一个 200 一个 409")
        after = c.get("/api/state").json()
        check(after["version"] == v + 1, "竞争后版本只 +1")
        if r1.status_code == 200:
            check(after["current"]["content"] == "建议", "接受先生效：写入建议，确认落空")
            check(after["suggestions"][0]["status"] == "accepted", "提议已接受")
        else:
            check(after["issued"][0]["content"] == "灯光渐亮", "确认先生效：按原文发出")
            check(after["suggestions"][0]["status"] == "pending",
                  "接受落败后提议仍待审（目标已发出，页面提示失效）")


def test_control_seat():
    main.DB_PATH = os.path.join(_tmp, "control.db")
    with TestClient(main.app) as c:
        print("S10 控制席：提交无需凭据（不 403，资格如实回报）；接受 / 拒绝要凭据")
        s = setup_show(c)
        v = s["version"]
        id1 = s["pending"][0]["id"]

        r = c.post("/api/control/enable", json={"version": v})
        check(r.status_code == 200, "启用控制席")
        tok = r.json()["control_token"]
        v = r.json()["version"]

        # 无凭据提交：允许（只读页可提议）
        r = suggest(c, v, id1, "无凭据建议")
        check(r.status_code == 200, "无控制凭据仍可提交提议")
        check(r.json()["control_granted"] is False, "提交响应如实回报资格 false")
        # 带失效凭据提交：也允许，资格 false
        r = c.post(
            "/api/suggestions",
            json={"version": v, "cue_id": id1, "content": "旧凭据建议"},
            headers={"X-Control-Token": "wrong"},
        )
        check(r.status_code == 200, "失效凭据提交不返回 403")
        check(r.json()["control_granted"] is False, "失效凭据资格回报 false")
        # 当前控制席提交：资格 true
        r = c.post(
            "/api/suggestions",
            json={"version": v, "cue_id": id1, "content": "控制席建议"},
            headers={"X-Control-Token": tok},
        )
        check(r.status_code == 200 and r.json()["control_granted"] is True,
              "当前控制席提交且资格回报 true")
        suggestions = r.json()["suggestions"]
        check(len(suggestions) == 3, "三条提议均已保存（提交不受控制席限制）")

        # 接受 / 拒绝需要凭据
        sid = suggestions[0]["id"]
        r = accept(c, v, sid)
        check(r.status_code == 403, "无凭据接受返回 403")
        check(r.json()["state"]["control_granted"] is False, "403 附最新状态")
        r = accept(c, v, sid, token="wrong")
        check(r.status_code == 403, "失效凭据接受返回 403")
        snap = c.get("/api/state").json()
        check(snap["version"] == v and all(x["status"] == "pending" for x in snap["suggestions"]),
              "403 后版本与提议状态都不变")

        r = reject(c, v, suggestions[1]["id"], token=tok)
        check(r.status_code == 200, "控制席可拒绝")
        r = accept(c, v, sid, token=tok)
        check(r.status_code == 200, "控制席可接受")
        check(c.get("/api/state").json()["version"] == v + 1, "接受后版本 +1，拒绝不动版本")


def test_persistence_and_clearing():
    db_file = os.path.join(_tmp, "persist.db")
    main.DB_PATH = db_file
    with TestClient(main.app) as c:
        print("S11 持久化与清空：刷新 / 重启保留；归档 / 重置 / 录入 / 开新场清空，不进档案")
        s = setup_show(c)
        v = s["version"]
        id2 = s["pending"][1]["id"]
        r = suggest(c, v, id2, "待审建议")
        sid = r.json()["suggestions"][0]["id"]
        # 再来一条待审与一条已拒绝，覆盖各状态
        r = suggest(c, v, id2, "另一条待审")
        pending_sid = r.json()["suggestions"][-1]["id"]
        r = suggest(c, v, id2, "将被拒绝")
        reject_sid = r.json()["suggestions"][-1]["id"]
        # 第一条接受（版本 +1）
        r = accept(c, v, sid)
        check(r.status_code == 200, "接受一条")
        v = r.json()["version"]
        r = reject(c, v, reject_sid)
        check(r.status_code == 200, "拒绝一条（版本不变）")

    # 重启
    with TestClient(main.app) as c:
        s = c.get("/api/state").json()
        statuses = {x["id"]: x["status"] for x in s["suggestions"]}
        check(statuses.get(sid) == "accepted", "重启后已接受提议保留")
        check(statuses.get(pending_sid) == "pending", "重启后待审提议保留")
        check(statuses.get(reject_sid) == "rejected", "重启后已拒绝提议保留")

        # 归档：提议不进档案，当前场清空
        v = s["version"]
        r = c.post("/api/archive", json={"version": v, "name": "提议场"})
        check(r.status_code == 200, "归档成功")
        v = r.json()["version"]
        check(r.json()["suggestions"] == [], "归档后当前场提议已清空")
        aid = c.get("/api/archives").json()["archives"][0]["id"]
        detail = c.get(f"/api/archives/{aid}").json()
        check("suggestions" not in detail, "档案结构不含提议（不进档案）")

        # 以档案开新场：提议仍为空
        r = c.post(f"/api/archives/{aid}/start", json={"version": v})
        check(r.status_code == 200, "以档案开新场")
        check(r.json()["suggestions"] == [], "开新场不继承提议")

        # 手工录入新场：清空
        v = r.json()["version"]
        id_new = r.json()["pending"][0]["id"]
        r = suggest(c, v, id_new, "新场提议")
        check(r.status_code == 200, "新场可再提交")
        r = c.post("/api/setup", json={"cues": CUES3})
        check(r.status_code == 200, "手工录入另一新场")
        check(r.json()["suggestions"] == [], "手工录入新场清空旧提议")

        # 重置清空
        v = r.json()["version"]
        r = suggest(c, v, r.json()["pending"][0]["id"], "x")
        check(r.status_code == 200, "提交一条")
        r = c.post("/api/reset", json={})
        check(r.status_code == 200, "重置")
        check(r.json()["suggestions"] == [], "重置清空提议")
        # 既有档案仍在
        check(len(c.get("/api/archives").json()["archives"]) == 1, "既有档案不受影响")


def test_write_failure_atomic():
    main.DB_PATH = os.path.join(_tmp, "atomic.db")
    with TestClient(main.app) as c:
        print("S12 写入失败：接受事务回滚，不留半次结果")
        s = setup_show(c)
        v = s["version"]
        id1 = s["pending"][0]["id"]
        r = suggest(c, v, id1, "建议")
        sid = r.json()["suggestions"][0]["id"]

        import sqlite3
        import types

        real_sqlite3 = main.sqlite3
        real_connect = real_sqlite3.connect

        class FailConn(real_sqlite3.Connection):
            def execute(self, sql, params=()):
                # 接受事务中"标记已接受"那步抛错：整条事务回滚
                if isinstance(sql, str) and "UPDATE suggestions SET status = 'accepted'" in sql:
                    raise real_sqlite3.OperationalError("simulated write failure")
                return super().execute(sql, params)

        def fail_connect(*a, **k):
            k["factory"] = FailConn
            return real_connect(*a, **k)

        shim = types.SimpleNamespace(
            connect=fail_connect,
            OperationalError=real_sqlite3.OperationalError,
            Row=real_sqlite3.Row,
        )
        main.sqlite3 = shim
        try:
            with TestClient(main.app, raise_server_exceptions=False) as cf:
                r = accept(cf, v, sid)
            check(r.status_code == 500, "写入失败返回错误")
        finally:
            main.sqlite3 = real_sqlite3
        snap = c.get("/api/state").json()
        check(snap["version"] == v, "回滚：版本不变")
        check(pending_by_id(snap, id1)["content"] == "灯光渐亮", "回滚：提示内容未改")
        check(snap["suggestions"][0]["status"] == "pending", "回滚：提议仍待审")
        # 失败后可正常重试
        r = accept(c, v, sid)
        check(r.status_code == 200, "回滚后同一提议仍可正常接受")


test_submit_basic()
test_submit_failures()
test_accept_basic()
test_reject_no_version_bump()
test_proposal_survives_other_changes()
test_accept_target_invalidated()
test_accept_verify_round_and_auto_timer()
test_accept_interleave_auto_emit()
test_same_version_competition()
test_control_seat()
test_persistence_and_clearing()
test_write_failure_atomic()

print("\n全部通过" if failures == 0 else f"\n失败 {failures} 处断言")
sys.exit(0 if failures == 0 else 1)
