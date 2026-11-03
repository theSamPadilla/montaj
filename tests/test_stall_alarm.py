"""§688: serve's stall alarm logs a loop block over 100 ms with what was running, and nothing else."""
import asyncio

from starlette.testclient import TestClient

from serve import stall_alarm as sa


def _reset():
    sa._recent.clear()
    sa._open.clear()


def test_route_labels_drop_ids_files_and_queries():
    assert sa.route_label("get", "/api/projects/1b4e28ba-2fa1-11d2-883f-0016d3cca427/stream") == "GET /api/projects/:id/stream"
    assert sa.route_label("GET", "/api/steps/jobs/12345") == "GET /api/steps/jobs/:id"
    assert sa.route_label("GET", "/api/files/%2FUsers%2Fsam%2Fclip.mov") == "GET /api/files/:x"
    assert sa.route_label("POST", "/api/steps/sample_frame") == "POST /api/steps/sample_frame"


class Clock:
    def __init__(self):
        self.t = 0.0
        self.lag = []  # extra seconds each sleep "took"

    def __call__(self):
        return self.t

    async def sleep(self, s):
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


def test_a_block_names_what_entered_and_what_is_in_flight():
    _reset()
    c = Clock()

    async def go():
        lines = []
        task = asyncio.create_task(sa.run(write=lines.append, clock=c, sleep=c.sleep, ticks=1))
        rid = sa._enter("PUT /api/projects/:id")
        c.lag = [0.6]
        await task
        sa._open.pop(rid, None)
        return lines

    lines = asyncio.run(go())
    assert len(lines) == 1
    assert lines[0].startswith("stall: serve loop blocked 600 ms; entered: PUT /api/projects/:id; in flight (1): PUT /api/projects/:id")


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
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    seen = {}

    async def probe(request):
        seen["open"] = [label for label, _ in sa._open.values()]
        return JSONResponse({"ok": True})

    app = sa.StallLabels(Starlette(routes=[Route("/api/projects/{pid}", probe)]))
    r = TestClient(app).get("/api/projects/1b4e28ba-2fa1-11d2-883f-0016d3cca427?x=1")
    assert r.status_code == 200
    assert seen["open"] == ["GET /api/projects/:id"]
    assert sa._open == {}


def test_serve_installs_the_middleware_outermost():
    from serve.server import app
    assert app.user_middleware[0].cls is sa.StallLabels
