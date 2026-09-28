from connectors import (ConnectorError, classify_http_error, INVALID_API_KEY,
                        MODEL_RETIRED, INSUFFICIENT_CREDIT)

def test_401_is_invalid_key():
    assert classify_http_error(401, "Unauthorized") == INVALID_API_KEY

def test_403_with_key_words_is_invalid_key_else_none():
    assert classify_http_error(403, "invalid api key") == INVALID_API_KEY
    assert classify_http_error(403, "region not allowed") is None

def test_retired_model_messages():
    for msg in ["model gemini-2.5-flash is no longer available to new users",
                "The model `x` has been deprecated", "model_not_found: kling-v1"]:
        assert classify_http_error(404, msg) == MODEL_RETIRED
        assert classify_http_error(400, msg) == MODEL_RETIRED

def test_balance_messages():
    assert classify_http_error(402, "") == INSUFFICIENT_CREDIT
    assert classify_http_error(400, "account balance not enough") == INSUFFICIENT_CREDIT
    assert classify_http_error(429, "quota exceeded for this billing period") == INSUFFICIENT_CREDIT

def test_everything_else_is_none():
    assert classify_http_error(500, "internal") is None
    assert classify_http_error(429, "rate limit, slow down") is None

def test_no_false_invalid_key():
    # A good key must never be called bad: these are 403s about other things.
    assert classify_http_error(403, "authentication method not supported in this region") is None
    assert classify_http_error(403, "token quota for this feature is disabled") is None
