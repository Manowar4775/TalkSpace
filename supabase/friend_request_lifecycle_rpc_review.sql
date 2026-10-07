-- REVIEW ONLY — do not apply automatically.
--
-- This draft is based on the manually confirmed live contract supplied by
-- the project owner. Re-check current policies, privileges, role memberships,
-- ownership, triggers, and migration-role capabilities before execution.
-- The transaction aborts if key schema assumptions or a pre-existing
-- executor/RPC would make this draft unsafe to apply as written.

BEGIN;

DO $preflight$
DECLARE
    v_table_oid oid;
    v_id_attnum smallint;
    v_sender_attnum smallint;
    v_receiver_attnum smallint;
BEGIN
    IF current_user <> session_user THEN
        RAISE EXCEPTION
            'Connect directly as the migration role; this draft requires current_user = session_user.';
    END IF;

    v_table_oid := pg_catalog.to_regclass('public.friend_requests');
    IF v_table_oid IS NULL THEN
        RAISE EXCEPTION 'Required table public.friend_requests does not exist.';
    END IF;

    SELECT a.attnum
      INTO v_id_attnum
      FROM pg_catalog.pg_attribute AS a
     WHERE a.attrelid = v_table_oid
       AND a.attname = 'id'
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND a.atttypid = 'pg_catalog.uuid'::pg_catalog.regtype
       AND a.attnotnull;
    IF NOT FOUND THEN
        RAISE EXCEPTION
            'friend_requests.id must exist, be UUID, and be NOT NULL.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_constraint AS c
         WHERE c.conrelid = v_table_oid
           AND c.contype IN ('p', 'u')
           AND c.conkey = ARRAY[v_id_attnum]::smallint[]
    ) THEN
        RAISE EXCEPTION
            'friend_requests.id must have a single-column PRIMARY KEY or UNIQUE constraint.';
    END IF;

    SELECT a.attnum
      INTO v_sender_attnum
      FROM pg_catalog.pg_attribute AS a
     WHERE a.attrelid = v_table_oid
       AND a.attname = 'sender_id'
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND a.atttypid = 'pg_catalog.uuid'::pg_catalog.regtype
       AND a.attnotnull;
    IF NOT FOUND THEN
        RAISE EXCEPTION
            'friend_requests.sender_id must exist, be UUID, and be NOT NULL.';
    END IF;

    SELECT a.attnum
      INTO v_receiver_attnum
      FROM pg_catalog.pg_attribute AS a
     WHERE a.attrelid = v_table_oid
       AND a.attname = 'receiver_id'
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND a.atttypid = 'pg_catalog.uuid'::pg_catalog.regtype
       AND a.attnotnull;
    IF NOT FOUND THEN
        RAISE EXCEPTION
            'friend_requests.receiver_id must exist, be UUID, and be NOT NULL.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_attribute AS a
         WHERE a.attrelid = v_table_oid
           AND a.attname = 'status'
           AND a.attnum > 0
           AND NOT a.attisdropped
           AND a.atttypid = 'pg_catalog.text'::pg_catalog.regtype
           AND a.attnotnull
    ) THEN
        RAISE EXCEPTION
            'friend_requests.status must exist, be text, and be NOT NULL.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_constraint AS c
         WHERE c.conrelid = v_table_oid
           AND c.contype = 'u'
           AND c.conkey = ARRAY[v_sender_attnum, v_receiver_attnum]::smallint[]
    ) THEN
        RAISE EXCEPTION
            'Expected UNIQUE(sender_id, receiver_id) constraint was not found.';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
         WHERE rolname = 'talkspace_friend_request_executor'
    ) THEN
        RAISE EXCEPTION
            'Role talkspace_friend_request_executor already exists; inspect it before proceeding.';
    END IF;

    IF pg_catalog.to_regprocedure(
        'public.talkspace_friend_request_transition_v1(text,text)'
    ) IS NOT NULL THEN
        RAISE EXCEPTION
            'RPC already exists; inspect its owner, definition, and ACL before proceeding.';
    END IF;
END;
$preflight$;

CREATE ROLE talkspace_friend_request_executor
    NOLOGIN
    NOSUPERUSER
    NOCREATEDB
    NOCREATEROLE
    NOINHERIT
    NOBYPASSRLS;

ALTER TABLE public.friend_requests ENABLE ROW LEVEL SECURITY;

-- Replace the known participant SELECT policy, and guard against any other
-- permissive SELECT policy broadening authenticated visibility.
DROP POLICY IF EXISTS friend_requests_select
    ON public.friend_requests;
