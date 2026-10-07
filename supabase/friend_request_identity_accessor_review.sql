-- REVIEW ONLY — do not execute automatically.
--
-- Replaces the executor's direct auth.uid() dependency with a narrowly scoped
-- postgres-owned accessor. The lifecycle RPC body below is copied from
-- friend_request_lifecycle_rpc_review.sql; its only behavioral-source change
-- is v_actor := public.talkspace_request_identity_v1().
--
-- This script requires a migration session running as postgres and authority
-- to create a function in public and alter public.friend_requests policies.
-- CREATEROLE/role-admin authority is needed only if postgres is not already a
-- member of the executor role. It deliberately does not grant auth schema use.

BEGIN;

-- Keep the original privilege state for this transaction so temporary access
-- can be restored without removing grants that predate this migration.
CREATE TEMP TABLE talkspace_identity_accessor_privilege_state (
    postgres_was_executor_member boolean NOT NULL,
    original_admin_option boolean,
    original_inherit_option boolean,
    original_set_option boolean,
    executor_had_public_create boolean NOT NULL
) ON COMMIT DROP;

DO $preflight$
DECLARE
    v_executor_oid oid;
    v_rpc_oid oid;
    v_public_owner oid;
    v_table_owner oid;
    v_rpc_definition text;
BEGIN
    IF current_user <> 'postgres' OR session_user <> 'postgres'
       OR current_user <> session_user THEN
        RAISE EXCEPTION
            'Connect directly as postgres; this migration requires current_user = session_user = postgres.';
    END IF;

    SELECT r.oid
      INTO v_executor_oid
      FROM pg_catalog.pg_roles AS r
     WHERE r.rolname = 'talkspace_friend_request_executor'
       AND NOT r.rolcanlogin
       AND NOT r.rolinherit
       AND NOT r.rolbypassrls
       AND NOT r.rolsuper
       AND NOT r.rolcreatedb
       AND NOT r.rolcreaterole;
    IF v_executor_oid IS NULL THEN
        RAISE EXCEPTION
            'Expected NOLOGIN, NOINHERIT, NOBYPASSRLS executor role was not found.';
    END IF;

    v_rpc_oid := pg_catalog.to_regprocedure(
        'public.talkspace_friend_request_transition_v1(text,text)'
    );
    IF v_rpc_oid IS NULL THEN
        RAISE EXCEPTION 'Expected lifecycle RPC was not found.';
    END IF;

    SELECT pg_catalog.pg_get_functiondef(v_rpc_oid)
      INTO v_rpc_definition;
    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_proc AS p
         WHERE p.oid = v_rpc_oid
           AND p.proowner = v_executor_oid
           AND p.prosecdef
           AND p.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
           AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']
    ) OR pg_catalog.strpos(
            pg_catalog.lower(v_rpc_definition),
            'v_actor uuid := auth.uid()'
        ) = 0 THEN
        RAISE EXCEPTION
            'RPC owner, SECURITY DEFINER settings, return type, search_path, or expected actor expression differs from the reviewed definition.';
    END IF;

    IF pg_catalog.to_regprocedure(
        'public.talkspace_request_identity_v1()'
    ) IS NOT NULL THEN
        RAISE EXCEPTION
            'Identity accessor already exists; inspect its owner, body, and ACL before proceeding.';
    END IF;

    IF NOT pg_catalog.has_schema_privilege(current_user, 'auth', 'USAGE')
       OR NOT pg_catalog.has_function_privilege(
           current_user,
           'auth.uid()',
           'EXECUTE'
       ) THEN
        RAISE EXCEPTION
            'postgres must retain its verified USAGE on auth and EXECUTE on auth.uid().';
    END IF;

    IF pg_catalog.has_schema_privilege(
           v_executor_oid,
           'auth',
           'USAGE'
       ) OR NOT pg_catalog.has_function_privilege(
           v_executor_oid,
           'auth.uid()',
           'EXECUTE'
       ) THEN
        RAISE EXCEPTION
            'Live executor privileges differ from the reported condition; re-audit before proceeding.';
    END IF;

    IF pg_catalog.to_regclass('public.friend_requests') IS NULL THEN
        RAISE EXCEPTION 'public.friend_requests was not found.';
    END IF;

    SELECT n.nspowner
      INTO v_public_owner
      FROM pg_catalog.pg_namespace AS n
     WHERE n.nspname = 'public';

    SELECT c.relowner
      INTO v_table_owner
      FROM pg_catalog.pg_class AS c
     WHERE c.oid = 'public.friend_requests'::pg_catalog.regclass;

    IF NOT (
        current_user::pg_catalog.regrole::oid = v_public_owner
        OR pg_catalog.pg_has_role(current_user, v_public_owner, 'MEMBER')
    ) THEN
        RAISE EXCEPTION
            'postgres is not the public schema owner or a member of its owner role; cannot safely grant temporary CREATE.';
    END IF;

    IF NOT (
        current_user::pg_catalog.regrole::oid = v_table_owner
        OR pg_catalog.pg_has_role(current_user, v_table_owner, 'MEMBER')
    ) THEN
        RAISE EXCEPTION
            'postgres is not the friend_requests table owner or a member of its owner role; cannot safely alter executor policies.';
    END IF;

    INSERT INTO pg_temp.talkspace_identity_accessor_privilege_state (
        postgres_was_executor_member,
        original_admin_option,
        original_inherit_option,
        original_set_option,
        executor_had_public_create
    )
    VALUES (
        EXISTS (
            SELECT 1
              FROM pg_catalog.pg_auth_members AS m
             WHERE m.roleid = v_executor_oid
               AND m.member = current_user::pg_catalog.regrole::oid
        ),
        (
            SELECT m.admin_option
              FROM pg_catalog.pg_auth_members AS m
             WHERE m.roleid = v_executor_oid
               AND m.member = current_user::pg_catalog.regrole::oid
        ),
        (
            SELECT m.inherit_option
              FROM pg_catalog.pg_auth_members AS m
             WHERE m.roleid = v_executor_oid
               AND m.member = current_user::pg_catalog.regrole::oid
        ),
        (
            SELECT m.set_option
              FROM pg_catalog.pg_auth_members AS m
             WHERE m.roleid = v_executor_oid
               AND m.member = current_user::pg_catalog.regrole::oid
        ),
        pg_catalog.has_schema_privilege(v_executor_oid, 'public', 'CREATE')
    );

    IF NOT (SELECT postgres_was_executor_member
              FROM pg_temp.talkspace_identity_accessor_privilege_state)
       AND NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_roles AS r
         WHERE r.rolname = current_user
           AND r.rolcreaterole
    ) THEN
        RAISE EXCEPTION
            'postgres lacks CREATEROLE required for the temporary executor membership.';
    END IF;

    IF (SELECT postgres_was_executor_member
          FROM pg_temp.talkspace_identity_accessor_privilege_state)
       AND NOT (SELECT original_set_option
                  FROM pg_temp.talkspace_identity_accessor_privilege_state)
       AND NOT (SELECT original_admin_option
                  FROM pg_temp.talkspace_identity_accessor_privilege_state) THEN
        RAISE EXCEPTION
            'postgres lacks ADMIN OPTION required to temporarily enable SET on its existing executor membership.';
    END IF;

    IF (
        SELECT pg_catalog.count(*)
          FROM pg_catalog.pg_policy AS p
         WHERE p.polrelid = 'public.friend_requests'::pg_catalog.regclass
           AND p.polname IN (
               'friend_requests_executor_select',
               'friend_requests_executor_select_guard',
               'friend_requests_executor_update',
               'friend_requests_executor_update_guard'
           )
    ) <> 4 THEN
        RAISE EXCEPTION
            'Expected four executor lifecycle policies; inspect policy inventory before proceeding.';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_policy AS p
         WHERE p.polrelid = 'public.friend_requests'::pg_catalog.regclass
           AND p.polname IN (
               'friend_requests_executor_select',
               'friend_requests_executor_select_guard',
               'friend_requests_executor_update',
               'friend_requests_executor_update_guard'
           )
           AND (
               p.polroles <> ARRAY[v_executor_oid]::oid[]
               OR pg_catalog.strpos(
                   pg_catalog.lower(
                       COALESCE(
                           pg_catalog.pg_get_expr(p.polqual, p.polrelid),
                           ''
                       )
                   ),
                   'auth.uid()'
               ) = 0
               OR (
                   p.polname IN (
                       'friend_requests_executor_select',
                       'friend_requests_executor_update'
                   ) AND NOT p.polpermissive
               )
               OR (
                   p.polname IN (
                       'friend_requests_executor_select_guard',
                       'friend_requests_executor_update_guard'
                   ) AND p.polpermissive
               )
               OR (
                   p.polname IN (
                       'friend_requests_executor_select',
                       'friend_requests_executor_select_guard'
                   ) AND p.polcmd <> 'r'
               )
               OR (
                   p.polname IN (
                       'friend_requests_executor_update',
                       'friend_requests_executor_update_guard'
                   ) AND (
                       p.polcmd <> 'w'
                       OR pg_catalog.strpos(
                           pg_catalog.lower(
                               COALESCE(
                                   pg_catalog.pg_get_expr(
                                       p.polwithcheck,
                                       p.polrelid
                                   ),
                                   ''
                               )
                           ),
                           'auth.uid()'
                       ) = 0
                   )
               )
           )
    ) THEN
        RAISE EXCEPTION
            'An executor lifecycle policy differs from the expected participant-only definition.';
    END IF;

    IF (
        SELECT pg_catalog.count(*)
          FROM pg_catalog.pg_policy AS p
         WHERE p.polrelid = 'public.friend_requests'::pg_catalog.regclass
           AND p.polname IN (
               'friend_requests_deny_authenticated_update',
               'friend_requests_deny_authenticated_delete'
           )
    ) <> 2 OR EXISTS (
        SELECT 1
          FROM pg_catalog.pg_policy AS p
         WHERE p.polrelid = 'public.friend_requests'::pg_catalog.regclass
           AND p.polname IN (
               'friend_requests_deny_authenticated_update',
               'friend_requests_deny_authenticated_delete'
           )
           AND (
               p.polroles <> ARRAY[
                   (SELECT r.oid FROM pg_catalog.pg_roles AS r
                     WHERE r.rolname = 'authenticated')
               ]::oid[]
               OR p.polpermissive
               OR pg_catalog.btrim(
                   pg_catalog.pg_get_expr(p.polqual, p.polrelid)
               ) <> 'false'
               OR (
                   p.polname = 'friend_requests_deny_authenticated_update'
                   AND (
                       p.polcmd <> 'w'
                       OR pg_catalog.btrim(
                           pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)
                       ) <> 'false'
                   )
               )
               OR (
                   p.polname = 'friend_requests_deny_authenticated_delete'
                   AND p.polcmd <> 'd'
               )
           )
    ) THEN
        RAISE EXCEPTION
            'Existing restrictive authenticated UPDATE/DELETE denial policies are missing or differ from the reviewed definitions.';
    END IF;

    IF pg_catalog.has_table_privilege(
           'authenticated',
           'public.friend_requests',
           'UPDATE'
       ) OR pg_catalog.has_any_column_privilege(
           'authenticated',
           'public.friend_requests',
           'UPDATE'
       ) OR pg_catalog.has_table_privilege(
           'authenticated',
           'public.friend_requests',
           'DELETE'
       ) THEN
        RAISE EXCEPTION
            'Authenticated has direct friend_requests mutation privileges; inspect grants before proceeding.';
    END IF;
