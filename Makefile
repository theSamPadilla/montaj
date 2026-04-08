.PHONY: test test-fast install

install:
	pip install -e ".[test]"

test:
	pytest

test-fast:
	pytest -m "not slow"