CREATE POLICY friend_requests_select
    ON public.friend_requests
    AS PERMISSIVE
    FOR SELECT
    TO authenticated
    USING (sender_id = auth.uid() OR receiver_id = auth.uid());

CREATE POLICY friend_requests_select_guard
    ON public.friend_requests
    AS RESTRICTIVE
    FOR SELECT
    TO authenticated
    USING (sender_id = auth.uid() OR receiver_id = auth.uid());

-- No unauthenticated row access, even if another permissive policy applies.
CREATE POLICY friend_requests_deny_anon_select
    ON public.friend_requests
    AS RESTRICTIVE
    FOR SELECT
    TO anon
    USING (false);

-- New requests remain direct INSERTs, but only as the authenticated sender,
-- to another user, and with the initial pending state.
DROP POLICY IF EXISTS friend_requests_insert
    ON public.friend_requests;
CREATE POLICY friend_requests_insert
    ON public.friend_requests
    AS PERMISSIVE
    FOR INSERT
    TO authenticated
    WITH CHECK (
        sender_id = auth.uid()
        AND receiver_id <> auth.uid()
        AND status = 'pending'
    );

CREATE POLICY friend_requests_insert_guard
    ON public.friend_requests
    AS RESTRICTIVE
    FOR INSERT
    TO authenticated
    WITH CHECK (
        sender_id = auth.uid()
        AND receiver_id <> auth.uid()
        AND status = 'pending'
    );

CREATE POLICY friend_requests_deny_anon_insert
    ON public.friend_requests
    AS RESTRICTIVE
    FOR INSERT
    TO anon
    WITH CHECK (false);

-- The executor receives participant-only row access. Restrictive guards make
-- other permissive policies unable to broaden its SELECT or UPDATE boundary.
CREATE POLICY friend_requests_executor_select
    ON public.friend_requests
    AS PERMISSIVE
    FOR SELECT
    TO talkspace_friend_request_executor
    USING (sender_id = auth.uid() OR receiver_id = auth.uid());

CREATE POLICY friend_requests_executor_select_guard
    ON public.friend_requests
    AS RESTRICTIVE
    FOR SELECT
    TO talkspace_friend_request_executor
    USING (sender_id = auth.uid() OR receiver_id = auth.uid());

DROP POLICY IF EXISTS friend_requests_update
    ON public.friend_requests;
CREATE POLICY friend_requests_executor_update
    ON public.friend_requests
    AS PERMISSIVE
    FOR UPDATE
    TO talkspace_friend_request_executor
    USING (sender_id = auth.uid() OR receiver_id = auth.uid())
    WITH CHECK (sender_id = auth.uid() OR receiver_id = auth.uid());

CREATE POLICY friend_requests_executor_update_guard
    ON public.friend_requests
    AS RESTRICTIVE
    FOR UPDATE
    TO talkspace_friend_request_executor
    USING (sender_id = auth.uid() OR receiver_id = auth.uid())
    WITH CHECK (sender_id = auth.uid() OR receiver_id = auth.uid());

-- Deny direct authenticated UPDATE/DELETE even if a permissive policy is
-- added later. Remove the known broad DELETE policy as well.
CREATE POLICY friend_requests_deny_authenticated_update
    ON public.friend_requests
    AS RESTRICTIVE
    FOR UPDATE
    TO authenticated
    USING (false)
    WITH CHECK (false);

DROP POLICY IF EXISTS friend_requests_delete
    ON public.friend_requests;
CREATE POLICY friend_requests_deny_authenticated_delete
    ON public.friend_requests
    AS RESTRICTIVE
    FOR DELETE
    TO authenticated
    USING (false);

CREATE POLICY friend_requests_deny_anon_update
    ON public.friend_requests
    AS RESTRICTIVE
    FOR UPDATE
    TO anon
    USING (false)
    WITH CHECK (false);

CREATE POLICY friend_requests_deny_anon_delete
    ON public.friend_requests
    AS RESTRICTIVE
    FOR DELETE
    TO anon
    USING (false);

-- Remove table- and column-level client mutation/read grants that could
-- bypass the intended API surface. Authenticated SELECT/INSERT are restored
-- below; RLS still limits those operations.
REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE
    ON TABLE public.friend_requests
    FROM PUBLIC, anon, authenticated;

