import pytest
from chunking import rough_token_count, split_sentences, semantic_chunk_text


class TestRoughTokenCount:
    def test_empty_string_returns_one(self):
        assert rough_token_count("") == 1

    def test_single_word(self):
        assert rough_token_count("hello") == 1

    def test_three_words(self):
        # 3 * 1.3 = 3.9 → int = 3
        assert rough_token_count("one two three") == 3

    def test_scales_with_length(self):
        assert rough_token_count("a " * 100) > rough_token_count("a " * 10)


class TestSplitSentences:
    def test_empty_string(self):
        assert split_sentences("") == []

    def test_no_terminal_punctuation(self):
        assert split_sentences("Hello world") == ["Hello world"]

    def test_two_sentences_period(self):
        assert split_sentences("Hello. World.") == ["Hello.", "World."]

    def test_question_and_exclamation(self):
        assert split_sentences("Really? Yes!") == ["Really?", "Yes!"]

    def test_normalizes_whitespace(self):
        result = split_sentences("  multiple   spaces  ")
        assert result == ["multiple spaces"]

    def test_period_followed_by_space_splits(self):
        # The splitter fires on any ./?/! followed by whitespace — it does not
        # distinguish abbreviations from sentence endings. "e.g. something" splits.
        result = split_sentences("e.g. something")
        assert result == ["e.g.", "something"]


class TestSemanticChunkText:
    def test_empty_string(self):
        assert semantic_chunk_text("") == []

    def test_none_like_empty(self):
        assert semantic_chunk_text("   ") == []

    def test_short_text_single_chunk(self):
        result = semantic_chunk_text("short text")
        assert result == ["short text"]

    def test_long_text_produces_multiple_chunks(self):
        # 50 words per sentence, 10 sentences → well over 400 tokens
        sentence = "word " * 50 + "end."
        long_text = " ".join([sentence] * 10)
        chunks = semantic_chunk_text(long_text, max_tokens=100)
        assert len(chunks) > 1

    def test_all_chunks_non_empty(self):
        sentence = "word " * 50 + "end."
        long_text = " ".join([sentence] * 10)
        chunks = semantic_chunk_text(long_text, max_tokens=100)
        assert all(c.strip() for c in chunks)

    def test_paragraph_split_respected(self):
        # Two paragraphs that each fit in one chunk
        text = "First paragraph.\n\nSecond paragraph."
        chunks = semantic_chunk_text(text, max_tokens=400)
        assert len(chunks) == 1  # both fit together under 400 tokens

    def test_overlap_repeats_last_sentence(self):
        # Build text that forces chunking at a known boundary
        # Each "sentence" is ~80 tokens; max_tokens=100 means ~1 sentence per chunk
        sentence_a = ("word " * 60).strip() + ". "
        sentence_b = ("word " * 60).strip() + ". "
        sentence_c = ("word " * 60).strip() + "."
        text = sentence_a + sentence_b + sentence_c
        chunks = semantic_chunk_text(text, max_tokens=100, overlap_sentences=1)
        assert len(chunks) >= 2
        # The last sentence of chunk 0 should appear at the start of chunk 1
        last_of_first = chunks[0].split(". ")[-1]
        assert last_of_first in chunks[1]

    def test_no_overlap_when_zero(self):
        sentence = ("word " * 60).strip() + ". "
        text = sentence * 5
        chunks_overlap = semantic_chunk_text(text, max_tokens=100, overlap_sentences=1)
        chunks_no_overlap = semantic_chunk_text(text, max_tokens=100, overlap_sentences=0)
        # With no overlap, total content across chunks should be less
        assert sum(len(c) for c in chunks_no_overlap) <= sum(len(c) for c in chunks_overlap)
