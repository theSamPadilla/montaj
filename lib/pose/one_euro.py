"""The One Euro filter (Casiez, Roussel and Vogel, CHI 2012) on arrays of
values, one timestamp at a time.

Each value is low-passed with a cutoff that rises with its own speed: still
points get min_cutoff (Hz) and lose their jitter, fast ones get
min_cutoff + beta * speed and keep up. The speed is the raw change per second
divided by `scale` (the tracked object's size), so beta means the same for a
hand near the camera and one far from it.
"""
import math

import numpy as np

D_CUTOFF = 1.0   # Hz, the cutoff of the speed estimate


def _alpha(cutoff, dt):
    tau = 1.0 / (2 * math.pi * cutoff)
    return 1.0 / (1.0 + tau / dt)


class OneEuro:
    def __init__(self, min_cutoff, beta, d_cutoff=D_CUTOFF):
        self.min_cutoff = min_cutoff
        self.beta = beta
        self.d_cutoff = d_cutoff
        self.t = None
        self.raw = None
        self.value = None
        self.speed = None

    def __call__(self, t, value, scale=1.0):
        value = np.asarray(value, dtype=np.float64)
        if self.t is None:
            self.t, self.raw, self.value = t, value, value
            self.speed = np.zeros_like(value)
            return self.value
        if t <= self.t:
            return self.value
        dt = t - self.t
        speed = (value - self.raw) / (dt * scale)
        self.speed = self.speed + _alpha(self.d_cutoff, dt) * (speed - self.speed)
        a = _alpha(self.min_cutoff + self.beta * np.abs(self.speed), dt)
        self.value = self.value + a * (value - self.value)
        self.t, self.raw = t, value
        return self.value


def extent(points):
    """An object's size for `scale`: the mean of its x and y extents."""
    p = np.asarray(points, dtype=np.float64)
    span = p[:, :2].max(axis=0) - p[:, :2].min(axis=0)
    return max(float(span.mean()), 1e-9)
