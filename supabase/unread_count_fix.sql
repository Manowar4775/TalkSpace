-- TalkSpace unread-count trigger preparation
--
-- REVIEW ONLY: this file is local and has not been run against Supabase.
-- Apply together with the matching frontend cutover after reviewing this SQL.
--
-- Ownership assumption: apply as Supabase's postgres role. Supabase documents
-- postgres as BYPASSRLS; this migration checks that assumption before DDL.
-- Both SECURITY DEFINER trigger functions will be owned by the applying role.

BEGIN;

-- Fail before creating objects if this is not the expected trusted owner.
DO $owner_guard$
BEGIN
    IF current_user <> 'postgres'
       OR NOT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_roles AS r
            WHERE r.rolname = current_user
              AND r.rolbypassrls
       ) THEN
        RAISE EXCEPTION
            'Apply this migration as the Supabase postgres role with BYPASSRLS; SECURITY DEFINER ownership must remain trusted.';
    END IF;
END;
$owner_guard$;

-- Refuse a second application rather than replacing functions or creating
-- duplicate triggers. This check runs in the same transaction as all DDL.
DO $migration_guard$
BEGIN
    IF to_regprocedure('private.talkspace_increment_conversation_unread()') IS NOT NULL
       OR to_regprocedure('private.talkspace_decrement_seen_conversation_unread()') IS NOT NULL
       OR to_regclass('private.talkspace_unread_count_migration_meta') IS NOT NULL
       OR EXISTS (
            SELECT 1
            FROM pg_catalog.pg_trigger AS t
            WHERE NOT t.tgisinternal
              AND t.tgname IN (
                  'trg_talkspace_message_insert_unread',
                  'trg_talkspace_message_status_seen'
              )
       ) THEN
        RAISE EXCEPTION
            'TalkSpace unread-count migration objects already exist; inspect before applying this migration again.';
    END IF;
END;
$migration_guard$;

-- Create private only when absent, and persist that fact for a safe rollback.
-- If private already exists, rollback removes only this migration's marker.
DO $private_schema_setup$
DECLARE
    v_private_schema_created boolean := false;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_namespace AS n
        WHERE n.nspname = 'private'
    ) THEN
        EXECUTE 'CREATE SCHEMA private';
        v_private_schema_created := true;
    END IF;

    EXECUTE $create_metadata$
        CREATE TABLE private.talkspace_unread_count_migration_meta (
            migration_key text PRIMARY KEY,
            private_schema_created boolean NOT NULL
        )
    $create_metadata$;

    INSERT INTO private.talkspace_unread_count_migration_meta (
        migration_key,
        private_schema_created
    )
    VALUES (
        'unread_count_fix',
        v_private_schema_created
    );
END;
$private_schema_setup$;

REVOKE ALL ON TABLE private.talkspace_unread_count_migration_meta
    FROM PUBLIC, anon, authenticated;

-- Increment the other member's unread row once for each inserted message.
-- SECURITY DEFINER is needed because the recipient's row is protected by RLS.
CREATE FUNCTION private.talkspace_increment_conversation_unread()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_recipient_id uuid;
BEGIN
    -- NULL auth.uid() is never treated as trusted. Authenticated user context
    -- must identify the sender even when the parent INSERT passes RLS.
    IF auth.uid() IS DISTINCT FROM NEW.sender_id THEN
        RAISE EXCEPTION 'Message sender does not match the authenticated user.';
    END IF;

    SELECT CASE
               WHEN c.user_one = NEW.sender_id THEN c.user_two
               ELSE c.user_one
           END
      INTO v_recipient_id
      FROM public.conversations AS c
     WHERE c.id = NEW.conversation_id
       AND NEW.sender_id IN (c.user_one, c.user_two);

    IF NOT FOUND OR v_recipient_id IS NULL THEN
        RAISE EXCEPTION 'Message sender is not a member of its conversation.';
    END IF;

    INSERT INTO public.conversation_unread AS unread (
        conversation_id,
        user_id,
        unread_count,
        updated_at
    )
    VALUES (
        NEW.conversation_id,
        v_recipient_id,
        1,
        pg_catalog.statement_timestamp()
    )
    ON CONFLICT (conversation_id, user_id)
    DO UPDATE SET
        unread_count = GREATEST(unread.unread_count, 0) + 1,
        updated_at = EXCLUDED.updated_at;

    RETURN NEW;
END;
$function$;

