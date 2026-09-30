"""The pinned RVM model: the one file remove_bg runs, from RobustVideoMatting's
v1.0.0 release (GPL-3.0). The release publishes no digest; SHA256 was derived
from two independent fetches.

It lives at models.model_path("rvm", FILENAME). remove_bg never downloads it.
"""
FILENAME = "rvm_mobilenetv3_fp32.onnx"
URL = "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx"
SIZE = 14_975_696
SHA256 = "88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828"
