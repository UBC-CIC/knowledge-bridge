"""
SharePoint field cleaning and list eligibility helpers.

Filters raw Graph API field dicts down to human-readable content suitable
for LLM narration. No external dependencies — pure Python.
"""

import logging

logger = logging.getLogger(__name__)

SYSTEM_JUNK = {
    "AppAuthor", "AppEditor", "Attachments", "ColorTag", "_ColorTag",
    "ComplianceAssetId", "ContentType", "Edit", "FolderChildCount",
    "ID", "ItemChildCount", "_IsRecord", "LinkTitle", "LinkTitleNoMenu",
    "DocIcon", "_UIVersionString", "FileSystemObjectType", "LabelSetting", "RetentionLabel",
}


def clean_item_for_llm(raw_fields: dict, name_map: dict) -> dict:
    clean = {}
    for key, value in raw_fields.items():
        if key in SYSTEM_JUNK:
            continue
        if key.startswith(("@", "_")):
            continue
        if key.endswith("LookupId"):
            continue
        readable_key = name_map.get(key)
        if not readable_key:
            continue
        if value is not None and str(value).strip() != "":
            if isinstance(value, dict):
                value = value.get("LookupValue") or value.get("Email") or str(value)
            clean[readable_key] = value
    return clean


def clean_list_url(raw_url: str) -> str:
    clean_url = raw_url or ""
    if "/Lists/" in clean_url:
        parts = clean_url.split("/")
        try:
            idx = parts.index("Lists")
            clean_url = "/".join(parts[: idx + 2])
        except ValueError:
            pass
    return clean_url


def is_eligible_sharepoint_list(sp_list) -> bool:
    if sp_list.system is not None:
        return False
    if sp_list.list_ and sp_list.list_.hidden:
        return False
    if sp_list.list_ and sp_list.list_.template != "genericList":
        return False
    if sp_list.display_name and sp_list.display_name.startswith("_"):
        return False
    return True