-- Decrement only when a recipient first transitions a message to seen.
-- Recipient identity is derived from the message and conversation, never
-- from a client-supplied user ID.
CREATE FUNCTION private.talkspace_decrement_seen_conversation_unread()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_conversation_id uuid;
    v_sender_id uuid;
    v_user_one uuid;
    v_user_two uuid;
    v_recipient_id uuid;
BEGIN
    IF NEW.seen_at IS NULL THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.seen_at IS NOT NULL THEN
        RETURN NEW;
    END IF;

    SELECT m.conversation_id, m.sender_id, c.user_one, c.user_two
      INTO v_conversation_id, v_sender_id, v_user_one, v_user_two
      FROM public.messages AS m
      JOIN public.conversations AS c
        ON c.id = m.conversation_id
     WHERE m.id = NEW.message_id
       AND m.sender_id IN (c.user_one, c.user_two);

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Message status does not reference a valid conversation member.';
    END IF;

    v_recipient_id := CASE
        WHEN v_sender_id = v_user_one THEN v_user_two
        ELSE v_user_one
    END;

    -- A NULL UID fails this comparison, so only the derived recipient can
    -- mark the message seen through an authenticated parent operation.
    IF auth.uid() IS DISTINCT FROM v_recipient_id THEN
        RAISE EXCEPTION 'Only the message recipient may mark it as seen.';
    END IF;

    UPDATE public.conversation_unread AS unread
       SET unread_count = GREATEST(unread.unread_count - 1, 0),
           updated_at = pg_catalog.statement_timestamp()
     WHERE unread.conversation_id = v_conversation_id
       AND unread.user_id = v_recipient_id;

    RETURN NEW;
END;
$function$;

-- Trigger functions are not client-callable RPCs. PostgreSQL requires
-- EXECUTE while the trigger is created; firing an existing trigger does not
-- require granting EXECUTE to each DML caller.
REVOKE ALL ON FUNCTION private.talkspace_increment_conversation_unread()
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.talkspace_decrement_seen_conversation_unread()
    FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_talkspace_message_insert_unread
AFTER INSERT ON public.messages
FOR EACH ROW
EXECUTE FUNCTION private.talkspace_increment_conversation_unread();

CREATE TRIGGER trg_talkspace_message_status_seen
AFTER INSERT OR UPDATE OF seen_at ON public.message_status
FOR EACH ROW
EXECUTE FUNCTION private.talkspace_decrement_seen_conversation_unread();

COMMIT;

-- -------------------------------------------------------------------------
-- ROLLBACK (intentionally commented out; do not run without approval)
-- Run only after confirming this migration is the intended rollback target.
-- -------------------------------------------------------------------------
-- BEGIN;
-- DO $rollback_owner_guard$
-- BEGIN
--     IF current_user <> 'postgres'
--        OR NOT EXISTS (
--             SELECT 1
--             FROM pg_catalog.pg_roles AS r
--             WHERE r.rolname = current_user
--               AND r.rolbypassrls
--        ) THEN
--         RAISE EXCEPTION 'Run rollback as the Supabase postgres role with BYPASSRLS.';
--     END IF;
-- END;
-- $rollback_owner_guard$;
-- DROP TRIGGER IF EXISTS trg_talkspace_message_status_seen
--     ON public.message_status;
-- DROP TRIGGER IF EXISTS trg_talkspace_message_insert_unread
--     ON public.messages;
-- DROP FUNCTION IF EXISTS private.talkspace_decrement_seen_conversation_unread();
-- DROP FUNCTION IF EXISTS private.talkspace_increment_conversation_unread();
-- DO $rollback_private_schema$
-- DECLARE
--     v_private_schema_created boolean;
-- BEGIN
--     SELECT meta.private_schema_created
--       INTO v_private_schema_created
--       FROM private.talkspace_unread_count_migration_meta AS meta
--      WHERE meta.migration_key = 'unread_count_fix';
--
--     IF NOT FOUND THEN
--         RAISE EXCEPTION 'Unread-count migration metadata is missing; inspect before rollback.';
--     END IF;
--
--     DROP TABLE private.talkspace_unread_count_migration_meta;
--
--     IF v_private_schema_created THEN
--         -- RESTRICT drops it only if empty. If unrelated objects were added,
--         -- catch the dependency error and leave the schema and those objects.
--         BEGIN
--             EXECUTE 'DROP SCHEMA private RESTRICT';
--         EXCEPTION
--             WHEN dependent_objects_still_exist THEN
--                 RAISE NOTICE 'private contains other objects; schema left untouched.';
--         END;
--     END IF;
-- END;
-- $rollback_private_schema$;
-- COMMIT;