END;
$preflight$;

-- Created as postgres. The function returns only the identity attached to
-- this database request; it takes no caller-supplied identity or other input.
CREATE FUNCTION public.talkspace_request_identity_v1()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
    SELECT auth.uid()
$function$;

REVOKE ALL
    ON FUNCTION public.talkspace_request_identity_v1()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE
    ON FUNCTION public.talkspace_request_identity_v1()
    TO talkspace_friend_request_executor;

-- Change only the identity function called by the executor policies. The
-- participant predicates and permissive/restrictive policy modes are retained.
ALTER POLICY friend_requests_executor_select
    ON public.friend_requests
    USING (
        sender_id = public.talkspace_request_identity_v1()
        OR receiver_id = public.talkspace_request_identity_v1()
    );

ALTER POLICY friend_requests_executor_select_guard
    ON public.friend_requests
    USING (
        sender_id = public.talkspace_request_identity_v1()
        OR receiver_id = public.talkspace_request_identity_v1()
    );

ALTER POLICY friend_requests_executor_update
    ON public.friend_requests
    USING (
        sender_id = public.talkspace_request_identity_v1()
        OR receiver_id = public.talkspace_request_identity_v1()
    )
    WITH CHECK (
        sender_id = public.talkspace_request_identity_v1()
        OR receiver_id = public.talkspace_request_identity_v1()
    );

