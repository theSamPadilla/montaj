"""§688: serve's stall alarm logs a loop block over 100 ms with what was running, and nothing else."""
import asyncio

from starlette.testclient import TestClient

from serve import stall_alarm as sa


def _reset():
    sa._recent.clear()
    sa._open.clear()


def test_unrouted_labels_keep_only_the_family():
    assert sa.route_label("get", "/api/projects/1b4e28ba-2fa1-11d2-883f-0016d3cca427/stream") == "GET /api/projects/:x/:x"
    assert sa.route_label("GET", "/api/profiles/acme/assets/logo") == "GET /api/profiles/:x/:x/:x"
    assert sa.route_label("POST", "/api/steps/sample_frame") == "POST /api/steps/:x"
    assert sa.route_label("GET", "/12345") == "GET /:x"


def test_a_routed_request_is_named_by_its_template_never_its_values():
    class R:
        path = "/api/profiles/{name}/assets/{filename}"
    assert sa.label_of({"method": "GET", "path": "/api/profiles/acme/assets/logo", "route": R()}) == "GET /api/profiles/{name}/assets/{filename}"


class Clock:
    def __init__(self):
        self.t = 0.0
        self.lag = []  # extra seconds each sleep "took"

    def __call__(self):
        return self.t

    async def sleep(self, s):
        await asyncio.sleep(0)  # yield, as a real sleep does, so a test can act during it
        self.t += s + (self.lag.pop(0) if self.lag else 0.0)


def _run(clock, ticks, **kw):
    lines = []
    asyncio.run(sa.run(write=lines.append, clock=clock, sleep=clock.sleep, ticks=ticks, **kw))
    return lines


def test_on_time_and_small_lags_log_nothing():
    _reset()
    c = Clock()
    c.lag = [0.0, 0.09, 0.05]
    assert _run(c, 3) == []


def test_a_block_names_what_entered_during_it_and_what_is_in_flight(monkeypatch):
    _reset()
    c = Clock()
    monkeypatch.setattr(sa, "_clock", c)

    async def go():
        lines = []
        old = sa._enter({"method": "GET", "path": "/api/projects/x/stream"})  # before the tick: in flight only
        c.t += 1.0
        task = asyncio.create_task(sa.run(write=lines.append, clock=c, sleep=c.sleep, ticks=1))
        await asyncio.sleep(0)  # the tick starts sleeping
        rid = sa._enter({"method": "PUT", "path": "/api/projects/x"})
        c.lag = [0.6]
        await task
        sa._open.pop(rid, None)
        sa._open.pop(old, None)
        return lines

    lines = asyncio.run(go())
    assert len(lines) == 1
    assert lines[0].startswith("stall: serve loop blocked 600 ms; entered: PUT /api/projects/:x; in flight (2): PUT /api/projects/:x 0.7s, GET /api/projects/:x/:x 1.7s"), lines[0]


def test_lines_are_capped_per_minute_then_summed():
    _reset()
    c = Clock()
    c.lag = [0.3] * 5 + [60.0]
    lines = _run(c, 6, max_per_min=2)
    assert len(lines) == 4  # two, the summary, then the 60 s block itself (a new minute)
    assert lines[2].startswith("stall: 3 more blocks over 100 ms in the last minute (worst 300 ms)")
    assert lines[3].startswith("stall: serve loop blocked 60000 ms")


def test_the_middleware_labels_a_request_while_it_runs_and_drops_it_after():
    _reset()
    from fastapi import FastAPI
    seen = {}
    inner = FastAPI()

    @inner.get("/api/projects/{pid}")
    async def probe(pid: str):
        seen["open"] = [sa.label_of(scope) for scope, _ in sa._open.values()]
        return {"ok": True}

    app = sa.StallLabels(inner)
    r = TestClient(app).get("/api/projects/1b4e28ba-2fa1-11d2-883f-0016d3cca427?x=1")
    assert r.status_code == 200
    assert seen["open"] == ["GET /api/projects/{pid}"]
    assert sa._open == {}


def test_serve_installs_the_middleware_outermost():
    from serve.server import app
    assert app.user_middleware[0].cls is sa.StallLabels
