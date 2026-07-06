import pytest
from metrics import compute_ingested_count


class TestComputeIngestedCount:
    def test_all_ingested(self):
        assert compute_ingested_count(processed=10, skipped=0, failed=0) == 10

    def test_some_skipped(self):
        assert compute_ingested_count(processed=10, skipped=3, failed=0) == 7

    def test_some_failed(self):
        assert compute_ingested_count(processed=10, skipped=0, failed=2) == 8

    def test_mixed(self):
        assert compute_ingested_count(processed=10, skipped=2, failed=1) == 7

    def test_all_skipped(self):
        assert compute_ingested_count(processed=5, skipped=5, failed=0) == 0

    def test_all_failed(self):
        assert compute_ingested_count(processed=5, skipped=0, failed=5) == 0

    def test_zero_everything(self):
        assert compute_ingested_count(processed=0, skipped=0, failed=0) == 0

    def test_result_floored_at_zero(self):
        # Guard against negative counts if callers pass bad data
        assert compute_ingested_count(processed=2, skipped=3, failed=2) == 0