ALTER POLICY friend_requests_executor_update_guard
    ON public.friend_requests
    USING (
        sender_id = public.talkspace_request_identity_v1()
        OR receiver_id = public.talkspace_request_identity_v1()
    )
    WITH CHECK (
        sender_id = public.talkspace_request_identity_v1()
        OR receiver_id = public.talkspace_request_identity_v1()
    );

-- Add only the temporary privileges that were absent at entry. In particular,
-- preserve a pre-existing postgres membership in the executor role.
DO $temporary_privileges$
DECLARE
    v_was_member boolean;
    v_admin_option boolean;
    v_inherit_option boolean;
    v_set_option boolean;
BEGIN
    SELECT postgres_was_executor_member,
           original_admin_option,
           original_inherit_option,
           original_set_option
      INTO v_was_member, v_admin_option, v_inherit_option, v_set_option
      FROM pg_temp.talkspace_identity_accessor_privilege_state;

    IF NOT (SELECT executor_had_public_create
              FROM pg_temp.talkspace_identity_accessor_privilege_state) THEN
        EXECUTE 'GRANT CREATE ON SCHEMA public TO talkspace_friend_request_executor';
    END IF;

    IF v_was_member AND NOT v_set_option THEN
        -- Omitting ADMIN and INHERIT retains their current values.
        EXECUTE 'GRANT talkspace_friend_request_executor TO CURRENT_USER WITH SET TRUE';
    ELSIF NOT v_was_member THEN
        EXECUTE 'GRANT talkspace_friend_request_executor TO CURRENT_USER WITH ADMIN FALSE, INHERIT FALSE, SET TRUE';
    END IF;