REVOKE SELECT (id, sender_id, receiver_id, status, created_at),
       INSERT (id, sender_id, receiver_id, status, created_at),
       UPDATE (id, sender_id, receiver_id, status, created_at)
    ON TABLE public.friend_requests
    FROM PUBLIC, anon, authenticated;

REVOKE UPDATE (id, sender_id, receiver_id, status, created_at)
    ON TABLE public.friend_requests
    FROM authenticated;

GRANT SELECT
    ON TABLE public.friend_requests
    TO authenticated;
GRANT INSERT (sender_id, receiver_id)
    ON TABLE public.friend_requests
    TO authenticated;

GRANT USAGE ON SCHEMA public, auth
    TO talkspace_friend_request_executor;
GRANT CREATE ON SCHEMA public
    TO talkspace_friend_request_executor;
GRANT EXECUTE ON FUNCTION auth.uid()
    TO talkspace_friend_request_executor;
GRANT USAGE ON LANGUAGE plpgsql
    TO talkspace_friend_request_executor;
GRANT SELECT (id, sender_id, receiver_id, status)
    ON TABLE public.friend_requests
    TO talkspace_friend_request_executor;
GRANT UPDATE (status)
    ON TABLE public.friend_requests
    TO talkspace_friend_request_executor;

-- Temporary membership lets the migration session SET ROLE to the executor
-- so the SECURITY DEFINER function is created with the intended owner.
GRANT talkspace_friend_request_executor TO CURRENT_USER;
SET ROLE talkspace_friend_request_executor;

