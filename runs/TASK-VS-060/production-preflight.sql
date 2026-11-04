-- Read-only operator preflight for migration 070. Use psql -X -v ON_ERROR_STOP=1.
-- Requires an authorized connection to the actual production DB and sufficient
-- monitoring visibility. No credentials, row contents or SQL query texts in output.
\set ON_ERROR_STOP on
\timing on
SET default_transaction_read_only = on;
SET lock_timeout = '2s';
SET statement_timeout = '60s';
SET application_name = 'TASK-VS-060-readonly-preflight';

SELECT current_database(), current_user, current_schema(),
       current_setting('server_version'), current_setting('search_path'),
       current_setting('default_transaction_read_only') AS read_only,
       current_setting('lock_timeout'), current_setting('statement_timeout'),
       current_setting('transaction_timeout');
SELECT to_regclass('blog_posts') = to_regclass('public.blog_posts') AS schema_matches,
       to_regclass('public.blog_posts') AS posts_relation;
SELECT c.relkind, c.reltuples AS estimated_rows,
       pg_relation_size(c.oid) AS heap_bytes,
       pg_total_relation_size(c.oid) AS total_bytes,
       EXISTS (SELECT 1 FROM pg_inherits h WHERE h.inhrelid = c.oid OR h.inhparent = c.oid)
         AS inherited_or_partitioned
FROM pg_class c WHERE c.oid = to_regclass('public.blog_posts');
SELECT count(*) AS actual_posts,
       count(*) FILTER (WHERE category NOT IN (
         'วิธีดูสลิปปลอม', 'เทคนิคสำหรับร้านค้า',
         'คู่มือนักพัฒนา', 'ข่าวธนาคารและระบบ'
       )) AS names_outside_original_seeds
FROM public.blog_posts;
SELECT version_id, is_applied FROM public.goose_db_version ORDER BY id DESC LIMIT 1;
SELECT conname, contype, convalidated, pg_get_constraintdef(oid) AS definition
FROM pg_constraint WHERE conrelid = to_regclass('public.blog_posts')
  AND conname IN ('blog_posts_category_check', 'blog_posts_category_fkey');
SELECT n.nspname AS index_schema, c.relname, c.relkind,
       i.indrelid::regclass AS indexed_table, am.amname,
       i.indisunique, i.indisvalid, i.indisready, i.indislive,
       i.indnkeyatts, i.indnatts, i.indpred IS NULL AS no_predicate,
       i.indexprs IS NULL AS no_expression,
       CASE WHEN i.indexrelid IS NOT NULL THEN pg_get_indexdef(c.oid) END AS definition
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_index i ON i.indexrelid = c.oid
LEFT JOIN pg_am am ON am.oid = c.relam
WHERE n.nspname = 'public' AND c.relname = 'blog_posts_category_idx';
SELECT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false)
       OR pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS full_stats_visibility;
SELECT a.pid, a.state, now() - a.xact_start AS transaction_age,
       l.mode, l.granted, a.wait_event_type, a.wait_event,
       pg_blocking_pids(a.pid) AS blocking_pids
FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.relation = to_regclass('public.blog_posts') ORDER BY a.xact_start;
SELECT pid, state, now() - xact_start AS transaction_age,
       wait_event_type, wait_event, backend_xmin IS NOT NULL AS has_snapshot
FROM pg_stat_activity WHERE datid = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND xact_start IS NOT NULL AND pid <> pg_backend_pid() ORDER BY xact_start;
SELECT pid, command, phase, lockers_total, lockers_done, blocks_total, blocks_done
FROM pg_stat_progress_create_index WHERE relid = to_regclass('public.blog_posts');