END;
$temporary_privileges$;
SET ROLE talkspace_friend_request_executor;

CREATE OR REPLACE FUNCTION public.talkspace_friend_request_transition_v1(
    p_request_id text,
    p_action text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    v_actor uuid := public.talkspace_request_identity_v1();
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

RESET ROLE;
DO $restore_privileges$
DECLARE
    v_was_member boolean;
    v_admin_option boolean;
    v_inherit_option boolean;
    v_set_option boolean;
BEGIN
    SELECT postgres_was_executor_member,
           original_admin_option,
           original_inherit_option,
           original_set_option
      INTO v_was_member, v_admin_option, v_inherit_option, v_set_option
      FROM pg_temp.talkspace_identity_accessor_privilege_state;

    IF NOT (SELECT executor_had_public_create
              FROM pg_temp.talkspace_identity_accessor_privilege_state) THEN
        EXECUTE 'REVOKE CREATE ON SCHEMA public FROM talkspace_friend_request_executor';
    END IF;

    IF v_was_member AND NOT v_set_option THEN
        -- Restore only SET; the original ADMIN and INHERIT values were never changed.
        EXECUTE 'GRANT talkspace_friend_request_executor TO CURRENT_USER WITH SET FALSE';
    ELSIF NOT v_was_member THEN
        EXECUTE 'REVOKE talkspace_friend_request_executor FROM CURRENT_USER';
    END IF;
END;
$restore_privileges$;

DO $postflight$
DECLARE
    v_executor_oid oid;
    v_helper_oid oid;
    v_rpc_oid oid;
BEGIN
    SELECT r.oid INTO v_executor_oid
      FROM pg_catalog.pg_roles AS r
     WHERE r.rolname = 'talkspace_friend_request_executor';
    v_helper_oid := pg_catalog.to_regprocedure(
        'public.talkspace_request_identity_v1()'
    );
    v_rpc_oid := pg_catalog.to_regprocedure(
        'public.talkspace_friend_request_transition_v1(text,text)'
    );

    IF v_helper_oid IS NULL OR NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_proc AS p
         WHERE p.oid = v_helper_oid
           AND p.proowner = 'postgres'::pg_catalog.regrole
           AND p.prosecdef
           AND p.provolatile = 's'
           AND p.prorettype = 'pg_catalog.uuid'::pg_catalog.regtype
           AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']
           AND pg_catalog.btrim(p.prosrc, E' \t\n\r\f') = 'SELECT auth.uid()'
    ) THEN
        RAISE EXCEPTION
            'Identity accessor definition, owner, volatility, or search_path is not as expected.';
    END IF;

    IF NOT pg_catalog.has_function_privilege(
           v_executor_oid,
           v_helper_oid,
           'EXECUTE'
       ) OR pg_catalog.has_function_privilege(
           'anon', v_helper_oid, 'EXECUTE'
       ) OR pg_catalog.has_function_privilege(
           'authenticated', v_helper_oid, 'EXECUTE'
       ) OR pg_catalog.has_function_privilege(
           'service_role', v_helper_oid, 'EXECUTE'
       ) OR EXISTS (
           SELECT 1
             FROM pg_catalog.pg_proc AS p,
                  LATERAL pg_catalog.aclexplode(
                      COALESCE(
                          p.proacl,
                          pg_catalog.acldefault('f', p.proowner)
                      )
                  ) AS acl
            WHERE p.oid = v_helper_oid
              AND acl.grantee = 0
              AND acl.privilege_type = 'EXECUTE'
       ) THEN
        RAISE EXCEPTION
            'Identity accessor EXECUTE grants are broader than the executor-only design.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_proc AS p
         WHERE p.oid = v_rpc_oid
           AND p.proowner = v_executor_oid
           AND p.prosecdef
           AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']
           AND pg_catalog.strpos(
               pg_catalog.lower(pg_catalog.pg_get_functiondef(p.oid)),
               'public.talkspace_request_identity_v1()'
           ) > 0
           AND pg_catalog.strpos(
               pg_catalog.lower(pg_catalog.pg_get_functiondef(p.oid)),
               'auth.uid()'
           ) = 0
    ) THEN
        RAISE EXCEPTION
            'Lifecycle RPC ownership/settings or identity-accessor reference is incorrect.';
    END IF;

    IF pg_catalog.has_schema_privilege(
           v_executor_oid,
           'auth',
           'USAGE'
       ) OR pg_catalog.has_schema_privilege(
           v_executor_oid,
           'public',
           'CREATE'
       ) IS DISTINCT FROM (
           SELECT executor_had_public_create
             FROM pg_temp.talkspace_identity_accessor_privilege_state
       ) OR EXISTS (
           SELECT 1
             FROM pg_catalog.pg_auth_members AS m
            WHERE m.roleid = v_executor_oid
              AND m.member = current_user::pg_catalog.regrole::oid
       ) IS DISTINCT FROM (
           SELECT postgres_was_executor_member
             FROM pg_temp.talkspace_identity_accessor_privilege_state
       ) OR EXISTS (
           SELECT 1
             FROM pg_catalog.pg_auth_members AS m
            WHERE m.roleid = v_executor_oid
              AND m.member = current_user::pg_catalog.regrole::oid
              AND (
                  m.admin_option IS DISTINCT FROM (
                      SELECT original_admin_option
                        FROM pg_temp.talkspace_identity_accessor_privilege_state
                  )
                  OR m.inherit_option IS DISTINCT FROM (
                      SELECT original_inherit_option
                        FROM pg_temp.talkspace_identity_accessor_privilege_state
                  )
                  OR m.set_option IS DISTINCT FROM (
                      SELECT original_set_option
                        FROM pg_temp.talkspace_identity_accessor_privilege_state
                  )
              )
       ) OR pg_catalog.has_table_privilege(
           v_executor_oid,
           'auth.users',
           'SELECT'
       ) THEN
        RAISE EXCEPTION
            'Executor unexpectedly retains auth USAGE, public CREATE, postgres membership, or auth.users SELECT.';
    END IF;

    IF pg_catalog.has_table_privilege(
           'authenticated',
           'public.friend_requests',
           'UPDATE'
       ) OR pg_catalog.has_any_column_privilege(
           'authenticated',
           'public.friend_requests',
           'UPDATE'
       ) OR pg_catalog.has_table_privilege(
           'authenticated',
           'public.friend_requests',
           'DELETE'
       ) THEN
        RAISE EXCEPTION
            'Authenticated unexpectedly has direct friend_requests mutation privileges.';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_policy AS p
         WHERE p.polrelid = 'public.friend_requests'::pg_catalog.regclass
           AND p.polname IN (
               'friend_requests_executor_select',
               'friend_requests_executor_select_guard',
               'friend_requests_executor_update',
               'friend_requests_executor_update_guard'
           )
           AND pg_catalog.strpos(
               pg_catalog.lower(
                   COALESCE(
                       pg_catalog.pg_get_expr(p.polqual, p.polrelid),
                       ''
                   )
                   || COALESCE(
                       pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid),
                       ''
                   )
               ),
               'auth.uid()'
           ) > 0
    ) THEN
        RAISE EXCEPTION
            'A direct auth.uid() reference remains in an executor lifecycle policy.';
    END IF;
END;
$postflight$;

COMMIT;
