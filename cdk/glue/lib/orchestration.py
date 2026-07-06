"""
Core ingestion orchestration.

Drives the per-list and per-site ingestion loops: resolves permissions, fetches
delta changes from Graph, narrates and embeds each item, and persists documents
and vectors to PostgreSQL.

All external dependencies (DB, Graph context, narration/chunking/embedding
callables) are injected so this module has no module-level AWS or Azure state.
"""

import hashlib
import json
import logging
from typing import Optional

import db_repo
from field_cleaning import clean_item_for_llm, clean_list_url, is_eligible_sharepoint_list
from graph import GraphContext, fetch_list_changes, get_column_mapping
from metrics import compute_ingested_count
from permissions import get_list_authorized_groups, upsert_entra_groups

logger = logging.getLogger(__name__)


def log(msg):
    """Print to stdout flushed — reliably captured by Glue CloudWatch output stream."""
    import sys
    print(msg, flush=True)


async def run_sharepoint_list_ingestion(
    site_row_id: str,
    external_site_id: str,
    sp_list,
    ctx: GraphContext,
    narrate_fn,
    chunk_fn,
    embed_fn,
    triggered_by: str = "manual",
    force_full: bool = False,
) -> dict:
    if not is_eligible_sharepoint_list(sp_list):
        log(f"Skipping ineligible list: {sp_list.display_name}")
        return {"source_id": None, "status": "skipped", "list_id": sp_list.id, "list_name": sp_list.display_name}

    log(f"--- Processing list: {sp_list.display_name} ---")

    auth_groups = await get_list_authorized_groups(external_site_id, sp_list.id, ctx)
    await upsert_entra_groups(auth_groups, ctx, db_repo.get_conn())

    source_row_id = db_repo.upsert_site_source(
        site_id=site_row_id,
        source_type="list",
        external_source_id=sp_list.id,
        name=sp_list.display_name,
        source_url=None,
        total_documents=0,
        group_ids=auth_groups,
    )

    if force_full:
        log(f"force_full=True — clearing existing documents for {sp_list.display_name}")
        db_repo.clear_source_documents_and_vectors(source_row_id)

    existing_cursor = None if force_full else db_repo.get_source_cursor(source_row_id)
    name_map = await get_column_mapping(external_site_id, sp_list.id, ctx.graph_client)
    changes, proposed_delta_link = fetch_list_changes(
        external_site_id, sp_list.id, ctx.get_graph_headers, existing_delta_link=existing_cursor
    )

    source_run_id = db_repo.start_ingestion_run(
        site_id=site_row_id,
        source_id=source_row_id,
        run_type="source",
        total_documents=len(changes or []),
        triggered_by=triggered_by,
    )

    if not changes:
        log(f"No changes for {sp_list.display_name}.")
        if proposed_delta_link:
            db_repo.save_source_cursor(source_row_id, proposed_delta_link)
        db_repo.refresh_source_counts(source_row_id)
        db_repo.finish_ingestion_run(source_run_id, "completed")
        return {
            "source_id": source_row_id, "run_id": source_run_id, "status": "completed",
            "processed": 0, "skipped": 0, "failed": 0,
            "list_id": sp_list.id, "list_name": sp_list.display_name,
        }

    total_items = len(changes)
    log(f"Processing {total_items} items in '{sp_list.display_name}'")
    source_success = True
    failed_count = 0
    skipped_count = 0
    processed_count = 0

    for item in changes:
        item_id = item.get("id")
        try:
            is_deleted = "deleted" in item or "@removed" in item
            if is_deleted:
                db_repo.delete_document_by_external_id(source_row_id, item_id)
                db_repo.update_run_counts(source_run_id, processed_delta=1, ingested_delta=1)
                processed_count += 1
                continue

            clean_fields = clean_item_for_llm(item.get("fields", {}), name_map)
            narrative = narrate_fn(clean_fields, list_title=sp_list.display_name)
            if not narrative:
                raise ValueError(f"Empty narration for item {item_id}")

            raw_url = item.get("webUrl", "")
            clean_url = clean_list_url(raw_url)
            structured_id = hashlib.sha256(f"{external_site_id}_{sp_list.id}_{item_id}".encode()).hexdigest()
            extra_metadata = {
                "structured_id": structured_id,
                "sharepoint_site_id": external_site_id,
                "sharepoint_list_id": sp_list.id,
                "sharepoint_list_title": sp_list.display_name,
                "sharepoint_item_id": item_id,
            }

            _, status = db_repo.upsert_document_and_vectors(
                site_id=site_row_id,
                source_id=source_row_id,
                document_type="list_item",
                external_document_id=item_id,
                title=clean_fields.get("Title") or clean_fields.get("title") or sp_list.display_name,
                source_url=clean_url,
                raw_content=clean_fields,
                text_content=narrative,
                source_group_ids=auth_groups,
                chunk_fn=chunk_fn,
                embed_fn=embed_fn,
                extra_metadata=extra_metadata,
                force_full=force_full,
            )

            if status == "skipped":
                db_repo.update_run_counts(source_run_id, processed_delta=1, skipped_delta=1)
                skipped_count += 1
            else:
                db_repo.update_run_counts(source_run_id, processed_delta=1, ingested_delta=1)
            processed_count += 1
            log(f"[{processed_count}/{total_items}] '{sp_list.display_name}' — item {item_id} {status}")

        except Exception as e:
            logger.error(f"Failed item {item_id}: {e}", exc_info=True)
            source_success = False
            failed_count += 1
            processed_count += 1
            db_repo.update_run_counts(source_run_id, processed_delta=1, failed_delta=1)
            log(f"[{processed_count}/{total_items}] '{sp_list.display_name}' — item {item_id} FAILED")

    verified_success, verification_stats = db_repo.verify_source_ingestion_success(source_row_id)
    final_status = "completed" if (source_success and verified_success) else "partial"

    if final_status == "completed" and proposed_delta_link:
        db_repo.save_source_cursor(source_row_id, proposed_delta_link)

    db_repo.refresh_source_counts(source_row_id)
    db_repo.finish_ingestion_run(
        source_run_id, final_status,
        error_message=None if final_status == "completed" else json.dumps(verification_stats),
    )

    log(f"Finished {sp_list.display_name}: status={final_status}, processed={processed_count}, skipped={skipped_count}, failed={failed_count}")
    return {
        "source_id": source_row_id, "run_id": source_run_id, "status": final_status,
        "processed": processed_count, "skipped": skipped_count, "failed": failed_count,
        "list_id": sp_list.id, "list_name": sp_list.display_name,
    }