CREATE FUNCTION public.talkspace_friend_request_transition_v1(
    p_request_id text,
    p_action text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_actor uuid := auth.uid();
    v_request_id uuid;
    v_sender_id uuid;
    v_receiver_id uuid;
    v_peer_id uuid;
    v_pair_key text;
    v_status text;
    v_expected_status text;
    v_new_status text;
    v_locked_id uuid;
    v_locked_status text;
    v_target_locked_accepted boolean := false;
    v_target_updated boolean := false;
    v_row jsonb;
    v_rows jsonb := '[]'::jsonb;
BEGIN
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'Authentication required.'
            USING ERRCODE = '28000';
    END IF;

    IF p_request_id IS NULL OR pg_catalog.btrim(p_request_id) = '' THEN
        RAISE EXCEPTION 'A request ID is required.'
            USING ERRCODE = '22023';
    END IF;

    BEGIN
        v_request_id := p_request_id::uuid;
    EXCEPTION
        WHEN invalid_text_representation THEN
            RAISE EXCEPTION 'Invalid request ID.'
                USING ERRCODE = '22023';
    END;

    IF p_action IS NULL
       OR p_action NOT IN ('accept', 'reject', 'remove', 'reactivate') THEN
        RAISE EXCEPTION 'Unsupported friend-request action.'
            USING ERRCODE = '22023';
    END IF;

    -- Initial unlocked lookup derives the pair-lock key. Authorization and
    -- status are re-read only after the row lock below.
    SELECT fr.sender_id, fr.receiver_id
      INTO v_sender_id, v_receiver_id
      FROM public.friend_requests AS fr
     WHERE fr.id = v_request_id;
    IF NOT FOUND
       OR (v_sender_id <> v_actor AND v_receiver_id <> v_actor) THEN
        RAISE EXCEPTION 'Friend-request transition not permitted.'
            USING ERRCODE = '42501';
    END IF;

    -- Serialize lifecycle RPCs for this pair before taking row locks. This
    -- avoids opposite-anchor remove calls locking the pair in different
    -- orders. Hash collisions only serialize unrelated pairs.
    IF v_sender_id < v_receiver_id THEN
        v_pair_key := v_sender_id::text || ':' || v_receiver_id::text;
    ELSE
        v_pair_key := v_receiver_id::text || ':' || v_sender_id::text;
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(v_pair_key, 0)
    );

    -- Lock and re-read the anchor first; never trust the initial unlocked
    -- status or participant values for transition authorization.
    SELECT fr.sender_id, fr.receiver_id, fr.status
      INTO v_sender_id, v_receiver_id, v_status
      FROM public.friend_requests AS fr
     WHERE fr.id = v_request_id
       FOR UPDATE;
    IF NOT FOUND
       OR (v_sender_id <> v_actor AND v_receiver_id <> v_actor) THEN
        RAISE EXCEPTION 'Friend-request transition not permitted.'
            USING ERRCODE = '42501';
    END IF;

    IF p_action = 'remove' THEN
        IF v_status IS DISTINCT FROM 'accepted' THEN
            RAISE EXCEPTION 'Friend-request transition not permitted.'
                USING ERRCODE = '42501';
        END IF;

        v_peer_id := CASE
            WHEN v_sender_id = v_actor THEN v_receiver_id
            ELSE v_sender_id
        END;

        -- Lock ALL directional rows for this pair in deterministic UUID
        -- order. Non-accepted rows are locked but never changed.
        FOR v_locked_id, v_locked_status IN
            SELECT fr.id, fr.status
              FROM public.friend_requests AS fr
             WHERE (
                       (fr.sender_id = v_actor AND fr.receiver_id = v_peer_id)
                    OR (fr.sender_id = v_peer_id AND fr.receiver_id = v_actor)
                   )
             ORDER BY fr.id
             FOR UPDATE
        LOOP
            IF v_locked_id = v_request_id
               AND v_locked_status = 'accepted' THEN
                v_target_locked_accepted := true;
            END IF;

            IF v_locked_status = 'accepted' THEN
                UPDATE public.friend_requests AS fr
                   SET status = 'rejected'
                 WHERE fr.id = v_locked_id
                   AND (
                           (fr.sender_id = v_actor AND fr.receiver_id = v_peer_id)
                        OR (fr.sender_id = v_peer_id AND fr.receiver_id = v_actor)
                       )
                   AND fr.status = 'accepted'
                RETURNING pg_catalog.jsonb_build_object(
                    'request_id', fr.id,
                    'sender_id', fr.sender_id,
                    'receiver_id', fr.receiver_id,
                    'status', fr.status
                )
                     INTO v_row;

                IF NOT FOUND THEN
                    RAISE EXCEPTION 'Friend-request transition not permitted.'
                        USING ERRCODE = '42501';
                END IF;

                IF v_locked_id = v_request_id THEN
                    v_target_updated := true;
                END IF;
                v_rows := v_rows || pg_catalog.jsonb_build_array(v_row);
            END IF;
        END LOOP;

        IF NOT v_target_locked_accepted
           OR NOT v_target_updated
           OR pg_catalog.jsonb_array_length(v_rows) = 0 THEN
            RAISE EXCEPTION 'Friend-request transition not permitted.'
                USING ERRCODE = '42501';
        END IF;

    ELSE
        IF p_action = 'accept' THEN
            IF v_status IS DISTINCT FROM 'pending'
               OR v_receiver_id <> v_actor THEN
                RAISE EXCEPTION 'Friend-request transition not permitted.'
                    USING ERRCODE = '42501';
            END IF;
            v_expected_status := 'pending';
            v_new_status := 'accepted';

        ELSIF p_action = 'reject' THEN
            IF v_status IS DISTINCT FROM 'pending'
               OR v_receiver_id <> v_actor THEN
                RAISE EXCEPTION 'Friend-request transition not permitted.'
                    USING ERRCODE = '42501';
            END IF;
            v_expected_status := 'pending';
            v_new_status := 'rejected';

        ELSIF p_action = 'reactivate' THEN
            IF v_status IS DISTINCT FROM 'rejected'
               OR v_sender_id <> v_actor THEN
                RAISE EXCEPTION 'Friend-request transition not permitted.'
                    USING ERRCODE = '42501';
            END IF;
            v_expected_status := 'rejected';
            v_new_status := 'pending';
        END IF;

        UPDATE public.friend_requests AS fr
           SET status = v_new_status
         WHERE fr.id = v_request_id
           AND fr.status = v_expected_status
        RETURNING pg_catalog.jsonb_build_object(
            'request_id', fr.id,
            'sender_id', fr.sender_id,
            'receiver_id', fr.receiver_id,
            'status', fr.status
        )
             INTO v_row;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Friend-request transition not permitted.'
                USING ERRCODE = '42501';
        END IF;
        v_rows := pg_catalog.jsonb_build_array(v_row);
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'action', p_action,
        'rows', v_rows
    );
END;
$function$;

-- The executor owns the function and is its only SECURITY DEFINER context.
REVOKE ALL
    ON FUNCTION public.talkspace_friend_request_transition_v1(text, text)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE
    ON FUNCTION public.talkspace_friend_request_transition_v1(text, text)
    TO authenticated;

RESET ROLE;
REVOKE talkspace_friend_request_executor FROM CURRENT_USER;

REVOKE CREATE ON SCHEMA public
    FROM talkspace_friend_request_executor;
REVOKE USAGE ON LANGUAGE plpgsql
    FROM talkspace_friend_request_executor;

COMMIT;
