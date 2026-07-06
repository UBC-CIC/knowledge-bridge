import pytest
import time
from unittest.mock import MagicMock, patch, call
import requests as req_lib

from graph import _graph_get, _GRAPH_MAX_RETRIES, get_cached_token


def _make_response(status_code, headers=None, json_data=None):
    resp = MagicMock(spec=req_lib.Response)
    resp.status_code = status_code
    resp.headers = headers or {}
    resp.json.return_value = json_data or {}
    if status_code >= 400:
        resp.raise_for_status.side_effect = req_lib.HTTPError(response=resp)
    else:
        resp.raise_for_status.return_value = None
    return resp


class TestGraphGet:
    def test_success_on_first_attempt(self):
        ok = _make_response(200)
        with patch("graph.requests.get", return_value=ok) as mock_get, \
             patch("graph.time.sleep") as mock_sleep:
            result = _graph_get("https://example.com", {})
            assert result is ok
            mock_sleep.assert_not_called()
            assert mock_get.call_count == 1

    def test_retries_on_429_then_succeeds(self):
        throttled = _make_response(429, headers={"Retry-After": "1"})
        ok = _make_response(200)
        with patch("graph.requests.get", side_effect=[throttled, throttled, ok]), \
             patch("graph.time.sleep") as mock_sleep:
            result = _graph_get("https://example.com", {})
            assert result is ok
            assert mock_sleep.call_count == 2

    def test_respects_retry_after_header(self):
        throttled = _make_response(429, headers={"Retry-After": "7"})
        ok = _make_response(200)
        with patch("graph.requests.get", side_effect=[throttled, ok]), \
             patch("graph.time.sleep") as mock_sleep:
            _graph_get("https://example.com", {})
            mock_sleep.assert_called_once_with(7)

    def test_retries_on_500(self):
        server_err = _make_response(500)
        ok = _make_response(200)
        with patch("graph.requests.get", side_effect=[server_err, ok]), \
             patch("graph.time.sleep"):
            result = _graph_get("https://example.com", {})
            assert result is ok

    def test_raises_immediately_on_404(self):
        not_found = _make_response(404)
        with patch("graph.requests.get", return_value=not_found), \
             patch("graph.time.sleep") as mock_sleep:
            with pytest.raises(req_lib.HTTPError):
                _graph_get("https://example.com", {})
            mock_sleep.assert_not_called()

    def test_raises_after_max_retries_on_429(self):
        throttled = _make_response(429, headers={"Retry-After": "1"})
        responses = [throttled] * _GRAPH_MAX_RETRIES
        with patch("graph.requests.get", side_effect=responses), \
             patch("graph.time.sleep"):
            with pytest.raises(req_lib.HTTPError):
                _graph_get("https://example.com", {})

    def test_wait_capped_at_60_seconds(self):
        throttled = _make_response(429, headers={"Retry-After": "999"})
        ok = _make_response(200)
        with patch("graph.requests.get", side_effect=[throttled, ok]), \
             patch("graph.time.sleep") as mock_sleep:
            _graph_get("https://example.com", {})
            mock_sleep.assert_called_once_with(60)

    def test_passes_timeout_to_requests(self):
        ok = _make_response(200)
        with patch("graph.requests.get", return_value=ok) as mock_get, \
             patch("graph.time.sleep"):
            _graph_get("https://example.com", {"Authorization": "Bearer tok"})
            _, kwargs = mock_get.call_args
            assert "timeout" in kwargs


class TestGetCachedToken:
    def test_cache_miss_calls_get_token(self):
        cred = MagicMock()
        token = MagicMock()
        token.expires_on = int(time.time()) + 3600
        cred.get_token.return_value = token

        # Clear the module-level cache before testing
        import graph
        graph._TOKEN_CACHE.clear()

        result = get_cached_token(cred, "test_ns", "https://example.com/.default")
        assert cred.get_token.call_count == 1
        assert result == token.token

    def test_cache_hit_does_not_call_get_token_again(self):
        cred = MagicMock()
        token = MagicMock()
        token.expires_on = int(time.time()) + 3600
        cred.get_token.return_value = token

        import graph
        graph._TOKEN_CACHE.clear()

        get_cached_token(cred, "test_ns2", "https://example2.com/.default")
        get_cached_token(cred, "test_ns2", "https://example2.com/.default")
        assert cred.get_token.call_count == 1

    def test_expired_token_refreshed(self):
        cred = MagicMock()
        expired_token = MagicMock()
        expired_token.expires_on = int(time.time()) - 10  # already expired
        fresh_token = MagicMock()
        fresh_token.expires_on = int(time.time()) + 3600
        cred.get_token.side_effect = [expired_token, fresh_token]

        import graph
        graph._TOKEN_CACHE.clear()

        get_cached_token(cred, "test_ns3", "https://example3.com/.default")
        get_cached_token(cred, "test_ns3", "https://example3.com/.default")
        assert cred.get_token.call_count == 2