async def run_site_ingestion(
    site_id: str,
    ctx: GraphContext,
    narrate_fn,
    chunk_fn,
    embed_fn,
    ingestion_run_id: Optional[str],
    triggered_by: str = "manual",
    force_full: bool = False,
) -> str:
    from graph import resolve_site_url
    site_url = await resolve_site_url(site_id, ctx.graph_client)
    site_row_id = db_repo.upsert_site(external_site_id=site_id, name="SharePoint Site", site_url=site_url)

    log("Discovering lists...")
    lists = await ctx.graph_client.sites.by_site_id(site_id).lists.get()
    eligible = [l for l in lists.value if is_eligible_sharepoint_list(l)]
    log(f"Found {len(eligible)} eligible lists.")

    any_failed = False
    completed = failed = 0
    total_processed = total_ingested = total_skipped = total_failed = 0

    for sp_list in eligible:
        try:
            result = await run_sharepoint_list_ingestion(
                site_row_id=site_row_id,
                external_site_id=site_id,
                sp_list=sp_list,
                ctx=ctx,
                narrate_fn=narrate_fn,
                chunk_fn=chunk_fn,
                embed_fn=embed_fn,
                triggered_by=triggered_by,
                force_full=force_full,
            )
            total_processed += result.get("processed", 0)
            total_skipped += result.get("skipped", 0)
            total_failed += result.get("failed", 0)
            total_ingested += compute_ingested_count(
                result.get("processed", 0), result.get("skipped", 0), result.get("failed", 0)
            )
            if result["status"] in ("completed", "partial"):
                completed += 1
                if result.get("failed", 0) > 0:
                    any_failed = True
            else:
                failed += 1
                any_failed = True
        except Exception as e:
            logger.error(f"Failed list {sp_list.display_name}: {e}", exc_info=True)
            any_failed = True
            failed += 1

    db_repo.refresh_site_status(site_row_id)
    final_status = "failed" if (failed == len(eligible) and len(eligible) > 0) else "completed"
    error_msg = None if not any_failed else json.dumps({"lists_completed": completed, "lists_failed": failed})

    if ingestion_run_id:
        db_repo.update_site_ingestion_run(
            run_id=ingestion_run_id,
            site_id=site_row_id,
            status=final_status,
            total=len(eligible),
            processed=total_processed,
            ingested=total_ingested,
            skipped=total_skipped,
            failed=total_failed,
            error_message=error_msg,
        )

    log(f"Site ingestion done: status={final_status}, completed={completed}, failed={failed}")
    return site_row_id
