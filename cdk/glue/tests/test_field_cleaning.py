import pytest
from unittest.mock import MagicMock
from field_cleaning import SYSTEM_JUNK, clean_item_for_llm, clean_list_url, is_eligible_sharepoint_list


class TestCleanItemForLlm:
    def test_empty_inputs(self):
        assert clean_item_for_llm({}, {}) == {}

    def test_system_junk_excluded(self):
        raw = {k: "value" for k in SYSTEM_JUNK}
        name_map = {k: k for k in SYSTEM_JUNK}
        assert clean_item_for_llm(raw, name_map) == {}

    def test_at_prefix_excluded(self):
        assert clean_item_for_llm({"@odata.type": "val"}, {"@odata.type": "Type"}) == {}

    def test_underscore_prefix_excluded(self):
        assert clean_item_for_llm({"_hidden": "val"}, {"_hidden": "Hidden"}) == {}

    def test_lookup_id_suffix_excluded(self):
        assert clean_item_for_llm({"CategoryLookupId": "5"}, {"CategoryLookupId": "Category"}) == {}

    def test_key_not_in_name_map_excluded(self):
        assert clean_item_for_llm({"Title": "Hello"}, {}) == {}

    def test_none_value_excluded(self):
        assert clean_item_for_llm({"Title": None}, {"Title": "Title"}) == {}

    def test_empty_string_value_excluded(self):
        assert clean_item_for_llm({"Title": "  "}, {"Title": "Title"}) == {}

    def test_valid_field_included(self):
        result = clean_item_for_llm({"Title": "Hello"}, {"Title": "Title"})
        assert result == {"Title": "Hello"}

    def test_dict_value_extracts_lookup_value(self):
        result = clean_item_for_llm(
            {"Category": {"LookupValue": "Science", "LookupId": 3}},
            {"Category": "Category"},
        )
        assert result == {"Category": "Science"}

    def test_dict_value_extracts_email_when_no_lookup(self):
        result = clean_item_for_llm(
            {"Author": {"Email": "user@example.com"}},
            {"Author": "Author"},
        )
        assert result == {"Author": "user@example.com"}

    def test_dict_value_falls_back_to_str(self):
        result = clean_item_for_llm(
            {"Misc": {"something": "else"}},
            {"Misc": "Misc"},
        )
        assert result == {"Misc": str({"something": "else"})}

    def test_readable_key_used_not_raw_key(self):
        result = clean_item_for_llm({"field_x": "val"}, {"field_x": "Field X"})
        assert "Field X" in result
        assert "field_x" not in result


class TestCleanListUrl:
    def test_url_with_lists_truncated(self):
        url = "https://example.com/sites/s/Lists/MyList/AllItems.aspx"
        assert clean_list_url(url) == "https://example.com/sites/s/Lists/MyList"

    def test_url_without_lists_unchanged(self):
        url = "https://example.com/sites/s/SomePage"
        assert clean_list_url(url) == url

    def test_empty_string(self):
        assert clean_list_url("") == ""

    def test_none_returns_empty(self):
        assert clean_list_url(None) == ""


class TestIsEligibleSharepointList:
    def _make_list(self, system=None, hidden=False, template="genericList", display_name="MyList"):
        sp_list = MagicMock()
        sp_list.system = system
        sp_list.list_ = MagicMock()
        sp_list.list_.hidden = hidden
        sp_list.list_.template = template
        sp_list.display_name = display_name
        return sp_list

    def test_eligible_list(self):
        assert is_eligible_sharepoint_list(self._make_list()) is True

    def test_system_list_excluded(self):
        assert is_eligible_sharepoint_list(self._make_list(system="something")) is False

    def test_hidden_list_excluded(self):
        assert is_eligible_sharepoint_list(self._make_list(hidden=True)) is False

    def test_non_generic_template_excluded(self):
        assert is_eligible_sharepoint_list(self._make_list(template="documentLibrary")) is False

    def test_underscore_display_name_excluded(self):
        assert is_eligible_sharepoint_list(self._make_list(display_name="_HiddenList")) is False

    def test_no_list_object(self):
        sp_list = MagicMock()
        sp_list.system = None
        sp_list.list_ = None
        sp_list.display_name = "MyList"
        assert is_eligible_sharepoint_list(sp_list) is True
