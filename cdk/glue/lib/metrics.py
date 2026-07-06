"""
Ingestion metric helpers.

Pure arithmetic functions for computing run-level counts, extracted from
the orchestration layer so they can be unit-tested independently.
"""


def compute_ingested_count(processed: int, skipped: int, failed: int) -> int:
    return max(0, processed - skipped - failed)
