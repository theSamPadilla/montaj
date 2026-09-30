"""Credential storage and lookup for external API connectors.

Raises CredentialError on lookup/IO failures. Library code — does not call
sys.exit or fail(). Step scripts catch CredentialError (via its ConnectorError
base class) and translate to fail().
"""
import json, os, stat
from connectors import ConnectorError

CREDENTIALS_PATH = os.path.expanduser("~/.montaj/credentials.json")

# Single source of truth for which providers Montaj knows about and
# which keys each one needs. `montaj credentials` imports this.
# Adding a new connector → add it here first.
KNOWN_PROVIDERS: dict[str, list[str]] = {
    # Kling accepts EITHER a single API key OR the legacy access/secret pair.
    # Kling's own docs (kling.ai/document-api/api/get-started/authentication,
    # read 2026-09-29) put "API Key (for all models)" first and label
    # "Access Key / Secret Key" as "API only applicable to legacy version design
    # standards". Both are listed here because this dict is an ALLOWLIST of what
    # may be stored, not a set of required keys; REQUIRED_KEY_SETS below says
    # which combinations count as configured.
    "kling":      ["api_key", "access_key", "secret_key"],
    "gemini":     ["api_key"],
    "openai":     ["api_key"],
    "serpapi":    ["api_key"],
    "fal":        ["api_key"],
    "elevenlabs": ["api_key"],
}


# Which combinations of the keys above count as "configured". A provider is
# configured when ANY one of its sets is fully present. Only Kling has more than
# one: the current API key, or the legacy pair. Without this, adding `api_key` to
# Kling's allowlist would make every existing access/secret user read as
# unconfigured, because the CLI's readiness check is `all(keys are set)`.
REQUIRED_KEY_SETS: dict[str, list[list[str]]] = {
    "kling": [["api_key"], ["access_key", "secret_key"]],
}


def required_key_sets(provider: str) -> list[list[str]]:
    """The credential combinations that make `provider` usable.

    Defaults to "every key in KNOWN_PROVIDERS", which is right for every
    single-key provider. Kling overrides it.
    """
    return REQUIRED_KEY_SETS.get(provider, [list(KNOWN_PROVIDERS[provider])])


def provider_is_configured(provider: str, is_set) -> bool:
    """True when any one required key set is fully present.

    `is_set(provider, key) -> bool` is injected so callers can use the CLI's
    cached getter or a test double; this function does no I/O.
    """
    return any(all(is_set(provider, k) for k in ks)
               for ks in required_key_sets(provider))


class CredentialError(ConnectorError):
    """Raised on any credential issue: missing, corrupt file, unreadable file.

    Subclass of ConnectorError so existing `except ConnectorError` handlers
    in step scripts still catch it. Workflows that want provider-fallback
    behavior can catch CredentialError specifically.
    """


def _env_var_name(provider: str, key: str) -> str:
    # "kling", "access_key" -> "KLING_ACCESS_KEY"
    return f"{provider.upper()}_{key.upper()}"


def build_env_overlay(credentials: dict) -> dict[str, str]:
    """Map a per-request `credentials` payload to subprocess env vars.

    Input shape: ``{provider: {key: value}}``. Validates STRICTLY against
    KNOWN_PROVIDERS — providers and keys must be known, values must be
    non-empty strings. Returns ``{ENV_VAR_NAME: value}`` using `_env_var_name`.

    Pure: no I/O, no logging. On any violation raises CredentialError whose
    message names the offending provider/key NAME but NEVER a value — these
    payloads carry secrets and must not leak into logs or error responses.
    """
    if not isinstance(credentials, dict):
        raise CredentialError("credentials must be an object of {provider: {key: value}}")

    overlay: dict[str, str] = {}
    for provider, keys in credentials.items():
        if provider not in KNOWN_PROVIDERS:
            raise CredentialError(f"unknown credential provider: {provider!r}")
        if not isinstance(keys, dict):
            raise CredentialError(f"credentials for provider {provider!r} must be an object")
        known_keys = KNOWN_PROVIDERS[provider]
        for key, value in keys.items():
            if key not in known_keys:
                raise CredentialError(
                    f"unknown credential key {key!r} for provider {provider!r} "
                    f"(known keys: {known_keys})"
                )
            if not isinstance(value, str) or not value.strip():
                raise CredentialError(
                    f"credential {provider}.{key} must be a non-empty string"
                )
            overlay[_env_var_name(provider, key)] = value
    return overlay


def _read_file() -> dict:
    """Return parsed credentials.json, {} if absent. Raises CredentialError on bad file."""
    if not os.path.isfile(CREDENTIALS_PATH):
        return {}
    try:
        with open(CREDENTIALS_PATH) as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        raise CredentialError(
            f"{CREDENTIALS_PATH} is not valid JSON ({e.msg} at line {e.lineno}). "
            f"Fix the file or delete it, then run: "
            f"montaj credentials --provider <name> --key <key> --value <value>"
        ) from e
    except OSError as e:
        raise CredentialError(f"Could not read {CREDENTIALS_PATH}: {e}") from e


def get_credential(provider: str, key: str) -> str:
    """Return the credential value or raise CredentialError.

    Precedence: env var > ~/.montaj/credentials.json > raise.
    """
    env_val = os.environ.get(_env_var_name(provider, key), "").strip()
    if env_val:
        return env_val

    data = _read_file()
    val = (data.get(provider) or {}).get(key, "")
    if val:
        return val

    raise CredentialError(
        f"No {provider}.{key} credential found. Add your {provider} key in "
        f"Montaj under Connectors, or on the CLI: "
        f"montaj credentials --provider {provider} --key {key} --value <value> "
        f"(or set {_env_var_name(provider, key)})."
    )


def set_credential(provider: str, key: str, value: str) -> None:
    """Write credential to ~/.montaj/credentials.json with 0600 perms."""
    os.makedirs(os.path.dirname(CREDENTIALS_PATH), exist_ok=True)
    data = _read_file()
    data.setdefault(provider, {})[key] = value
    tmp = CREDENTIALS_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)  # 0600
    os.replace(tmp, CREDENTIALS_PATH)


def list_providers() -> dict:
    """Return all known providers with credential status (set/unset).

    Iterates KNOWN_PROVIDERS so unconfigured providers still appear.
    Never returns raw values — for display only.
    """
    data = _read_file()
    result = {}
    for provider, keys in KNOWN_PROVIDERS.items():
        provider_data = data.get(provider, {})
        result[provider] = {k: "set" if provider_data.get(k) else "unset" for k in keys}
    return result
