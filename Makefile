.PHONY: test test-fast install

install:
	pip install -e ".[serve,test]"

test:
	pytest

test-fast:
	pytest -m "not slow"
